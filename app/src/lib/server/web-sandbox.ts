// The frontend labs' sandbox origin (docs/labs-web-design.md section 2): one config value,
// PUBLIC_LABS_WEB_SANDBOX = <scheme>://<base host>[:<port>] (default http://labs.localhost:4400 in the dev server only).
// The lab page frames <scheme>://<sid>.<base host>:<port>/runner/v1/, so its CSP's frame-src is the wildcard pattern for
// exactly that. This module has no imports on purpose: the CSP code (security-headers.ts) and the lab helpers share it.
//
// A build without labs (PUBLIC_LABS_ENABLED not "true") has no sandbox origin at all: the configured value and the dev
// default (written inline, not as a constant) sit behind flags Vite replaces, so the bundler drops them and no sandbox URL is
// left in the build output.

/** The configured sandbox origin, normalised ("http://labs.localhost:4400"), or null when none is configured or it is not a plain http(s) origin. */
export function parseSandboxOrigin(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  // The host must be a name that can take a sid label in front of it (no IP address, no bare "localhost" alone is fine).
  if (/^[\d.]+$/.test(u.hostname) || u.hostname.startsWith('[')) return null;
  return u.origin;
}

/** The sandbox origin for this build, or null (labs off, or nothing configured). */
export function webSandboxOrigin(): string | null {
  const labsBuild = import.meta.env.DEV || import.meta.env.PUBLIC_LABS_ENABLED === 'true';
  if (!labsBuild) return null;
  return parseSandboxOrigin((import.meta.env.PUBLIC_LABS_WEB_SANDBOX as string | undefined) ?? (import.meta.env.DEV ? 'http://labs.localhost:4400' : undefined));
}

/** The CSP frame-src source for every sid under the origin: "http://labs.localhost:4400" -> "http://*.labs.localhost:4400". */
export function sandboxFramePattern(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol}//*.${u.host}`;
}
