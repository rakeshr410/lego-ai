import { z } from 'zod';
import { getStore } from '../store';
import { compactElements, fingerprint, MAX_ELEMENTS, renderBoard, renderDelta, serialise, type BoardElement, type BoardGraph, type IdMap } from '../../board/serialise';
import { boardKey, boardPngKey, ttlFrom, type Session } from './sessions';

// The session's whiteboard on the server (design section 7): one record under its own key, with
// the session's TTL, changed by compare-and-set on the version the room last saw (two tabs cannot
// overwrite each other: the loser gets the server's scene back). The server serialises; the
// room only compacts the scene and computes the fingerprint. PNGs the room renders once per
// stage live under their own keys, capped in size and count.

export { boardKey, boardPngKey };
/** The largest board body accepted: MAX_ELEMENTS compacted elements come to about 110 KB. */
export const BOARD_MAX_BYTES = 160 * 1024;
export const PNG_MAX_BYTES = 200 * 1024;
export const PNG_MAX_PER_SESSION = 8;
/** Board snapshots kept on the session (text only), at stage changes and the finish. */
export const SNAPSHOTS_MAX = 12;

export type BoardRecord = {
  version: number;
  fingerprint: string;
  elements: BoardElement[];
  graph: BoardGraph;
  /** Excalidraw id -> short id, so n4 stays n4 from one version to the next. */
  ids: IdMap;
  updatedAt: string;
  /** Stages a PNG was stored for. */
  pngs: string[];
};

export class BoardConflict extends Error {
  constructor(readonly current: { version: number; fingerprint: string; elements: BoardElement[] }) {
    super('board version conflict');
  }
}
export class BoardInvalid extends Error {}

const saveBody = z.object({
  baseVersion: z.number().int().min(0),
  fingerprint: z.string().regex(/^[0-9a-f]{8}$/),
  elements: z.array(z.unknown()).max(MAX_ELEMENTS).optional(),
});

export async function readBoard(id: string): Promise<BoardRecord | null> {
  const raw = await (await getStore()).get(boardKey(id));
  return raw ? (JSON.parse(raw) as BoardRecord) : null;
}

/**
 * Saves the room's scene as the next version, or throws BoardConflict with the server's scene when
 * `baseVersion` is not the current one. A body without elements is the room's parting beacon
 * ({version, fingerprint}): acknowledged, nothing written. Returns the version and fingerprint.
 */
export async function saveBoard(session: Pick<Session, 'id' | 'startedAt'>, retentionDays: number, body: unknown): Promise<{ version: number; fingerprint: string }> {
  const parsed = saveBody.safeParse(body);
  if (!parsed.success) throw new BoardInvalid('A board save needs baseVersion, fingerprint and elements.');
  const { baseVersion, elements: rawElements } = parsed.data;
  const store = await getStore();
  const ttl = ttlFrom(session.startedAt, retentionDays);
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await store.get(boardKey(session.id));
    const current = raw ? (JSON.parse(raw) as BoardRecord) : null;
    if (!rawElements) return current ? { version: current.version, fingerprint: current.fingerprint } : { version: 0, fingerprint: parsed.data.fingerprint };
    if ((current?.version ?? 0) !== baseVersion) throw new BoardConflict(current ? { version: current.version, fingerprint: current.fingerprint, elements: current.elements } : { version: 0, fingerprint: '', elements: [] });
    const elements = compactElements(rawElements);
    const print = fingerprint(elements);
    if (print !== parsed.data.fingerprint) throw new BoardInvalid('The fingerprint does not match the scene.');
    if (current && current.fingerprint === print) return { version: current.version, fingerprint: print };
    const ids = { ...(current?.ids ?? {}) };
    const graph = serialise(elements, ids);
    const next: BoardRecord = { version: (current?.version ?? 0) + 1, fingerprint: print, elements, graph, ids, updatedAt: new Date().toISOString(), pngs: current?.pngs ?? [] };
    const ok = raw ? await store.cas(boardKey(session.id), raw, JSON.stringify(next), ttl) : await store.setNx(boardKey(session.id), JSON.stringify(next), ttl);
    if (ok) return { version: next.version, fingerprint: print };
  }
  throw new Error('board save contended');
}

