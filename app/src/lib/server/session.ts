import { createHash, randomBytes } from 'node:crypto';
import type { AstroCookies } from 'astro';
import { SESSION_HINT } from '../session-hint';
import { within } from './deadline';
import { secureCookies } from './env';
import { LRU } from './lru';
import { getStore } from './store';
import { StrapiError, authFetch, userFetch } from './strapi-server';

export { isSameOrigin, json, readJson } from './http';

// Reader sessions are owned by the web server. The browser holds only an opaque random id in
// an HttpOnly cookie; the shared store maps it to the reader's Strapi tokens: a short-lived
// access JWT (10 minutes in users-permissions 'refresh' mode) and the refresh token, which is
// rotated through /auth/refresh as the access token nears expiry. Logging out deletes the
// record and revokes the refresh session in Strapi. Records are only ever changed with a
// compare-and-set, so a request holding an older copy can't write back a rotated-out token.

export type Reader = {
  id: number;
  documentId: string;
  username: string;
  email: string;
  /** The Strapi plan fields (entitlements.ts); absent on sessions from before they existed. */
  plan?: string | null;
  planExpiresAt?: string | null;
};

type SessionRecord = {
  user: Reader;
  jwt: string;
  /** Access token expiry, epoch ms. */
  jwtExp: number;
  /** Null in users-permissions 'legacy-support' mode (a long-lived JWT, nothing to refresh). */
  refreshToken: string | null;
  createdAt: number;
  /** Hard end of the session, epoch ms (Strapi's max refresh lifespan). */
  expiresAt: number;
  /** When Strapi last confirmed the reader (not blocked or deleted), epoch ms. */
  verifiedAt: number;
  /**
   * "Remember me" was left ticked: the cookies outlive the browser. False: they are browser-session
   * cookies and the session ends within a day. Absent (sessions from before the option): true.
   */
  persistent?: boolean;
};

const DAY = 24 * 60 * 60 * 1000;
// Match Strapi's refresh token lifespans (users-permissions defaults: 14 days idle, 30 max).
const IDLE_MS = 14 * DAY;
const MAX_MS = 30 * DAY;
// A session the reader asked not to be remembered: its cookies end with the browser, and it ends
// after a day even if the browser stays open.
const BROWSER_MS = DAY;
const VERIFY_MS = 60_000; // re-check with Strapi at most once a minute per session
const REFRESH_EARLY_MS = 60_000; // refresh the access token when it has under a minute left
const GRACE_MS = 15 * 60_000; // keep a recently verified reader signed in through a Strapi blip
const LOCK_MS = 10_000;

const SID = /^[A-Za-z0-9_-]{43}$/;
const cookieName = () => (secureCookies() ? '__Host-sd_session' : 'sd_session');
const hintName = () => (secureCookies() ? `__Host-${SESSION_HINT}` : SESSION_HINT);
const storeKey = (sid: string) => `sess:${createHash('sha256').update(sid).digest('base64url')}`;

// Per-process cache of recently verified sessions, so most requests skip the store.
const recent = new LRU<{ reader: Reader; expiresAt: number; persistent?: boolean }>(10_000, 10_000);
const refreshing = new Map<string, Promise<SessionRecord | null>>();
const verifying = new Map<string, Promise<SessionRecord | null>>();

const pickReader = (u: Reader): Reader => ({
  id: u.id,
  documentId: u.documentId,
  username: u.username,
  email: u.email,
  plan: u.plan ?? null,
  planExpiresAt: u.planExpiresAt ?? null,
});

function jwtExpiry(jwt: string): number {
  try {
    const { exp } = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    if (typeof exp === 'number') return exp * 1000;
  } catch {
    /* not a JWT we can read: assume the shortest lifetime */
  }
  return Date.now() + 10 * 60_000;
}

function ttlOf(rec: Pick<SessionRecord, 'expiresAt'>) {
  return Math.min(Date.now() + IDLE_MS, rec.expiresAt) - Date.now();
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function load(key: string): Promise<SessionRecord | null> {
  return parse<SessionRecord>(await (await getStore()).get(key));
}

async function save(key: string, rec: SessionRecord) {
  const ttl = ttlOf(rec);
  if (ttl <= 0) return false;
  await (await getStore()).set(key, JSON.stringify(rec), ttl);
  return true;
}

/**
 * Changes the stored record atomically, re-reading it when another request wrote in between.
 * `change` gets the latest record and returns the new one, or null to leave it as it is.
 * Returns what is stored afterwards; null when the session is gone.
 */
async function update(key: string, change: (cur: SessionRecord) => SessionRecord | null): Promise<SessionRecord | null> {
  const store = await getStore();
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await store.get(key);
    const cur = parse<SessionRecord>(raw);
    if (!raw || !cur) return null;
    const next = change(cur);
    if (!next) return cur;
    const ttl = ttlOf(next);
    if (ttl <= 0) return null;
    if (await store.cas(key, raw, JSON.stringify(next), ttl)) return next;
  }
  return load(key);
}

