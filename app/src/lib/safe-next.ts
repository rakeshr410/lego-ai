// Where sign-in sends the reader afterwards (the `next` parameter), shared by the sign-in form,
// the topic gate (lib/server/gate.ts) and the links that lead anonymous readers to sign in. Only a
// path on this site survives: anything that could leave it (`//host`, `/\host`, a scheme, control
// characters that browsers strip before resolving) falls back to the library.

import { LIBRARY_PATH } from './routes';

export const NEXT_FALLBACK = LIBRARY_PATH;

/**
 * `raw` as a same-origin path (path, query and fragment), or `fallback`. `origin` is the site's
 * own origin (window.location.origin in the browser).
 */
export function safeNext(raw: string | null | undefined, origin: string, fallback = NEXT_FALLBACK): string {
  // eslint-disable-next-line no-control-regex -- rejects control characters in a redirect target
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\u0000-\u001F\u007F\\]/.test(raw)) return fallback;
  try {
    const base = new URL(origin);
    const u = new URL(raw, base);
    return u.origin === base.origin ? u.pathname + u.search + u.hash : fallback;
  } catch {
    return fallback;
  }
}

/** The sign-in page, returning to `path` (a same-origin path) afterwards. */
export const signInHref = (path: string) => `/signin?next=${encodeURIComponent(path)}`;
