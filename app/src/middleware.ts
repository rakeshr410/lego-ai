import { defineMiddleware, sequence } from 'astro:middleware';
import { assertProductionConfig, secureCookies, serverEnv } from './lib/server/env';
import { MAX_BODY_BYTES, NO_STORE, isSameOrigin, json } from './lib/server/http';
import { captureServerError, requestIdFrom, requestLogger } from './lib/server/log';
import { API_CSP, securityHeaders } from './lib/server/security-headers';

// Runs for on-demand routes (the /api/* endpoints). The interview pages are prerendered, so their
// headers are written at build time instead (see astro.config.mjs). The same handlers as the main
// site's middleware (lego/web/src/middleware.ts), less its topic gate and pricing.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Security headers on every server response, and no caching of API responses. */
const headers = defineMiddleware(async (ctx, next) => {
  if (ctx.isPrerendered) return next();
  const res = await next();
  const set = securityHeaders(API_CSP, {
    hsts: import.meta.env.PROD && secureCookies(),
    reportOnly: serverEnv().CSP_REPORT_ONLY,
  });
  let out = res;
  try {
    for (const [k, v] of Object.entries(set)) if (!out.headers.has(k)) out.headers.set(k, v);
  } catch {
    // Immutable headers (e.g. Response.redirect): copy the response first.
    out = new Response(res.body, res);
    for (const [k, v] of Object.entries(set)) if (!out.headers.has(k)) out.headers.set(k, v);
  }
  if (!out.headers.has('Cache-Control')) out.headers.set('Cache-Control', NO_STORE);
  return out;
});

/** Same-origin check and body-size cap for every state-changing request. */
const guard = defineMiddleware((ctx, next) => {
  if (ctx.isPrerendered) return next();
  assertProductionConfig();
  if (!SAFE_METHODS.has(ctx.request.method)) {
    if (!isSameOrigin(ctx.request, ctx.url)) return json({ error: 'Forbidden' }, 403);
    const length = Number(ctx.request.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) return json({ error: 'Request too large.' }, 413);
  }
  return next();
});

// Probes hit these every few seconds; their successes are logged at debug level only.
const PROBES = new Set(['/api/health', '/api/ready']);

/**
 * Request id and access log. First in the sequence so its log line and X-Request-Id cover the
 * other handlers' responses too (403s, 413s). One line per API request.
 */
const observe = defineMiddleware(async (ctx, next) => {
  if (ctx.isPrerendered) return next();
  const requestId = requestIdFrom(ctx.request.headers);
  const log = requestLogger(requestId);
  ctx.locals.requestId = requestId;
  ctx.locals.log = log;
  const path = ctx.url.pathname;
  const start = performance.now();
  const line = (status: number) => ({
    method: ctx.request.method,
    path, // never the query string
    route: ctx.routePattern,
    status,
    ms: Math.round(performance.now() - start),
  });
  let res: Response;
  try {
    res = await next();
  } catch (err) {
    captureServerError(err, { requestId, route: ctx.routePattern, method: ctx.request.method });
    log.error({ ...line(500), err }, 'request failed');
    throw err;
  }
  const level = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : PROBES.has(path) ? 'debug' : 'info';
  log[level](line(res.status), 'request');
  try {
    res.headers.set('X-Request-Id', requestId);
    return res;
  } catch {
    // Immutable headers (e.g. Response.redirect): copy the response first.
    const out = new Response(res.body, res);
    out.headers.set('X-Request-Id', requestId);
    return out;
  }
});

export const onRequest = sequence(observe, headers, guard);