// Each reader's session keys, so signing out everywhere or resetting the password can end the
// web sessions on their other devices at once (Strapi doesn't re-check access tokens).
const userIndex = (userId: number) => `usess:${userId}`;
const MAX_INDEXED = 50;

async function indexSession(userId: number, key: string) {
  const store = await getStore();
  const idx = userIndex(userId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await store.get(idx);
    const keys = parse<string[]>(raw) ?? [];
    const live = await Promise.all(keys.map(async (k) => (k !== key && (await store.get(k)) ? k : null)));
    const next = JSON.stringify([...live.filter((k) => k !== null).slice(-(MAX_INDEXED - 1)), key]);
    if (raw === null ? await store.setNx(idx, next, MAX_MS) : await store.cas(idx, raw, next, MAX_MS)) return;
  }
}

/** Ends every web session of a reader (optionally keeping one), e.g. after a password reset. */
export async function endUserSessions(userId: number, { except }: { except?: string } = {}) {
  const store = await getStore();
  const idx = userIndex(userId);
  const keys = parse<string[]>(await store.get(idx)) ?? [];
  await Promise.all(
    keys
      .filter((k) => k !== except)
      .map((k) => {
        recent.delete(k);
        return store.del(k);
      }),
  );
  if (except && keys.includes(except)) await store.set(idx, JSON.stringify([except]), MAX_MS);
  else await store.del(idx);
}

/**
 * Makes every web session of a reader re-check them with Strapi on its next request, because
 * billing just changed their plan (lib/server/billing/activate.ts): each record is marked due a
 * check, and this process's cache forgets them. Other web instances cache a reader for at most
 * 10 s, and while Strapi is unreachable a session in its grace window keeps the plan it had, so
 * the change reaching every tab within seconds is best-effort. Returns how many sessions it found.
 */
export async function refreshUserSessions(userId: number): Promise<number> {
  const store = await getStore();
  const keys = parse<string[]>(await store.get(userIndex(userId))) ?? [];
  const due = Date.now() - VERIFY_MS - 1;
  await Promise.all(
    keys.map(async (k) => {
      recent.delete(k);
      // Due a check, but still verified recently enough for the grace window (not 0).
      await update(k, (cur) => (cur.verifiedAt <= due ? null : { ...cur, verifiedAt: due }));
    }),
  );
  return keys.length;
}

type CookieLife = Pick<SessionRecord, 'expiresAt' | 'persistent'>;

/** A remembered session's cookies last as long as it may; the others end with the browser. */
const lifeOf = (rec: CookieLife) => (rec.persistent === false ? {} : { maxAge: Math.max(0, Math.floor(ttlOf(rec) / 1000)) });

function writeHint(cookies: AstroCookies, rec: CookieLife) {
  // Readable by page scripts on purpose (lib/session-hint.ts); it says only that a session exists.
  cookies.set(hintName(), '1', {
    httpOnly: false,
    sameSite: 'lax',
    secure: secureCookies(),
    path: '/',
    ...lifeOf(rec),
  });
}

function writeCookie(cookies: AstroCookies, sid: string, rec: SessionRecord) {
  cookies.set(cookieName(), sid, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(),
    path: '/',
    ...lifeOf(rec),
  });
  writeHint(cookies, rec);
}

/**
 * Adds the hint to a signed-in response whose request came without it: sessions from before the
 * hint existed, or a browser that dropped it. Reader pages probe once for such sessions
 * (lib/session-hint.ts), and this is what that probe gets back.
 */
function keepHint(cookies: AstroCookies, rec: CookieLife) {
  if (!cookies.has(hintName())) writeHint(cookies, rec);
}

function clearHint(cookies: AstroCookies) {
  if (cookies.has(hintName())) cookies.delete(hintName(), { path: '/', secure: secureCookies() });
}

function clearCookie(cookies: AstroCookies) {
  if (cookies.has(cookieName())) cookies.delete(cookieName(), { path: '/', secure: secureCookies() });
  clearHint(cookies);
}

function readSid(cookies: AstroCookies): string | null {
  const v = cookies.get(cookieName())?.value;
  if (!v) {
    clearHint(cookies); // the session cookie expired or was dropped first
    return null;
  }
  if (!SID.test(v)) {
    clearCookie(cookies); // e.g. a JWT cookie from before web-owned sessions
    return null;
  }
  return v;
}

