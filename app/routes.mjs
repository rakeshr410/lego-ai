// The paths this app serves on the shared origin; the main site (lego/web) serves everything else.
// One list for every router in front of the two: the production load balancer's rules
// (lego/infra/lib/app-stack.ts, "lego-ai"), scripts/edge.mjs (docker compose, e2e) and the dev
// server's proxy (astro.config.mjs). Keep them in step when a route is added.

/** The built assets' folder (astro.config.mjs build.assets); the main site's are under /_astro/. */
export const ASSETS_DIR = '_ai';

/** Regular expression sources, each matched against the start of a path (after its leading slash). */
// No pages: the interview's and the coach's (/systems/<system>/interview, /coach/…) are the main
// site's, which mounts this app's modules in them (src/remote/, served under ASSETS_DIR) from what
// /api/interview/page says.
export const OWNED = [
  // The reader's API (the modules' and the shell's), and the voice service's (private network only: the load balancer leaves it out)
  String.raw`api/(?:internal/)?interview(?:[/?#]|$)`,
  `${ASSETS_DIR}/`,
  // The whiteboard's fonts (scripts/copy-excalidraw.mjs)
  'excalidraw/',
];

const ownedRe = new RegExp(`^/(?:${OWNED.join('|')})`);

/** Whether a request path (with or without its query) belongs to this app. */
export const owns = (/** @type {string} */ path) => ownedRe.test(path);
