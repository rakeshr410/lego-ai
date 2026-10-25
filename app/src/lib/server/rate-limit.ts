import { createHash } from 'node:crypto';
import { getStore } from './store';

// Rate limits on the shared store (Redis in production), so every web instance counts the
// same hits. Sliding window, approximated from the current and previous fixed windows.

/** Hashes a personal value (email, username) before it becomes part of a store key. */
export const keyOf = (value: string) => createHash('sha256').update(value.toLowerCase()).digest('base64url').slice(0, 22);

export type LimitResult = { ok: boolean; retryAfter: number };

type Options = {
  /** Allow the request when the store is unreachable (default). Pass false for spend guards. */
  failOpen?: boolean;
};

function windows(key: string, windowMs: number) {
  const now = Date.now();
  const w = Math.floor(now / windowMs);
  const into = now - w * windowMs;
  return {
    cur: `rl:${key}:${w}`,
    prev: `rl:${key}:${w - 1}`,
    weight: 1 - into / windowMs,
    retryAfter: Math.max(1, Math.ceil((windowMs - into) / 1000)),
  };
}

async function run(key: string, max: number, windowMs: number, count: boolean, opts: Options): Promise<LimitResult> {
  const w = windows(key, windowMs);
  try {
    const store = await getStore();
    const [cur, prev] = await Promise.all([
      count ? store.incr(w.cur, windowMs * 2) : store.get(w.cur).then(Number),
      store.get(w.prev).then(Number),
    ]);
    const estimate = (prev || 0) * w.weight + (cur || 0);
    // When peeking, the next hit is the one that would be counted.
    const ok = count ? estimate <= max : estimate < max;
    return { ok, retryAfter: ok ? 0 : w.retryAfter };
  } catch (err) {
    console.error(`[rate-limit] store unavailable for ${key.split(':')[0]}:`, (err as Error).message);
    return { ok: opts.failOpen !== false, retryAfter: 30 };
  }
}

/** Counts a hit for `key` and reports whether it is within `max` per `windowMs`. */
export function rateLimit(key: string, max: number, windowMs: number, opts: Options = {}) {
  return run(key, max, windowMs, true, opts);
}

/** Reports whether one more hit would be allowed, without counting it. */
export function peekLimit(key: string, max: number, windowMs: number, opts: Options = {}) {
  return run(key, max, windowMs, false, opts);
}

/** Counts a hit without checking it (e.g. a failed sign-in against an account). */
export async function recordHit(key: string, windowMs: number) {
  await run(key, Number.POSITIVE_INFINITY, windowMs, true, {});
}

// ---------------------------------------------------------------------------------------
// Legacy synchronous limiter, kept only for the Ask routes until they move to rateLimit().
// Per process and in memory, but bounded so it can't grow without limit.

const hits = new Map<string, number[]>();
const MAX_KEYS = 20_000;

/** @deprecated Per-process only; use `await rateLimit(...)`. */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.delete(key);
  if (hits.size >= MAX_KEYS) {
    for (const k of hits.keys()) {
      hits.delete(k);
      if (hits.size < MAX_KEYS * 0.9) break;
    }
  }
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}
