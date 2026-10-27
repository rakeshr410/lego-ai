import { signInHref } from './safe-next';

// Whether this browser looks signed in, as the site's shell has it on the page the modules mount in
// (lego/site-shell auth.ts: the hint cookie, <html data-auth>, and `auth.changed` on the page's bus
// when it changes). The modules only read it, and offer sign-in links to a signed-out reader.

export { authState, markSignedOut, type AuthState } from '../../../../lego/site-shell/src/auth';
import type { AuthState } from '../../../../lego/site-shell/src/auth';

/** Where a link into a topic goes: the topic, or sign-in and back to it (never for a public topic, `open`). */
export const topicLink = (path: string, state: AuthState | null, open = false) => (state === 'out' && !open ? signInHref(path) : path);