export type StrapiAuth = { jwt?: string; refreshToken?: string; user: Reader & { confirmed?: boolean } };

/**
 * Starts a session for a Strapi sign-in response and sets the cookie. With `remember: false` ("Remember
 * me" unticked) the cookies end with the browser and the session within a day.
 */
export async function startSession(cookies: AstroCookies, auth: StrapiAuth & { jwt: string }, { remember = true }: { remember?: boolean } = {}) {
  const now = Date.now();
  const jwtExp = jwtExpiry(auth.jwt);
  const rec: SessionRecord = {
    user: pickReader(auth.user),
    jwt: auth.jwt,
    jwtExp,
    refreshToken: auth.refreshToken ?? null,
    createdAt: now,
    expiresAt: Math.min(auth.refreshToken ? now + MAX_MS : Math.min(now + MAX_MS, jwtExp), remember ? Infinity : now + BROWSER_MS),
    verifiedAt: now,
    ...(remember ? {} : { persistent: false }),
  };
  const sid = randomBytes(32).toString('base64url');
  const key = storeKey(sid);
  await save(key, rec);
  await indexSession(rec.user.id, key).catch((err) => {
    console.error('[session] could not index the session:', (err as Error).message);
  });
  writeCookie(cookies, sid, rec);
  return rec.user;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rotate(key: string, rec: SessionRecord): Promise<SessionRecord | null> {
  const store = await getStore();
  const lock = `lock:${key}`;
  const locked = await store.setNx(lock, '1', LOCK_MS);
  if (!locked) {
    // Another instance is rotating this session's token; use its result.
    for (let waited = 0; waited < LOCK_MS; waited += 200) {
      await sleep(200);
      const cur = await load(key);
      if (!cur) return null;
      if (cur.refreshToken !== rec.refreshToken) return cur;
    }
  }
  try {
    if (locked) {
      // Our copy may already be out of date: a rotation that finished before we took the lock.
      const cur = await load(key);
      if (!cur) return null;
      if (cur.refreshToken !== rec.refreshToken) return cur;
    }
    const out = await authFetch<{ jwt?: string; refreshToken?: string }>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: rec.refreshToken }),
    });
    if (!out.jwt) return null;
    const jwt = out.jwt;
    // Store the new pair only over the token we rotated; a newer one written meanwhile wins.
    return await update(key, (cur) =>
      cur.refreshToken === rec.refreshToken
        ? { ...cur, jwt, jwtExp: jwtExpiry(jwt), refreshToken: out.refreshToken ?? cur.refreshToken }
        : null,
    );
  } catch (err) {
    if (err instanceof StrapiError && (err.status === 400 || err.status === 401)) {
      // A rotation that raced ours may already have stored a newer token.
      const cur = await load(key);
      return cur && cur.refreshToken !== rec.refreshToken ? cur : null;
    }
    throw err;
  } finally {
    if (locked) await store.del(lock).catch(() => {});
  }
}

/** Gets a new access token for the session (deduplicated per process), or null if it's over. */
function refresh(key: string, rec: SessionRecord): Promise<SessionRecord | null> {
  if (!rec.refreshToken) return Promise.resolve(null);
  let p = refreshing.get(key);
  if (!p) {
    p = rotate(key, rec).finally(() => refreshing.delete(key));
    refreshing.set(key, p);
  }
  return p;
}

/** verify(), deduplicated per session within this process. */
function verifyOnce(key: string, rec: SessionRecord): Promise<SessionRecord | null> {
  let p = verifying.get(key);
  if (!p) {
    p = verify(key, rec).finally(() => verifying.delete(key));
    verifying.set(key, p);
  }
  return p;
}

/** Confirms the reader with Strapi, refreshing the access token when needed. Null: signed out. */
async function verify(key: string, rec: SessionRecord): Promise<SessionRecord | null> {
  let cur = rec;
  let refreshed = false;
  if (cur.jwtExp - Date.now() < REFRESH_EARLY_MS) {
    const next = await refresh(key, cur);
    if (!next) return null;
    cur = next;
    refreshed = true;
  }
  for (;;) {
    try {
      const me = await userFetch<Reader>('/users/me', {}, cur.jwt);
      // Merge into the latest record rather than writing back our copy, whose tokens another
      // request may have rotated since.
      return await update(key, (latest) => ({ ...latest, user: pickReader(me), verifiedAt: Date.now() }));
    } catch (err) {
      if (!(err instanceof StrapiError) || (err.status !== 401 && err.status !== 403)) throw err;
      if (refreshed) return null; // blocked, deleted, or the session was revoked
      const next = await refresh(key, cur);
      if (!next) return null;
      cur = next;
      refreshed = true;
    }
  }
}

