import { signInHref } from './safe-next';

// Whether this browser looks signed in, for the public pages' links into topics (topic pages are
// for signed-in readers: lib/gated.ts). A signed-out reader is offered "Sign in to …" links to
// /signin?next=<topic>, never a link that bounces off the gate.
//
// The answer comes from the signed-in hint cookie (lib/session-hint.ts), read by an inline head
// script before the first paint, which sets <html data-auth="in|out">: the labels switch in CSS
// (`.when-signed-in` / `.when-signed-out`, `.auth-swap` in site.css), so nothing flashes or moves.
// The hint proves nothing: pages confirm it with the server and, when the session turns out to be
// over, call markSignedOut(), which switches the page to the signed-out links.

export type AuthState = 'in' | 'out';

/** The signed-in hint in a Cookie header or document.cookie (`__Host-` prefixed over https). */
export const HINT = /(?:^|;\s*)(?:__Host-)?sd_signed_in=1(?:;|$)/;

/** Dispatched on document when the state changes (use-auth-state.ts listens). */
export const AUTH_EVENT = 'arrowbox:auth';

/** The inline head script (AppLayout.astro); the build hashes it into the pages' CSP. */
export const AUTH_HEAD_SCRIPT = `document.documentElement.dataset.auth=${HINT.toString()}.test(document.cookie)?"in":"out"`;

/** The page's state, as the head script (or markSignedOut) left it. */
export function authState(root: HTMLElement = document.documentElement, cookie = document.cookie): AuthState {
  const v = root.dataset.auth;
  if (v === 'in' || v === 'out') return v;
  return HINT.test(cookie) ? 'in' : 'out';
}

/** The session is over (the server said so): show the signed-out links from now on. */
export function markSignedOut(root: HTMLElement = document.documentElement) {
  if (root.dataset.auth === 'out') return;
  root.dataset.auth = 'out';
  document.dispatchEvent(new CustomEvent(AUTH_EVENT));
}

/** Where a link into a topic goes: the topic, or sign-in and back to it (never for a public topic, `open`). */
export const topicLink = (path: string, state: AuthState | null, open = false) => (state === 'out' && !open ? signInHref(path) : path);

/**
 * Static pages: points every `a[data-topic-link]` (its value is the topic's path) at the topic or
 * at sign-in, now and whenever the state changes. Returns how many links it found.
 */
export function wireTopicLinks(root: ParentNode = document): number {
  const links = [...root.querySelectorAll<HTMLAnchorElement>('a[data-topic-link]')];
  const apply = () => {
    const state = authState();
    for (const a of links) a.href = topicLink(a.dataset.topicLink!, state);
  };
  apply();
  if (links.length) document.addEventListener(AUTH_EVENT, apply);
  return links.length;
}

/**
 * Confirms a hinted session with the server once (static pages with topic links): a signed-out
 * answer switches the page to the sign-in links. A failed check changes nothing.
 */
export async function confirmSession(): Promise<void> {
  if (authState() !== 'in') return;
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok) return;
    const body = (await r.json()) as { user: unknown };
    if (body.user === null) markSignedOut();
  } catch {
    /* offline: keep the hint's answer */
  }
}