/** The PNG slot for the board as it stands now (the vision fallback reads it); overwritten, outside the per-stage cap. */
export const CURRENT_PNG = 'current';
export type StoredPng = { version: number; data: string };

/**
 * Stores a PNG of the board (the room renders it; the server has no renderer): the stage's, once
 * the stage ends, at most PNG_MAX_PER_SESSION per session, or the CURRENT_PNG slot. The version
 * says which board it shows.
 */
export async function savePng(session: Pick<Session, 'id' | 'startedAt'>, retentionDays: number, stage: string, png: Buffer, version: number): Promise<{ stored: boolean }> {
  if (png.byteLength > PNG_MAX_BYTES || png.byteLength < 8) throw new BoardInvalid(`A board image is at most ${PNG_MAX_BYTES / 1024} KB.`);
  if (!(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)) throw new BoardInvalid('Not a PNG.');
  const store = await getStore();
  const ttl = ttlFrom(session.startedAt, retentionDays);
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await store.get(boardKey(session.id));
    if (!raw) return { stored: false };
    const current = JSON.parse(raw) as BoardRecord;
    const has = current.pngs.includes(stage);
    if (!has && stage !== CURRENT_PNG && current.pngs.filter((s) => s !== CURRENT_PNG).length >= PNG_MAX_PER_SESSION) return { stored: false };
    const next: BoardRecord = has ? current : { ...current, pngs: [...current.pngs, stage] };
    if (has || (await store.cas(boardKey(session.id), raw, JSON.stringify(next), ttl))) {
      const stored: StoredPng = { version, data: png.toString('base64') };
      await store.set(boardPngKey(session.id, stage), JSON.stringify(stored), ttl);
      return { stored: true };
    }
  }
  return { stored: false };
}

/** The stage's PNG (base64) and the board version it shows, or null. */
export async function readPng(id: string, stage: string): Promise<StoredPng | null> {
  const raw = await (await getStore()).get(boardPngKey(id, stage));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredPng;
  } catch {
    return null;
  }
}

/** Deletes the board and its PNGs (session deletion, privacy.md). */
export async function deleteBoard(id: string): Promise<void> {
  const store = await getStore();
  const record = await readBoard(id).catch(() => null);
  for (const stage of record?.pngs ?? []) await store.del(boardPngKey(id, stage));
  await store.del(boardKey(id));
}

/**
 * What the next candidate turn carries about the board: the whole board the first time (or when
 * the delta would be longer), else the delta from the version the interviewer last saw. Null when
 * the board has not changed since.
 */
export function boardTextFor(record: BoardRecord, last: Session['board'] | undefined, stage: string): { text: string; version: number } | null {
  const seen = last?.seen ?? 0;
  if (record.version <= seen) return null;
  if (!last?.graph || seen === 0) return { text: renderBoard(record.graph, { version: record.version, stage }), version: record.version };
  return { text: renderDelta(last.graph, record.graph, { from: seen, version: record.version, stage }).text, version: record.version };
}

/** A text snapshot of the board for the session (stage change, finish), capped at SNAPSHOTS_MAX. */
export function withSnapshot(s: Session, record: BoardRecord | null, stage: string): Session {
  if (!record || !record.graph.nodes.length) return s;
  const snaps = s.boardSnapshots ?? [];
  if (snaps.some((x) => x.stage === stage && x.version === record.version)) return s;
  const next = [...snaps, { stage, version: record.version, text: renderBoard(record.graph, { version: record.version, stage }), at: new Date().toISOString() }];
  return { ...s, boardSnapshots: next.slice(-SNAPSHOTS_MAX) };
}
