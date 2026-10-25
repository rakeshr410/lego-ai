import { readAnchor, type NoteAnchor } from '../anchor';
import { sanitizeNoteHtml } from './note-html';
import { serverFetch, StrapiError } from './strapi-server';
import t from '../../i18n/messages/api';

// Ask threads: a reader's notes on a topic page. Each thread holds its questions and answers,
// the passage it is anchored to (P2-13), where it's parked on the page, and the reader's edited
// version of it. Every query here is
// scoped to one reader; readers never reach Strapi directly.

export type AskNote = {
  id: string;
  passage: string | null;
  question: string;
  answer: string;
  createdAt: string;
};

export type AskThread = {
  id: string;
  /**
   * The passage the note belongs to: its block's key and a quote of it (lib/anchor.ts), with the
   * note's offset from it. Null for notes saved before anchoring; the page derives one from the
   * first note's passage and saves it.
   */
  anchor: NoteAnchor | null;
  /** Parked position, the fallback when the passage can't be found: left is from the reading column's left edge, top from the page top. */
  left: number | null;
  top: number | null;
  width: number | null;
  /** The reader's edited note (their own HTML), or null while it's still plain Q&A. */
  html: string | null;
  /** How many notes the edited HTML already includes; later ones show as Q&A below it. */
  htmlCount: number;
  notes: AskNote[];
};

/** Storage bounds per reader. With the per-note HTML cap they bound what one account can store. */
export const MAX_THREADS_PER_TOPIC = 50;
export const MAX_THREADS_PER_READER = 1000;
export const MAX_NOTES_PER_THREAD = 50;
export const MAX_HTML = 50_000;
const PAGE_SIZE = 50;

type RawNote = { documentId: string; passage: string | null; question: string; answer: string; createdAt: string };
type RawThread = {
  documentId: string;
  anchor?: unknown;
  left: number | null;
  top: number | null;
  width: number | null;
  html: string | null;
  htmlCount: number | null;
  notes?: RawNote[];
};
type Page<T> = { data: T[]; meta?: { pagination?: { page: number; pageCount: number; total: number } } };

export const toNote = (n: RawNote): AskNote => ({
  id: n.documentId,
  passage: n.passage,
  question: n.question,
  answer: n.answer,
  createdAt: n.createdAt,
});

const toThread = (t: RawThread): AskThread => ({
  id: t.documentId,
  anchor: readAnchor(t.anchor),
  left: t.left,
  top: t.top,
  width: t.width,
  html: t.html,
  htmlCount: t.htmlCount ?? 0,
  notes: (t.notes ?? []).map(toNote).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
});

const THREAD_FIELDS = {
  'populate[notes][sort][0]': 'createdAt:asc',
  'populate[notes][fields][0]': 'passage',
  'populate[notes][fields][1]': 'question',
  'populate[notes][fields][2]': 'answer',
  'populate[notes][fields][3]': 'createdAt',
};

export type ThreadPage = { threads: AskThread[]; page: number; pageCount: number; total: number };

/** A read the caller may cut short (AbortSignal.timeout): it gave up, so it isn't Strapi's failure. */
type ReadOptions = { signal?: AbortSignal };

/** One page of the reader's threads on a topic (by topic documentId), oldest first. */
export async function listThreads(readerId: string, topicDocumentId: string, page = 1, { signal }: ReadOptions = {}): Promise<ThreadPage> {
  const q = new URLSearchParams({
    'filters[readerId][$eq]': readerId,
    'filters[topic][documentId][$eq]': topicDocumentId,
    sort: 'createdAt:asc',
    'pagination[page]': String(page),
    'pagination[pageSize]': String(PAGE_SIZE),
    ...THREAD_FIELDS,
  });
  const { data, meta } = await serverFetch<Page<RawThread>>(`/ask-threads?${q}`, { signal });
  const p = meta?.pagination;
  return { threads: data.map(toThread), page: p?.page ?? page, pageCount: p?.pageCount ?? 1, total: p?.total ?? data.length };
}

/**
 * One of the reader's threads, or null if it doesn't exist, belongs to someone else, or (with
 * topicDocumentId) is on another topic.
 */
