import { blockToText, textContext, type TextContext } from '@arrowbox/content-kit';
import { plainText } from '../headings';

// Turns a topic's content blocks into the plain-text document Ask mode grounds its answers in.
// Each valid block is serialized by its entry in the content-kit block registry (toText), which
// knows the block's shape: it names components by key, ranks rubric areas, and keeps quiz
// answers away from the tutor. A block that doesn't validate (or a type the registry doesn't
// know yet) falls back to the generic extractor below, which walks every field so nothing the
// reader sees is lost. Only fields that never carry prose are skipped (ids, keys, layout,
// colours, enum switches). See ask-grounding.test.ts and content-kit/test for the coverage tests.

export type Block = { __component?: string } & Record<string, unknown>;

/**
 * Fields that never carry reader-facing prose: ids and keys, layout and colour switches, and
 * UI mock state. Numbers and booleans are left out anyway (except the FLAGS below).
 */
export const SKIP_FIELDS = new Set([
  'id',
  '__component',
  'documentId',
  'key',
  'parent',
  'railLabel',
  'tone',
  'theme',
  'direction',
  'style',
  'width',
  'target',
  'preview',
  'highlight',
  'variant',
  // Interview authoring (ADR 0003): the interviewer's probes and plan edits, not the article's prose.
  'interviewKind',
  'interviewProbes',
  'interviewDrop',
]);

/**
 * Fields left out of one block type at any depth, on purpose: the reader answers checkpoint
 * quizzes themselves, so the tutor sees the questions but not the options, answers or why.
 */
export const SKIP_IN_BLOCK: Record<string, readonly string[]> = {
  'sd.quiz': ['optionA', 'optionB', 'optionC', 'optionD', 'answer', 'explanation'],
  // Arrow styles (message, reply, note); the step text already says what happens.
  'sd.sequence-diagram': ['kind'],
  // Browser, phone or no chrome around the mock: layout only.
  'sd.screen': ['frame'],
  // Index labels at a strip's field edges: layout only (the widths are in the text).
  'sd.strip': ['numbering'],
  // The reference solution is a spoiler (the tutor must not hand it over); the seed and limits are plumbing for the lab server.
  'sd.lab': ['reference', 'seed', 'limits', 'workload', 'capture'],
  // The lab's catalog id, model mode and runtime are plumbing for the lab page; its title, summary and stages are prose.
  'sd.agent-lab': ['lab', 'mode', 'runtime'],
};

/** JSON fields shown as compact JSON (request and response bodies, state shapes, types). */
const JSON_VERBATIM = new Set(['requestBody', 'body', 'shape', 'store', 'types']);

/** Boolean fields worth a marker when true. */
const FLAGS: Record<string, string> = { chosen: '(chosen)', used: '(used)' };

/** Fields that name an item; they lead its line, the rest follow as "Label: value". */
const PRIMARY = new Set([
  'title',
  'heading',
  'name',
  'label',
  'component',
  'method',
  'path',
  'http',
  'code',
  'area',
  'question',
  'text',
  'value',
  'from',
  'to',
]);

const MAX_STRING = 2_000;
const MAX_JSON = 1_500;
const MAX_BLOCK = 6_000;
/** Registry serializers are deliberate, so they get more room (the action flow runs long). */
const MAX_TYPED_BLOCK = 12_000;
/** About 16k tokens: the largest pilot (whatsapp/chat-thread) is about 56k characters whole. */
export const MAX_DOCUMENT = 64_000;

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch)a?\(.*\))$/i;

const clean = (s: string, max = MAX_STRING) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

const humanize = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

type RichNode = { type?: unknown; text?: string; children?: RichNode[] };
const isRichText = (v: unknown): v is RichNode[] =>
  Array.isArray(v) && v.length > 0 && v.every((n) => n && typeof n === 'object' && 'type' in n && 'children' in n);

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const skipped = (block: string, key: string) => SKIP_FIELDS.has(key) || !!SKIP_IN_BLOCK[block]?.includes(key);

function compactJson(v: unknown) {
  const s = JSON.stringify(v);
  return s.length > MAX_JSON ? `${s.slice(0, MAX_JSON)}…` : s;
}

/** Text lines for one field value inside a block of type `block`. */
function valueLines(key: string, v: unknown, block: string): string[] {
  if (v == null) return [];
  if (typeof v === 'string') {
    const t = clean(v);
    return t && !COLOR.test(t) ? [t] : [];
  }
  if (typeof v === 'number') return [];
  if (typeof v === 'boolean') return v && FLAGS[key] ? [FLAGS[key]] : [];
  if (isRichText(v)) return v.map((n) => clean(plainText(n.children as Parameters<typeof plainText>[0]))).filter(Boolean);
  if (JSON_VERBATIM.has(key)) return [compactJson(v)];
  if (Array.isArray(v)) {
    // Table rows: arrays of cells.
    if (v.every(Array.isArray)) return v.map((row) => (row as unknown[]).map((c) => clean(String(c ?? ''))).join(' | '));
    return v.flatMap((item) => {
      const lines = valueLines(key, item, block);
      return lines.length ? [`- ${lines[0]}`, ...lines.slice(1).map((l) => `  ${l}`)] : [];
    });
  }
  if (isPlainObject(v)) return objectLines(v, block);
  return [];
}

