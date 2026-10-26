import { createHash } from 'node:crypto';
import type { AstroCookies } from 'astro';
import { env, secureCookies, webInternalUrl } from './env';
import { LRU } from './lru';

export { isSameOrigin, json, readJson } from './http';

// Reader sessions are owned by the main site (lego/web): it signs readers in and out, and keeps
// their Strapi tokens in its store. This app only asks it who a session belongs to:
//
//   GET {WEB_INTERNAL_URL}/api/internal/reader
//   Authorization: Bearer LEGO_AI_SECRET
//   Cookie: <the reader's session cookie, as the browser sent it here>
//   -> 200 {reader: Reader | null}, 503 when the main site can't check sessions right now
//
// Both apps are served from the same origin, so the browser sends the session cookie with every
// request here too. Answers are cached briefly per session (a signed-in reader for VERIFIED_MS, a
// cookie that matched no session for UNKNOWN_MS): the main site itself re-checks a reader with
// Strapi at most once a minute, and signing out deletes the cookie in the browser.

export type Reader = {
  id: number;
  documentId: string;
  username: string;
  email: string;
  /** The Strapi plan fields (entitlements.ts); absent on sessions from before they existed. */
  plan?: string | null;
  planExpiresAt?: string | null;
};

type ReadOptions = {
  /** Gives up on the main site after this long (a 503 for the caller). Default READ_TIMEOUT_MS. */
  waitMs?: number;
};

const SID = /^[A-Za-z0-9_-]{43}$/;
const VERIFIED_MS = 15_000;
const UNKNOWN_MS = 5_000;
const READ_TIMEOUT_MS = 5_000;

const cookieName = () => (secureCookies() ? '__Host-sd_session' : 'sd_session');
const keyOf = (sid: string) => createHash('sha256').update(sid).digest('base64url');

let recent = new LRU<Reader | null>(10_000, VERIFIED_MS);
const inFlight = new Map<string, Promise<Reader | null>>();

/** The main site could not say who the reader is (down, slow, or misconfigured). */
export class SessionUnavailable extends Error {}

const pickReader = (u: Reader): Reader => ({
  id: u.id,
  documentId: u.documentId,
  username: u.username,
  email: u.email,
  plan: u.plan ?? null,
  planExpiresAt: u.planExpiresAt ?? null,
});

function isReader(v: unknown): v is Reader {
  const r = v as Reader;
  return !!r && typeof r === 'object' && Number.isInteger(r.id) && typeof r.documentId === 'string' && typeof r.username === 'string' && typeof r.email === 'string';
}

async function ask(name: string, sid: string, waitMs: number): Promise<Reader | null> {
  const secret = env('LEGO_AI_SECRET');
  if (!secret) throw new SessionUnavailable('LEGO_AI_SECRET is not set');
  let res: Response;
  try {
    res = await fetch(`${webInternalUrl()}/api/internal/reader`, {
      headers: { authorization: `Bearer ${secret}`, cookie: `${name}=${sid}`, accept: 'application/json' },
      signal: AbortSignal.timeout(waitMs),
    });
  } catch (err) {
    throw new SessionUnavailable(`the main site did not answer: ${(err as Error).message}`);
  }
  if (!res.ok) throw new SessionUnavailable(`the main site answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as { reader?: unknown } | null;
  if (!body || !('reader' in body)) throw new SessionUnavailable('the main site answered without a reader');
  return isReader(body.reader) ? pickReader(body.reader) : null;
}

/**
 * The signed-in reader, or null when the request has no session (or one that has ended). Throws
 * SessionUnavailable when the main site can't say; callers answer 503 (ask-http.ts readerOr503).
 */
export async function getReader(cookies: AstroCookies, opts: ReadOptions = {}): Promise<Reader | null> {
  const name = cookieName();
  const sid = cookies.get(name)?.value;
  if (!sid || !SID.test(sid)) return null;
  const key = keyOf(sid);
  const cached = recent.get(key);
  if (cached !== undefined) return cached;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = ask(name, sid, Math.max(1, opts.waitMs ?? READ_TIMEOUT_MS))
      .then((reader) => {
        recent.set(key, reader, reader ? VERIFIED_MS : UNKNOWN_MS);
        return reader;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/** Tests: forget every cached answer. */
export function clearReaderCache() {
  recent = new LRU<Reader | null>(10_000, VERIFIED_MS);
  inFlight.clear();
}
