// @ts-check
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';

import node from '@astrojs/node';
import react from '@astrojs/react';

import { contentSnapshot, snapshotPaths } from './src/lib/content-snapshot.node.ts';
import { uiLocaleDefine } from './src/i18n/locales.ts';
import { pageCsp, roomCsp, securityHeaders } from './src/lib/server/security-headers.ts';
import { ASSETS_DIR, OWNED } from './routes.mjs';

const appDir = fileURLToPath(new URL('.', import.meta.url));

const env = { ...loadEnv(process.env.NODE_ENV ?? 'production', appDir, ''), ...process.env };
const publicOrigin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN) : null;
const originOf = (/** @type {string | undefined} */ u) => (u && URL.canParse(u) ? new URL(u).origin : null);

// lego-ai serves only part of the site (routes.mjs); the main site (lego/web) serves the rest from
// the same origin. In production the load balancer routes by path; built assets are under /_ai/
// (build.assets below) so they don't collide with the main site's /_astro/.

// In dev this server is the front door (http://localhost:4322): it serves its own routes and Vite's
// modules, and proxies everything else (sign-in, the header's links, /api/auth/me, fonts) to the main
// site's dev server. Session cookies on localhost ignore the port, so a reader signed in on either
// is signed in on both.
const webDevUrl = env.WEB_DEV_URL || 'http://localhost:4321';
const OWNED_IN_DEV = [
  ...OWNED,
  String.raw`api/(?:health|ready)(?:[?#]|$)`,
  // Vite and Astro's own dev modules, and the favicons in public/
  '@',
  'src/',
  'node_modules/',
  String.raw`\.astro/`,
  '__',
  '_image',
  'favicon',
  'apple-touch-icon',
  String.raw`site\.webmanifest`,
];
const proxyToWeb = `^/(?!${OWNED_IN_DEV.join('|')}).*`;

/**
 * Writes the security headers for the prerendered pages to dist/_headers.json, which the Node
 * adapter applies when serving them (staticHeaders). Every page here is the interview room, so with
 * the board or voice built in every page gets the room's policy: the whiteboard's worker
 * (docs/README.md, "Whiteboard") and, in a voice build, Daily's hosts and the microphone
 * (docs/privacy.md, "Permissions-Policy and CSP").
 * @returns {import('astro').AstroIntegration}
 */
function staticSecurityHeaders() {
  /** @type {URL} */
  let outDir;
  return {
    name: 'lego-ai:static-security-headers',
    hooks: {
      'astro:config:done': ({ config }) => {
        outDir = config.outDir;
        if (config.security?.csp) {
          throw new Error('security.csp must stay off: static CSP/HSTS headers come from lego-ai:static-security-headers.');
        }
      },
      'astro:build:done': async ({ dir }) => {
        const root = fileURLToPath(dir);
        const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.html'));
        const hashes = new Set();
        const paths = new Set();
        for (const file of files) {
          const html = await readFile(`${root}/${file}`, 'utf8');
          for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
            if (/\ssrc=/.test(attrs) || /type=["']?application\/(ld\+)?json/.test(attrs) || !body) continue;
            hashes.add(`sha256-${createHash('sha256').update(body).digest('base64')}`);
          }
          const page = `/${file.replace(/\\/g, '/')}`;
          const route = page.replace(/\/?index\.html$/, '').replace(/\.html$/, '') || '/';
          for (const p of [page, route, route === '/' ? '/' : `${route}/`]) paths.add(p);
        }
        const policy = { scriptHashes: [...hashes], imageOrigins: [originOf(env.PUBLIC_MEDIA_URL)].filter((o) => o !== null) };
        // Browser error reports (src/lib/report.ts) go straight to Sentry's ingest host.
        const sentryOrigin = originOf(env.PUBLIC_SENTRY_DSN);
        const withSentry = (/** @type {string} */ csp) => (sentryOrigin ? csp.replace("connect-src 'self'", `connect-src 'self' ${sentryOrigin}`) : csp);
        const voice = env.PUBLIC_INTERVIEW_VOICE_ENABLED === 'true';
        const board = env.PUBLIC_INTERVIEW_BOARD_ENABLED === 'true';
        const options = { hsts: publicOrigin?.protocol === 'https:', reportOnly: env.CSP_REPORT_ONLY === 'true' };
        // Without the board or voice the room needs nothing beyond the site's own policy.
        const headers = board || voice ? securityHeaders(withSentry(roomCsp({ ...policy, voice })), { ...options, microphone: voice }) : securityHeaders(withSentry(pageCsp(policy)), options);
        const file = new URL('_headers.json', outDir);
        /** @type {Map<string, Map<string, string>>} */
        const byPath = new Map();
        if (existsSync(file)) {
          for (const e of JSON.parse(await readFile(file, 'utf8'))) {
            byPath.set(e.pathname, new Map(e.headers.map((/** @type {{key: string, value: string}} */ h) => [h.key, h.value])));
          }
        }
        for (const p of paths) {
          const merged = byPath.get(p) ?? new Map();
          for (const [k, v] of Object.entries(headers)) merged.set(k, v);
          byPath.set(p, merged);
        }
        const entries = [...byPath].map(([pathname, h]) => ({
          pathname,
          headers: [...h].map(([key, value]) => ({ key, value })),
        }));
        await writeFile(file, JSON.stringify(entries));
      },
    },
  };
}

// The interview pages are prerendered from the content snapshot, which lego-ai:content-snapshot
// writes from lego's content/ (CONTENT_DIR, default ../../lego/content) before every build and dev
// server start (src/lib/content-snapshot.node.ts). The /api/* routes run on the Node server.
export default defineConfig({
  site: publicOrigin?.origin ?? 'http://localhost:4322',
  server: { port: 4322 },
  integrations: [contentSnapshot(snapshotPaths(appDir)), react(), staticSecurityHeaders()],
  adapter: node({
    mode: 'standalone',
    // As on the main site; the routes cap their own bodies below it (a board, its PNG).
    bodySizeLimit: 256 * 1024,
    staticHeaders: true,
  }),
  build: { assets: ASSETS_DIR },
  security: {
    // Same-origin checks run in src/middleware.ts against PUBLIC_ORIGIN, for every content type.
    checkOrigin: false,
    // Trust X-Forwarded-Host/Proto only for the public host, so Astro.url matches it behind a
    // TLS-terminating proxy. Read at build time: set PUBLIC_ORIGIN when building for a deploy.
    allowedDomains: publicOrigin
      ? [{ protocol: publicOrigin.protocol.slice(0, -1), hostname: publicOrigin.hostname, ...(publicOrigin.port ? { port: publicOrigin.port } : {}) }]
      : [],
  },
  vite: {
    optimizeDeps: { include: ['@sentry/browser'] },
    // Excalidraw loads @excalidraw/mermaid-to-excalidraw for its "Mermaid to Excalidraw" dialog:
    // mermaid and its renderers, about 1.5 MB gzipped that the room otherwise doesn't ship. A
    // stand-in that explains itself takes its place (src/lib/board/no-mermaid.ts).
    resolve: { alias: { '@excalidraw/mermaid-to-excalidraw': fileURLToPath(new URL('./src/lib/board/no-mermaid.ts', import.meta.url)) } },
    server: { proxy: { [proxyToWeb]: { target: webDevUrl, changeOrigin: false } } },
    // The interface locale (docs/i18n.md in lego): `en`, or `en-XA` for the pseudo-locale.
    define: uiLocaleDefine(env.PUBLIC_UI_LOCALE),
  },
});
