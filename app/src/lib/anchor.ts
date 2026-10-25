// Where a saved Ask note belongs on its page (P2-13, QUALITY-14). A note is anchored to the
// passage it was asked about: the authored key of the block it is in, plus a W3C-style text quote
// selector (the passage itself, `exact`, with a little of the text either side to tell repeats
// apart). Its position is kept relative to that passage (`dy`), so the note follows the passage
// when blocks are added above it, when the reader zooms or when the column reflows. The stored
// pixel position is only a fallback, for notes whose passage can't be found.
//
// Pure functions over text, shared by the browser (anchor-dom.ts) and the server (validation).
// Text is compared with all whitespace removed, so reflowed or re-indented YAML, and the
// difference between how a passage was read (innerText) and how the page is indexed
// (textContent), never break a match.

export type NoteAnchor = {
  /** The authored key of the block the passage is in; null for text outside any block (the title, the lede). */
  block: string | null;
  /** The passage (whitespace collapsed). Empty for an anchor to the block as a whole. */
  exact: string;
  /** Up to QUOTE_CONTEXT characters of the block's text before and after the passage. */
  prefix: string;
  suffix: string;
  /** The note's top relative to the top of the passage, in CSS pixels. */
  dy: number;
};

/**
 * What became of a note's anchor on the page as it is now:
 *   exact    the passage is where it was
 *   moved    the passage is in another block now (or its block has no key any more); still attached
 *   changed  its block is there but the passage text is not: attached to the block, and flagged
 *   missing  neither the block nor the passage is on the page: parked at its saved pixels, flagged
 *   none     the note has no anchor (saved before anchoring): parked at its saved pixels
 */
export type AnchorStatus = 'exact' | 'moved' | 'changed' | 'missing' | 'none';

export const QUOTE_CONTEXT = 32;
export const EXACT_MAX = 300;
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const squash = (s: string) => s.replace(/\s+/g, '');
export const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The flagged states: the reader is told the passage changed since the note was saved. */
export const isFlagged = (s: AnchorStatus) => s === 'changed' || s === 'missing';

const commonPrefix = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};
const commonSuffix = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};

export type QuoteMatch = { start: number; end: number; score: number };

/**
 * Finds a quote in `text` (squashed coordinates: offsets into squash(text)). Of several
 * occurrences of `exact`, the one whose surroundings best match prefix and suffix wins; the first
 * on a tie. Null when `exact` is empty or absent.
 */
export function findQuote(text: string, quote: Pick<NoteAnchor, 'exact' | 'prefix' | 'suffix'>): QuoteMatch | null {
  const hay = squash(text);
  const exact = squash(quote.exact);
  if (!exact) return null;
  const prefix = squash(quote.prefix);
  const suffix = squash(quote.suffix);
  let best: QuoteMatch | null = null;
  for (let i = hay.indexOf(exact); i >= 0; i = hay.indexOf(exact, i + 1)) {
    const end = i + exact.length;
    const score = commonSuffix(hay.slice(Math.max(0, i - prefix.length), i), prefix) + commonPrefix(hay.slice(end, end + suffix.length), suffix);
    if (!best || score > best.score) best = { start: i, end, score };
  }
  return best;
}

/** A block of the page as the resolver sees it: its key (null for text outside blocks) and its own text. */
export type PageBlock = { key: string | null; text: string };

export type Resolution = {
  status: AnchorStatus;
  /** Index into the blocks the anchor resolved to (-1 when missing or none). */
  index: number;
  /** The quote's place in that block's text (squashed offsets); null when attached to the block as a whole. */
  match: QuoteMatch | null;
};

/**
 * Where an anchor is on the page now. Its own block first; failing that, the best match of the
 * quote anywhere else (the passage moved to another block); failing that, its block alone, flagged
 * as changed; failing that, missing.
 */
export function resolveAnchor(anchor: NoteAnchor | null | undefined, blocks: readonly PageBlock[]): Resolution {
  if (!anchor) return { status: 'none', index: -1, match: null };
  const own = blocks.findIndex((b) => b.key === anchor.block);
  if (!squash(anchor.exact)) {
    // An anchor to a whole block: there or not.
    return own >= 0 && anchor.block !== null ? { status: 'exact', index: own, match: null } : { status: 'missing', index: -1, match: null };
  }
  if (own >= 0) {
    const match = findQuote(blocks[own].text, anchor);
    if (match) return { status: 'exact', index: own, match };
  }
  let best: { index: number; match: QuoteMatch } | null = null;
  for (let index = 0; index < blocks.length; index++) {
    if (index === own) continue;
    const match = findQuote(blocks[index].text, anchor);
    if (match && (!best || match.score > best.match.score)) best = { index, match };
  }
  if (best) return { status: 'moved', ...best };
  if (own >= 0 && anchor.block !== null) return { status: 'changed', index: own, match: null };
  return { status: 'missing', index: -1, match: null };
}

/**
 * A quote for text[start, end) of a block's text (offsets into the collapsed text), with its
 * context, the passage capped at EXACT_MAX characters.
 */
export function quoteOf(text: string, start: number, end: number): Pick<NoteAnchor, 'exact' | 'prefix' | 'suffix'> {
  const cut = Math.min(end, start + EXACT_MAX);
  return {
    exact: collapse(text.slice(start, cut)),
    prefix: collapse(text.slice(Math.max(0, start - QUOTE_CONTEXT), start)),
    suffix: collapse(text.slice(cut, cut + QUOTE_CONTEXT)),
  };
}

/**
 * Whether a block's content (CMS data: every string in it, at any depth) still has a passage. For
 * text the page isn't showing right now (a tab or state that isn't open), which is not a change.
 */
export function blockHasText(block: unknown, exact: string): boolean {
  const want = squash(exact);
  if (!want || !block) return false;
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(block);
  return strings.some((t) => squash(t).includes(want)) || squash(strings.join('')).includes(want);
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);

/** Validates an anchor from a request body or the CMS; null when it isn't one. */
export function readAnchor(v: unknown): NoteAnchor | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  const block = a.block === null ? null : str(a.block, 64);
  const exact = str(a.exact, EXACT_MAX + 20);
  const prefix = str(a.prefix ?? '', QUOTE_CONTEXT + 8);
  const suffix = str(a.suffix ?? '', QUOTE_CONTEXT + 8);
  const dy = typeof a.dy === 'number' && Number.isFinite(a.dy) ? Math.round(Math.min(5_000, Math.max(-5_000, a.dy))) : undefined;
  if (block === undefined || (block !== null && !KEY.test(block)) || exact === undefined || prefix === undefined || suffix === undefined || dy === undefined) return null;
  if (block === null && !squash(exact)) return null; // anchored to nothing
  return { block, exact: collapse(exact), prefix: collapse(prefix), suffix: collapse(suffix), dy };
}
