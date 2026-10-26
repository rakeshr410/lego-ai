import { sandboxFramePattern, webSandboxOrigin } from './web-sandbox';

// Security headers. The same policy is sent by the middleware on server-rendered responses
// and written at build time for the static pages (see astro.config.mjs).

export type PolicyOptions = {
  /** sha256 hashes ('sha256-...') of the inline scripts in the built pages. */
  scriptHashes?: string[];
  /** Extra origins allowed for images (Strapi media / CDN). */
  imageOrigins?: string[];
  /** Send Strict-Transport-Security (only for https sites). */
  hsts?: boolean;
  reportOnly?: boolean;
};

const TURNSTILE = 'https://challenges.cloudflare.com';

/** CSP for HTML pages. Inline style attributes and mermaid's injected <style> need 'unsafe-inline' for styles. */
export function pageCsp({ scriptHashes = [], imageOrigins = [] }: PolicyOptions = {}): string {
  const hashes = scriptHashes.map((h) => `'${h}'`);
  return [
    "default-src 'self'",
    `script-src 'self' ${TURNSTILE} ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    `img-src 'self' data: blob: ${imageOrigins.join(' ')}`.trim(),
    "connect-src 'self'",
    `frame-src ${TURNSTILE}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * CSP for an agent lab's page (docs/labs-design.md "Agentic labs"; plan 4.1): the site's policy plus
 * 'wasm-unsafe-eval' in script-src, so the self-hosted Pyodide (/pyodide/<version>/) can compile its
 * WebAssembly, and worker-src 'self' for the module worker that runs it. No 'unsafe-eval' and no
 * other origin: Pyodide and the lab's files are served from this site.
 */
export function labCsp(opts: PolicyOptions & { webSandbox?: string | null } = {}): string {
  const { webSandbox, ...rest } = opts;
  return pageCsp(rest)
    .split('; ')
    .map((d) => (d.startsWith('script-src ') ? d.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'") : d))
    // A frontend lab's page frames its sandbox, and only that: frame-src gets the one wildcard pattern (<sid>.<sandbox host>).
    .map((d) => (webSandbox && d.startsWith('frame-src ') ? `${d} ${sandboxFramePattern(webSandbox)}` : d))
    .flatMap((d) => (d.startsWith('default-src ') ? [d, "worker-src 'self'"] : [d]))
    .join('; ');
}

// Daily (the voice room's WebRTC, docs/README.md "Voice"): the call-object bundle daily-js
// loads at run time, its signalling and media hosts, and their fallback domains (Daily's CSP guide:
// every daily.co host is listed with dailywebrtc.com and dailywebrtc.net). The transport sets
// avoidEval, so no 'unsafe-eval'.
const DAILY_HOSTS = ['https://*.daily.co', 'https://*.dailywebrtc.com', 'https://*.dailywebrtc.net'];
const DAILY_SOCKETS = ['wss://*.daily.co', 'wss://*.dailywebrtc.com', 'wss://*.dailywebrtc.net'];

/**
 * CSP for a system's interview page (docs/README.md, "Whiteboard" and "Voice"): the
 * site's policy plus a worker from a blob URL (Excalidraw's canvas creates one for its text
 * measuring) and media from blobs (the voice room's audio). With `voice` (a build with
 * PUBLIC_INTERVIEW_VOICE_ENABLED) Daily's hosts for the call bundle, signalling and media; otherwise
 * nothing from another origin: the canvas and its fonts are served from this site
 * (scripts/copy-excalidraw.mjs).
 */
export function roomCsp(opts: PolicyOptions & { voice?: boolean } = {}): string {
  const { voice = false, ...rest } = opts;
  return pageCsp(rest)
    .split('; ')
    .flatMap((d) => (d.startsWith('default-src ') ? [d, "worker-src 'self' blob:", "media-src 'self' blob:"] : [d]))
    .map((d) => (voice && d.startsWith('script-src ') ? `${d} ${DAILY_HOSTS.join(' ')}` : d))
    .map((d) => (voice && d.startsWith('connect-src ') ? `${d} ${DAILY_HOSTS.join(' ')} ${DAILY_SOCKETS.join(' ')}` : d))
    .join('; ');
}

/**
 * An on-demand page whose policy needs the hashes of its own inline scripts (Astro's island
 * bootstrap), which only exist once it has rendered: the page sets this header to "lab" (labCsp) or
 * "page" (pageCsp) or "lab-web" (a frontend lab's page: labCsp plus frame-src for the configured sandbox origin, web-sandbox.ts), and the middleware (withInlineHashes) hashes the HTML's inline scripts, sends the
 * policy with them and drops the header. Without it the lab pages' islands never hydrate under the
 * production policy.
 */
export const INLINE_CSP_HEADER = 'X-Arrowbox-Inline-Csp';

/** sha256 hashes ('sha256-…') of the HTML's inline scripts, as astro.config.mjs computes them for static pages. */
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const out = new Set<string>();
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\ssrc=/.test(attrs) || /type=["']?application\/(ld\+)?json/.test(attrs) || !body) continue;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    out.add(`sha256-${Buffer.from(digest).toString('base64')}`);
  }
  return [...out].sort();
}

/** The response with its inline-hash policy filled in (INLINE_CSP_HEADER), or as it was. */
export async function withInlineHashes(res: Response, reportOnly: boolean): Promise<Response> {
  const kind = res.headers.get(INLINE_CSP_HEADER);
  if (!kind) return res;
  const html = await res.text();
  const scriptHashes = await inlineScriptHashes(html);
  const headers = new Headers(res.headers);
  headers.delete(INLINE_CSP_HEADER);
  headers.set(
    reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy',
    kind === 'lab-web' ? labCsp({ scriptHashes, webSandbox: webSandboxOrigin() }) : kind === 'lab' ? labCsp({ scriptHashes }) : pageCsp({ scriptHashes }),
  );
  return new Response(html, { status: res.status, statusText: res.statusText, headers });
}

// Razorpay's Standard Checkout (docs/phase-4-design.md §7.3): its script, the pop-up's frames, and
// the hosts the script calls. Confirmed on staging before the checkout CSP is enforced there.
const RAZORPAY_SCRIPT = ['https://checkout.razorpay.com', 'https://cdn.razorpay.com'];
const RAZORPAY_FRAME = ['https://api.razorpay.com', 'https://checkout.razorpay.com'];
const RAZORPAY_CONNECT = [
  'https://api.razorpay.com',
  'https://lumberjack.razorpay.com',
  'https://lumberjack-cx.razorpay.com',
  'https://lumberjack-metrics.razorpay.com',
  'https://checkout-static-next.razorpay.com',
];

/**
 * CSP for the checkout pages (lib/gated.ts, CHECKOUT_PREFIX). It replaces the site's policy rather
 * than adding to it (PCI SAQ A, §7.2): the pages' own inline scripts, Razorpay and nothing else, so
 * Turnstile and every other third party are gone. `checkoutScript` is the pop-up's script
 * (lib/billing-client.ts, razorpayCheckoutUrl): Razorpay's, or in a test build the mock on a
 * loopback host, which is then allowed to be called and framed as Razorpay is.
 */
export function checkoutCsp({ scriptHashes = [], checkoutScript }: { scriptHashes?: string[]; checkoutScript: string }): string {
  const hashes = scriptHashes.map((h) => `'${h}'`);
  const origin = new URL(checkoutScript).origin;
  const mock = RAZORPAY_SCRIPT.includes(origin) ? [] : [origin];
  return [
    "default-src 'self'",
    ['script-src', "'self'", ...RAZORPAY_SCRIPT, ...mock, ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https://cdn.razorpay.com",
    ['connect-src', "'self'", ...RAZORPAY_CONNECT, ...mock].join(' '),
    ['frame-src', ...RAZORPAY_FRAME, ...mock].join(' '),
    "object-src 'none'",
    "base-uri 'self'",
    // The pop-up never redirects (redirect: false), so no form posts to Razorpay (§7.3).
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The checkout profile: `base` (the headers the build wrote for a page: HSTS, report-only or not)
 * with its CSP replaced by checkoutCsp, an opener policy that lets Razorpay's windows (3-D Secure,
 * UPI apps) report back, and the Payment Request API for Razorpay.
 */
export function checkoutHeaders(base: Record<string, string>, csp: string): Record<string, string> {
  const out = { ...base };
  const key = 'Content-Security-Policy-Report-Only' in out ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
  out[key] = csp;
  out['Cross-Origin-Opener-Policy'] = 'same-origin-allow-popups';
  out['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=(), payment=(self "https://api.razorpay.com"), usb=()';
  return out;
}

/** CSP for API responses: nothing may load or run from them. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * `microphone` is for the voice room's page only (docs/privacy.md, "Permissions-Policy
 * and CSP"): the page itself may ask for the microphone; frames never (frame-ancestors 'none').
 */
export function securityHeaders(csp: string | null, { hsts = false, reportOnly = false, microphone = false }: PolicyOptions & { microphone?: boolean } = {}) {
  const h: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': `camera=(), microphone=(${microphone ? 'self' : ''}), geolocation=(), payment=(), usb=()`,
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (csp) h[reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy'] = csp;
  if (hsts) h['Strict-Transport-Security'] = 'max-age=63072000';
  return h;
}
