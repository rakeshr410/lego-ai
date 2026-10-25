import type { APIContext } from 'astro';
import { env, publicOrigin, trustProxyHops } from './env';
import t from '../../i18n/messages/api';

// Request and response helpers shared by every API route.

export const NO_STORE = 'private, no-store';

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': NO_STORE, ...headers },
  });

export const tooMany = (retryAfter: number, error = t('limit.default')) =>
  json({ error }, 429, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfter))) });

/**
 * The largest JSON body any route accepts. Notes carry up to 50,000 characters of HTML, which
 * in UTF-8 plus JSON escaping can pass 128 KB; the Node adapter itself stops at 256 KB.
 */
export const MAX_BODY_BYTES = 200 * 1024;

export class BodyTooLarge extends Error {}

/** Reads a request body as text, refusing more than maxBytes (checked before and while reading). */
export async function readBodyText(request: Request, maxBytes = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Parses a JSON object body, returning null for anything else (or for an oversized body). */
export async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (!request.headers.get('content-type')?.includes('application/json')) return null;
  try {
    const body: unknown = JSON.parse(await readBodyText(request, maxBytes));
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The origin browsers use for this site: PUBLIC_ORIGIN, or the request's own origin in dev. */
export function siteOrigin(url: URL): string {
  return publicOrigin()?.origin ?? url.origin;
}

/**
 * Rejects cross-site form/JS posts: state-changing requests must come from this origin.
 * Requests with no Origin header (curl, server-to-server) pass; browsers always send one.
 */
export function isSameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return request.headers.get('sec-fetch-site') !== 'cross-site';
  return origin === siteOrigin(url);
}

let warnedUntrusted = false;

/**
 * The client's IP for rate limiting. Behind proxies, set TRUST_PROXY to the number of proxies
 * that append to X-Forwarded-For (the right-most entries), or CLIENT_IP_HEADER to a header the
 * edge overwrites (e.g. cf-connecting-ip); production refuses to start with neither. The
 * left-most X-Forwarded-For value is client-chosen and never used.
 */
export function clientIp(ctx: Pick<APIContext, 'request' | 'clientAddress'>): string {
  const header = env('CLIENT_IP_HEADER');
  if (header) {
    const v = ctx.request.headers.get(header)?.split(',')[0]?.trim();
    if (v) return v;
  }
  const xff = ctx.request.headers.get('x-forwarded-for');
  const hops = trustProxyHops();
  if (hops > 0) {
    const chain = (xff ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Fewer entries than hops: every entry was appended by a trusted proxy, the first by the
    // one that saw the client.
    if (chain.length) return chain[Math.max(0, chain.length - hops)];
  } else if (xff !== null) {
    // Astro reports the left-most X-Forwarded-For as clientAddress once the host validates
    // (security.allowedDomains), so it can't be trusted here. Share one bucket instead.
    if (!warnedUntrusted) {
      warnedUntrusted = true;
      console.warn('[http] X-Forwarded-For present but TRUST_PROXY/CLIENT_IP_HEADER unset: per-IP limits are shared.');
    }
    return 'untrusted-proxy';
  }
  try {
    return ctx.clientAddress;
  } catch {
    return 'unknown';
  }
}
