// The paths this app serves on the shared origin; the main site (lego/web) serves everything else.
// One list for every router in front of the two: the production load balancer's rules
// (lego/infra/lib/app-stack.ts, "lego-ai"), scripts/edge.mjs (docker compose, e2e) and the dev
// server's proxy (astro.config.mjs). Keep them in step when a route is added.

/** The built assets' folder (astro.config.mjs build.assets); the main site's are under /_astro/. */
export const ASSETS_DIR = '_ai';

/** Regular expression sources, each matched against the start of a path (after its leading slash). */
export const OWNED = [
  // The landing page, the room and the coach (prerendered)
  String.raw`systems/[^/]+/interview(?:[/?#]|$)`,
  // The coaching playlists and their lessons (prerendered; docs/coaching.md)
  String.raw`coach(?:[/?#]|$)`,
  // The reader's API, and the voice service's (private network only: the load balancer leaves it out)
  String.raw`api/(?:internal/)?interview(?:[/?#]|$)`,
  `${ASSETS_DIR}/`,
  // The whiteboard's fonts (scripts/copy-excalidraw.mjs)
  'excalidraw/',
];

const ownedRe = new RegExp(`^/(?:${OWNED.join('|')})`);

/** Whether a request path (with or without its query) belongs to this app. */
export const owns = (/** @type {string} */ path) => ownedRe.test(path);
