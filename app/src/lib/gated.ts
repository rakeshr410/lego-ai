// Topic pages are for signed-in readers (docs/architecture.md, "Signed-in topic pages"). They are
// still prerendered, but the build moves their HTML out of dist/client, where the Node adapter's
// static handler (and a CDN bucket) would serve it to anyone, into dist/server/gated/. The web
// server serves it from there after checking the session (lib/server/gate.ts). This module is the
// contract between the build step (lib/gated-build.node.ts) and the server.

/** Directory under dist/server that holds the gated pages, laid out as they were in dist/client. */
export const GATED_DIR = 'gated';
/** The manifest in GATED_DIR: which paths are gated, and the headers the build wrote for them. */
export const GATED_MANIFEST = 'manifest.json';
/** The route whose pages are gated: every topic page. */
export const GATED_ROUTE = '/systems/[system]/[topic]';
/** A system's read page (all its topics in one scroll): gated like a topic page, at /systems/<system>/read. */
export const READ_ROUTE = '/systems/[system]/read';
/** Its Free variant: built for a system with a topic the Free plan doesn't open in full (pages/v/free/[system]/read.astro). */
export const FREE_READ_ROUTE = '/v/free/[system]/read';
/** Whether a gated page's topic (topicOfKey) is a system's read page rather than a topic: "<system>/read". */
export const isReadKey = (topic: string) => topic.endsWith('/read');
/**
 * The Free variants of the topic pages (Phase 4, lib/free-tier.ts): built only with PUBLIC_BILLING,
 * for each topic a Free reader doesn't get in full, gated like the topics and never served at
 * their own path: the gate answers a topic's path with its Free variant when the reader's plan
 * doesn't read it in full (lib/server/gate.ts).
 */
export const FREE_ROUTE = '/v/free/[system]/[topic]';
/** Where the Free variant of a topic page is built, under dist/client (FREE_ROUTE). */
export const FREE_PREFIX = 'v/free/';
/**
 * Routes prerendered as variants of a public page (docs/phase-4-design.md §2.2): the server picks
 * one per request (the pricing page by region: lib/server/pricing-page.ts), so no variant may be
 * served at its own path. They move out of dist/client with the gated pages.
 */
export const VARIANT_ROUTES = ['/v/pricing/[region]'];
/**
 * The checkout pages (Phase 4, docs/phase-4-design.md §2.2, §7.3): every route under this prefix
 * (pages/v/checkout/…) is built only with PUBLIC_BILLING, gated like the topics, and served at its
 * public path without the /v (/v/checkout is /checkout, /v/checkout/processing is
 * /checkout/processing) with the checkout header profile: a CSP of its own that allows Razorpay's
 * pop-up and nothing else from elsewhere (lib/server/security-headers.ts, checkoutHeaders).
 */
export const CHECKOUT_PREFIX = '/v/checkout';

export type GatedManifest = {
  version: 1;
  /** The security headers (CSP with the pages' inline-script hashes, HSTS...) for every gated page. */
  headers: Record<string, string>;
  /** URL path (no trailing slash) → the file under GATED_DIR, e.g. "systems/a/b/index.html". */
  pages: Record<string, string>;
  /**
   * A topic's URL path → the file of its Free variant, e.g. "v/free/a/b/index.html": only for the
   * topics a Free reader doesn't get in full, and only in a build with PUBLIC_BILLING.
   */
  free?: Record<string, string>;
  /**
   * A variant's own path (VARIANT_ROUTES, e.g. "/v/pricing/in") → its file under GATED_DIR. Served
   * only as the answer to its public route, with the same headers; absent from older manifests.
   */
  variants?: Record<string, string>;
  /**
   * The checkout pages (CHECKOUT_PREFIX), in a build with PUBLIC_BILLING: their headers (the
   * checkout profile) and public path → file, e.g. "/checkout" → "v/checkout/index.html".
   */
  checkout?: { headers: Record<string, string>; pages: Record<string, string> };
};

/** The manifest key for a request path: no trailing slash, no `index.html`. */
export const gatedKey = (pathname: string) => pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '') || '/';

/** The topic (`<system>/<topic>`) a gated page's key is for, e.g. "a/b" for "/systems/a/b"; null for any other key. */
export const topicOfKey = (key: string) => /^\/systems\/([^/]+\/[^/]+)$/.exec(key)?.[1] ?? null;
/** A checkout page's public path from its built one: "/v/checkout" is "/checkout". */
export const checkoutKey = (builtKey: string) => builtKey.replace(/^\/v(?=\/checkout(\/|$))/, '');
