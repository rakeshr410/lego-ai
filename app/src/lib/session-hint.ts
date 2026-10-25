import type { SessionInfo } from '../pages/api/session';
import { HINT } from './auth-state';
import { localDay } from './learner';

// The signed-in hint: a cookie readable by page scripts that says "this browser has a session",
// set and cleared with the HttpOnly session cookie (lib/server/session.ts). It holds nothing but
// "1" and grants nothing; the session cookie alone authenticates. Reader pages are static, so
// the hint is how they know, without a request, that there's a reader to ask /api/session about:
// anonymous readers make no API call. A stale hint costs one call, which clears it.
//
// Sessions started before the hint existed have no hint, and nothing else on a static page would
// ever ask the server about them. Until PROBE_UNTIL, a browser without the hint asks
// /api/session once (the server adds the hint to any signed-in answer) and then remembers in
// localStorage that it has been checked, so an anonymous reader pays one call per browser, once,
// not one per view. Sessions last at most 30 days, so the probe has nothing left to find 30 days
// after the first release with the hint: that release must ship by PROBE_UNTIL minus 30 days
// (move the date otherwise), and the probe can be deleted after PROBE_UNTIL (docs/deploy.md).

/** Cookie name; `__Host-` prefixed when cookies are Secure, like the session cookie. */
export const SESSION_HINT = 'sd_signed_in';

/** Whether a Cookie header (or document.cookie) carries the signed-in hint. */
export const hasSessionHint = (cookie: string): boolean => HINT.test(cookie);

export const ANONYMOUS: SessionInfo = { signedIn: false, user: null, ask: null, noteCount: null, progress: null };
const UNKNOWN: SessionInfo = { signedIn: null, user: null, ask: null, noteCount: null, progress: null, degraded: true };

/** End of the one-off probe for sessions from before the hint (see above). */
export const PROBE_UNTIL = Date.parse('2027-01-31T00:00:00Z');
/** localStorage: this browser has been checked for a session without the hint. */
export const PROBE_KEY = 'sd-session-checked';

/** Whether this browser still needs the one-off check; false when storage can't remember it. */
function needsProbe(storage: () => Storage): boolean {
  if (Date.now() >= PROBE_UNTIL) return false;
  try {
    return storage().getItem(PROBE_KEY) === null;
  } catch {
    return false; // couldn't remember having checked: never probe rather than probe every view
  }
}

function markChecked(storage: () => Storage) {
  try {
    storage().setItem(PROBE_KEY, '1');
  } catch {
    /* storage unavailable: needsProbe says no anyway */
  }
}

/**
 * The reader page's session: no request at all without the hint cookie (after the browser's
 * one-off probe, above); otherwise one call to /api/session for this topic. A failed call reads
 * as "unknown" (signedIn null), never as signed out, so an outage doesn't offer a signed-in
 * reader the sign-in link. A failed probe reads as anonymous and is tried again next view.
 */
export async function loadSession(
  system: string,
  topic: string,
  cookie = document.cookie,
  storage: () => Storage = () => localStorage,
  today = localDay(),
): Promise<SessionInfo> {
  const hinted = hasSessionHint(cookie);
  if (!hinted && !needsProbe(storage)) return ANONYMOUS;
  let info: SessionInfo;
  try {
    const q = new URLSearchParams({ system, topic, today });
    const r = await fetch(`/api/session?${q}`);
    if (!r.ok) return hinted ? UNKNOWN : ANONYMOUS;
    info = (await r.json()) as SessionInfo;
  } catch {
    return hinted ? UNKNOWN : ANONYMOUS;
  }
  // Answered, so from now on the hint alone says whether there is a session. A degraded answer
  // to the probe means a session cookie the server couldn't check yet: ask again next view.
  if (hinted || info.signedIn !== null) markChecked(storage);
  return info;
}
