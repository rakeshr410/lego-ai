import type { CallResult } from '../llm-gateway';

// The speculative start (design section 6, "latency"). The voice service hears the candidate stop
// (the VAD, 0.2 s of silence) a few hundred milliseconds before it decides the turn is over
// (smart-turn's verdict, the transcriber's final words). It posts what it has heard so far and the
// web starts the model on it here. When the confirmed turn arrives with the same words the stream
// is handed over, that much ahead; with different words the guess is dropped and the turn is
// answered from scratch, having cost one unused call. One guess per session, the newest replacing
// the older, and none kept beyond PREFETCH_TTL_MS.
//
// The fingerprint has two parts: the request around the words (the transcript, the board, the
// director's decision), which must match exactly, and the words themselves, which may differ a
// little. The transcriber's interim text at the stop usually lacks the final's last word or spells a
// number differently, and a guess on it is still the reply the interviewer would have given; it is
// handed over when the two differ by at most one word in seven (nearSpoken). The transcript keeps the
// confirmed words. A newer guess whose words are that close to the waiting one keeps the waiting one.

export const PREFETCH_TTL_MS = 12_000;

export type PrefetchKey = {
  /** The request with the spoken words blanked: the context the guess was made in. */
  context: string;
  /** The spoken words, normalized (normalizeSpoken). */
  spoken: string;
};

type Entry = {
  key: PrefetchKey;
  startedAt: number;
  chunks: string[];
  listener: ((delta: string) => void) | null;
  result: Promise<CallResult>;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
};

const entries = new Map<string, Entry>();

export type Prefetched = {
  /** How long the model had been running when the turn was confirmed. */
  leadMs: number;
  /** Hands the text so far and the rest of the stream to onText; resolves as the call does. */
  feed(onText: (delta: string) => void): Promise<CallResult>;
  /** Stops the call (the candidate cut in): feed's promise rejects as an aborted call. */
  abort(): void;
};

function logPrefetch(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event: 'interview_prefetch', ts: new Date().toISOString(), ...fields }));
}

/**
 * Starts a speculative call for the session under `key` (the request's fingerprint), replacing any
 * older one unless that one was made on the same context and nearly the same words: then it stays
 * (it is further along) and nothing starts. Returns whether a call was started.
 */
export function startPrefetch(sid: string, key: PrefetchKey, run: (onText: (delta: string) => void, signal: AbortSignal) => Promise<CallResult>, now = Date.now()): boolean {
  const waiting = entries.get(sid);
  if (waiting && waiting.key.context === key.context && nearSpoken(waiting.key.spoken, key.spoken) !== null) return false;
  dropPrefetch(sid, 'replaced', waiting ? apart(waiting.key, key) : {});
  const abort = new AbortController();
  const entry = { key, startedAt: now, chunks: [] as string[], listener: null as Entry['listener'], abort } as Entry;
  entry.result = run((delta) => {
    entry.chunks.push(delta);
    entry.listener?.(delta);
  }, abort.signal);
  // A guess nobody claims may fail (dropped, or the model refused): that is nobody's error.
  entry.result.catch(() => {});
  entry.timer = setTimeout(() => dropPrefetch(sid, 'expired'), PREFETCH_TTL_MS);
  entries.set(sid, entry);
  return true;
}

/**
 * The session's guess when it was made on `key` (the same context, the same or nearly the same
 * words), taken off the shelf; a guess on other words is dropped.
 */
export function claimPrefetch(sid: string, key: PrefetchKey, now = Date.now()): Prefetched | null {
  const entry = entries.get(sid);
  if (!entry) return null;
  const edits = entry.key.context === key.context ? nearSpoken(entry.key.spoken, key.spoken) : null;
  if (edits === null) {
    dropPrefetch(sid, 'mismatch', apart(entry.key, key));
    return null;
  }
  entries.delete(sid);
  clearTimeout(entry.timer);
  const leadMs = now - entry.startedAt;
  logPrefetch({ session: sid, outcome: 'hit', leadMs, ...(edits ? { edits } : {}) });
  return {
    leadMs,
    feed(onText) {
      for (const chunk of entry.chunks) onText(chunk);
      entry.listener = onText;
      return entry.result;
    },
    abort: () => entry.abort.abort(),
  };
}

/** Abandons the session's guess, aborting its call. `why` says how far the words that beat it were. */
export function dropPrefetch(sid: string, reason: 'replaced' | 'mismatch' | 'expired' | 'ended', why: Record<string, unknown> = {}): void {
  const entry = entries.get(sid);
  if (!entry) return;
  entries.delete(sid);
  clearTimeout(entry.timer);
  entry.abort.abort();
  logPrefetch({ session: sid, outcome: reason, leadMs: Date.now() - entry.startedAt, ...why });
}

/**
 * How a guess and the words that beat it differ, for the log and no more (no words): whether the
 * request around the words was the same, the word edit distance, and the two word counts.
 */
function apart(guess: PrefetchKey, next: PrefetchKey): Record<string, unknown> {
  const a = guess.spoken.split(' ').filter(Boolean);
  const b = next.spoken.split(' ').filter(Boolean);
  return { sameContext: guess.context === next.context, edits: wordEdits(a, b), words: [a.length, b.length] };
}

/** Whether a guess is waiting for the session (tests). */
export const hasPrefetch = (sid: string) => entries.has(sid);

/**
 * Spoken words as the fingerprint sees them: the transcriber's interim text lacks the capitals and
 * punctuation its final adds, and those must not make a right guess look wrong.
 */
export function normalizeSpoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How many words apart two spoken texts are when they are close enough to be the same turn (the
 * word edit distance), or null when they are not. The allowance is one word in seven, at least one
 * from four words up; a shorter turn ("yes", "no", "not yet") must match word for word.
 */
export function nearSpoken(guess: string, spoken: string): number | null {
  if (guess === spoken) return 0;
  const a = guess.split(' ').filter(Boolean);
  const b = spoken.split(' ').filter(Boolean);
  if (!a.length || !b.length) return null;
  const n = Math.max(a.length, b.length);
  const allowed = n >= 4 ? Math.max(1, Math.floor(n / 7)) : 0;
  if (Math.abs(a.length - b.length) > allowed) return null;
  const d = wordEdits(a, b);
  return d <= allowed ? d : null;
}

/** The edit distance between two word lists. */
function wordEdits(a: readonly string[], b: readonly string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