type ReadOptions = {
  /**
   * The longest to wait on Strapi when the reader is due a re-check. A recently verified reader
   * (the grace window) is answered from the store once it runs out, while the check finishes in
   * the background; anyone else gets the DeadlineExceeded. Unset: wait for the check.
   */
  waitMs?: number;
};

async function current(cookies: AstroCookies, fresh: boolean, { waitMs }: ReadOptions = {}) {
  const sid = readSid(cookies);
  if (!sid) return null;
  const key = storeKey(sid);
  if (!fresh) {
    const hit = recent.get(key);
    if (hit) {
      keepHint(cookies, hit);
      return { key, reader: hit.reader, rec: null };
    }
  }
  const rec = await load(key);
  if (!rec) {
    clearCookie(cookies);
    return null;
  }
  const stale = Date.now() - rec.verifiedAt > VERIFY_MS || rec.jwtExp - Date.now() < REFRESH_EARLY_MS;
  if (!stale && !fresh) {
    recent.set(key, { reader: rec.user, expiresAt: rec.expiresAt, persistent: rec.persistent });
    keepHint(cookies, rec);
    return { key, reader: rec.user, rec };
  }
  let next: SessionRecord | null;
  try {
    const check = stale ? verifyOnce(key, rec) : Promise.resolve(rec);
    // The background check never touches this request's cookies, which may be sent by then.
    next = waitMs === undefined ? await check : await within(check, waitMs, 'the session check');
  } catch (err) {
    // Strapi is unreachable: a recently verified reader stays signed in for now.
    if (!fresh && Date.now() - rec.verifiedAt < GRACE_MS) {
      keepHint(cookies, rec);
      return { key, reader: rec.user, rec };
    }
    throw err;
  }
  if (!next) {
    recent.delete(key);
    await (await getStore()).del(key);
    clearCookie(cookies);
    return null;
  }
  if (next.jwt !== rec.jwt) writeCookie(cookies, sid, next); // slide the cookie with the session
  else keepHint(cookies, next);
  recent.set(key, { reader: next.user, expiresAt: next.expiresAt, persistent: next.persistent });
  return { key, reader: next.user, rec: next };
}

/**
 * The signed-in reader, or null. Checks the reader with Strapi at most once a minute and
 * refreshes the access token as needed; throws only when the store or Strapi is unavailable
 * (or, with `waitMs`, too slow for a reader outside the grace window).
 */
export async function getReader(cookies: AstroCookies, opts: ReadOptions = {}): Promise<Reader | null> {
  return (await current(cookies, false, opts))?.reader ?? null;
}

/** The reader plus a currently valid Strapi access token, for acting as them in Strapi. */
export async function getReaderAuth(cookies: AstroCookies): Promise<{ reader: Reader; jwt: string } | null> {
  const s = await current(cookies, true);
  return s?.rec ? { reader: s.reader, jwt: s.rec.jwt } : null;
}

async function revoke(rec: SessionRecord, everywhere: boolean) {
  if (!rec.refreshToken) return; // legacy JWTs can't be revoked individually
  let { jwt, refreshToken } = rec;
  if (rec.jwtExp - Date.now() < 5_000) {
    const out = await authFetch<{ jwt?: string }>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
    if (!out.jwt) return;
    jwt = out.jwt;
    refreshToken = out.refreshToken ?? refreshToken;
  }
  await userFetch(
    '/auth/logout',
    { method: 'POST', body: JSON.stringify(everywhere ? { scope: 'all' } : { refreshToken }) },
    jwt,
  );
}

/** Signs the reader out: deletes the session, revokes it in Strapi and clears the cookie. */
export async function endSession(cookies: AstroCookies, { everywhere = false } = {}) {
  const sid = readSid(cookies);
  clearCookie(cookies);
  if (!sid) return;
  const key = storeKey(sid);
  recent.delete(key);
  const store = await getStore();
  const rec = await load(key);
  await store.del(key);
  if (!rec) return;
  if (everywhere) await endUserSessions(rec.user.id).catch(() => {});
  try {
    await revoke(rec, everywhere);
  } catch (err) {
    // The refresh session is already unusable from here; Strapi expires it on its own.
    if (!(err instanceof StrapiError && (err.status === 400 || err.status === 401))) {
      console.error('[session] Strapi logout failed:', (err as Error).message);
    }
  }
}