export async function getThread(readerId: string, id: string, topicDocumentId?: string): Promise<AskThread | null> {
  const q = new URLSearchParams({
    'filters[documentId][$eq]': id,
    'filters[readerId][$eq]': readerId,
    ...(topicDocumentId ? { 'filters[topic][documentId][$eq]': topicDocumentId } : {}),
    'pagination[pageSize]': '1',
    ...THREAD_FIELDS,
  });
  const { data } = await serverFetch<{ data: RawThread[] }>(`/ask-threads?${q}`);
  return data[0] ? toThread(data[0]) : null;
}

/** How many threads the reader has, on one topic or overall. */
export async function countThreads(readerId: string, topicDocumentId?: string, { signal }: ReadOptions = {}): Promise<number> {
  const q = new URLSearchParams({
    'filters[readerId][$eq]': readerId,
    ...(topicDocumentId ? { 'filters[topic][documentId][$eq]': topicDocumentId } : {}),
    'fields[0]': 'documentId',
    'pagination[pageSize]': '1',
  });
  const { meta, data } = await serverFetch<Page<{ documentId: string }>>(`/ask-threads?${q}`, { signal });
  return meta?.pagination?.total ?? data.length;
}

/** Null when the reader may start another thread on the topic, else why not. */
export async function threadLimitReached(readerId: string, topicDocumentId: string): Promise<string | null> {
  const [onTopic, overall] = await Promise.all([countThreads(readerId, topicDocumentId), countThreads(readerId)]);
  if (onTopic >= MAX_THREADS_PER_TOPIC) return t('notes.pageFull', { max: String(MAX_THREADS_PER_TOPIC) });
  if (overall >= MAX_THREADS_PER_READER) return t('notes.readerFull', { max: String(MAX_THREADS_PER_READER) });
  return null;
}

export type Placement = { left: number; top: number; width: number; anchor?: NoteAnchor };

export async function createThread(
  readerId: string,
  systemDocumentId: string,
  topicDocumentId: string,
  place: Placement | null,
  content: { html?: string | null; htmlCount?: number } = {},
): Promise<string> {
  const { data } = await serverFetch<{ data: RawThread }>('/ask-threads', {
    method: 'POST',
    body: JSON.stringify({
      data: { readerId, system: systemDocumentId, topic: topicDocumentId, htmlCount: 0, ...(place ?? {}), ...content },
    }),
  });
  return data.documentId;
}

export type NewNote = { passage: string | null; question: string; answer: string };
type Owner = { readerId: string; systemDocumentId: string; topicDocumentId: string };

/** Adds a question and answer to one of the reader's threads. */
export async function addNote(owner: Owner, threadId: string, note: NewNote): Promise<AskNote> {
  const { data } = await serverFetch<{ data: RawNote }>('/ask-notes', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        readerId: owner.readerId,
        system: owner.systemDocumentId,
        topic: owner.topicDocumentId,
        thread: threadId,
        ...note,
      },
    }),
  });
  return toNote(data);
}

/** The CMS doesn't have the custom route yet (web deployed first): use the core routes. */
const missingRoute = (err: unknown) => err instanceof StrapiError && (err.status === 404 || err.status === 405);

export class ThreadLimitError extends Error {}

/**
 * Starts a thread with its first question and answer as one operation: a single transaction in
 * the CMS (POST /ask-threads/with-note). Against a CMS without that route it creates the two
 * separately and deletes the thread again if the note can't be saved.
 */
export async function createThreadWithNote(
  owner: Owner,
  place: Placement | null,
  note: NewNote,
): Promise<{ thread: string; note: AskNote }> {
  try {
    const { data } = await serverFetch<{ data: { thread: { documentId: string }; note: RawNote } }>('/ask-threads/with-note', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          readerId: owner.readerId,
          system: owner.systemDocumentId,
          topic: owner.topicDocumentId,
          place,
          note,
          maxThreadsPerTopic: MAX_THREADS_PER_TOPIC,
        },
      }),
    });
    return { thread: data.thread.documentId, note: toNote(data.note) };
  } catch (err) {
    if (err instanceof StrapiError && err.status === 409) throw new ThreadLimitError(err.detail);
    if (!missingRoute(err)) throw err;
  }
  const thread = await createThread(owner.readerId, owner.systemDocumentId, owner.topicDocumentId, place);
  try {
    return { thread, note: await addNote(owner, thread, note) };
  } catch (err) {
    await serverFetch(`/ask-threads/${encodeURIComponent(thread)}`, { method: 'DELETE' }).catch((e) =>
      console.error(`[ask] could not remove empty thread ${thread}:`, (e as Error).message),
    );
    throw err;
  }
}