function objectLines(o: Record<string, unknown>, block: string): string[] {
  const head: string[] = [];
  const rest: string[] = [];
  for (const [key, v] of Object.entries(o)) {
    if (skipped(block, key)) continue;
    const lines = valueLines(key, v, block);
    if (!lines.length) continue;
    if (typeof v === 'boolean' || (PRIMARY.has(key) && typeof v === 'string')) head.push(lines[0]);
    else if (lines.length === 1 && !lines[0].startsWith('- ')) rest.push(`${humanize(key)}: ${lines[0]}`);
    else rest.push(`${humanize(key)}:`, ...lines.map((l) => `  ${l}`));
  }
  if (!head.length) return rest;
  return [head.join(' · '), ...rest.map((l) => `  ${l}`)];
}

const componentLabel = (c: string) => humanize(c.replace(/^sd\./, ''));

/** One block as text: the registry's serializer when the block is valid, else the generic one. */
export function blockText(block: Block, ctx?: TextContext): string {
  const typed = blockToText(block, ctx);
  if (typed !== null) return typed.length > MAX_TYPED_BLOCK ? `${typed.slice(0, MAX_TYPED_BLOCK)}…` : typed;
  return genericBlockText(block);
}

/** Any block as text, field by field. Sections and subsections become headings that group what follows. */
export function genericBlockText(block: Block): string {
  const c = block.__component ?? '';
  const title = typeof block.title === 'string' ? clean(block.title) : '';
  const intro = typeof block.intro === 'string' ? clean(block.intro) : '';
  // A section's summary is the page's own recap of it: the tutor sees it after the intro.
  const summary = typeof block.summary === 'string' ? clean(block.summary) : '';
  if (c === 'sd.section') return [`## ${title}`, intro, summary].filter(Boolean).join('\n');
  if (c === 'sd.subsection') return [`### ${title}`, intro].filter(Boolean).join('\n');
  const body = objectLines(block, c);
  if (!body.length) return '';
  const label = `[${componentLabel(c)}]`;
  const text = body[0] === title ? [`${label} ${title}`, ...body.slice(1)] : [label, ...body];
  const out = text.join('\n');
  return out.length > MAX_BLOCK ? `${out.slice(0, MAX_BLOCK)}…` : out;
}

/**
 * The topic as one grounding document, capped at MAX_DOCUMENT characters. `components` is the
 * topic's component registry (P1-5): it names the keys blocks use and fills the diagram's cards;
 * `tools` (agentic topics) fills the tool catalog.
 */
export function topicDocument(title: string, lede: string | null | undefined, blocks: Block[], components?: readonly unknown[] | null, tools?: readonly unknown[] | null): string {
  const parts = [`# ${clean(title)}`, lede ? clean(lede) : ''].filter(Boolean);
  let size = parts.join('\n\n').length;
  let cut = false;
  const ctx = textContext(blocks, components, tools);
  for (const b of blocks) {
    const t = blockText(b, ctx);
    if (!t) continue;
    if (size + t.length + 2 > MAX_DOCUMENT) {
      cut = true;
      break;
    }
    parts.push(t);
    size += t.length + 2;
  }
  if (cut) parts.push('[The rest of this topic was left out for length.]');
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------------------
// Passage check: the passage a reader clicked comes from the browser, so it is only trusted
// when it matches the topic's own text (every string, quizzes included, since readers can
// click those too). Page chrome around a block (labels, numbering) is tolerated.

export const normalize = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function allStrings(v: unknown, out: string[]) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) allStrings(x, out);
  else if (isPlainObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'id' || k === '__component' || k === 'documentId') continue;
      if (JSON_VERBATIM.has(k) && x && typeof x === 'object') out.push(JSON.stringify(x));
      allStrings(x, out);
    }
  }
  return out;
}

export type PassageIndex = { text: string; shingles: Set<string> };

const SHINGLE = 3;
const shinglesOf = (words: string[]) => {
  const out: string[] = [];
  for (let i = 0; i + SHINGLE <= words.length; i++) out.push(words.slice(i, i + SHINGLE).join(' '));
  return out;
};

export function passageIndex(...sources: unknown[]): PassageIndex {
  const text = normalize(allStrings(sources, []).join(' \n '));
  return { text, shingles: new Set(shinglesOf(text.split(' '))) };
}

const EDGE = 3; // shingles of page chrome tolerated at each end ("Q1", "Show answer")

/**
 * Whether a clicked passage comes from the topic. The browser sends a block's visible text, so
 * a few words of page chrome at either end, and the odd label inside, are allowed; text added
 * in the middle or at length is not.
 */
export function passageInTopic(passage: string, index: PassageIndex): boolean {
  const p = normalize(passage);
  if (!p) return false;
  if (index.text.includes(p)) return true;
  const hits = shinglesOf(p.split(' ')).map((s) => index.shingles.has(s));
  let start = 0;
  let end = hits.length;
  while (start < Math.min(EDGE, hits.length) && !hits[start]) start++;
  while (end > Math.max(start, hits.length - EDGE) && !hits[end - 1]) end--;
  const core = hits.slice(start, end);
  if (core.length < 2 || core.length < hits.length / 2) return false;
  return core.filter(Boolean).length / core.length >= 0.8;
}