export type ThreadPatch = Partial<Placement> & { html?: string | null; htmlCount?: number };

export async function updateThread(id: string, patch: ThreadPatch): Promise<void> {
  await serverFetch(`/ask-threads/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ data: patch }) });
}

type Purged = { threads: number; notes: number };

async function purge(readerId: string, thread?: string): Promise<Purged | null> {
  try {
    const { data } = await serverFetch<{ data: Purged }>('/ask-threads/purge', {
      method: 'POST',
      body: JSON.stringify({ data: { readerId, ...(thread ? { thread } : {}) } }),
    });
    return data;
  } catch (err) {
    if (missingRoute(err)) return null;
    throw err;
  }
}

const removeDoc = async (path: string) => {
  try {
    await serverFetch(path, { method: 'DELETE' });
  } catch (err) {
    if (!(err instanceof StrapiError && err.status === 404)) throw err;
  }
};

/** Deletes one of the reader's threads and its notes (in one CMS transaction when available). */
export async function deleteThread(readerId: string, thread: AskThread): Promise<void> {
  if (await purge(readerId, thread.id)) return;
  for (const n of thread.notes) await removeDoc(`/ask-notes/${encodeURIComponent(n.id)}`);
  await removeDoc(`/ask-threads/${encodeURIComponent(thread.id)}`);
}

/**
 * Deletes every thread and note the reader has, e.g. when their account is deleted. One CMS
 * transaction when available; otherwise page by page through the core routes.
 */
export async function deleteReaderThreads(readerId: string): Promise<Purged> {
  const done = await purge(readerId);
  if (done) return done;
  const out: Purged = { threads: 0, notes: 0 };
  for (const [path, key] of [
    ['/ask-notes', 'notes'],
    ['/ask-threads', 'threads'],
  ] as const) {
    for (;;) {
      const q = new URLSearchParams({ 'filters[readerId][$eq]': readerId, 'fields[0]': 'documentId', 'pagination[pageSize]': '100' });
      const { data } = await serverFetch<{ data: { documentId: string }[] }>(`${path}?${q}`);
      if (!data.length) break;
      for (const d of data) await removeDoc(`${path}/${encodeURIComponent(d.documentId)}`);
      out[key] += data.length;
    }
  }
  return out;
}

const int = (v: unknown, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : undefined;

/**
 * Validates a placement from a request body: all three numbers, clamped to sane ranges, and the
 * anchor when there is a valid one (an invalid anchor is dropped, never the whole placement).
 */
export function readPlacement(v: unknown): Placement | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  const left = int(p.left, -2000, 10_000);
  const top = int(p.top, 0, 1_000_000);
  const width = int(p.width, 150, 1200);
  if (left === undefined || top === undefined || width === undefined) return null;
  const anchor = readAnchor(p.anchor);
  return { left, top, width, ...(anchor ? { anchor } : {}) };
}

/**
 * Validates a thread update from a request body; unknown or invalid fields are dropped. Note
 * HTML is stored only after the same allowlist cleaning the browser applies (note-html.ts).
 */
export function readPatch(body: Record<string, unknown>): ThreadPatch | null {
  const patch: ThreadPatch = {};
  const place = readPlacement(body);
  if (place) Object.assign(patch, place);
  // An anchor alone: a note re-anchored (its passage moved, or a note saved before anchoring).
  const anchor = readAnchor(body.anchor);
  if (anchor) patch.anchor = anchor;
  if (body.html === null) patch.html = null;
  else if (typeof body.html === 'string') {
    if (body.html.length > MAX_HTML) return null;
    const html = sanitizeNoteHtml(body.html);
    // Cleaning the client's already-clean HTML gives it back unchanged; only hostile or broken
    // input can grow (escaped text), and that isn't worth storing past the cap.
    if (html.length > MAX_HTML) return null;
    patch.html = html;
  }
  const count = int(body.htmlCount, 0, 10_000);
  if (count !== undefined) patch.htmlCount = count;
  return Object.keys(patch).length ? patch : null;
}
