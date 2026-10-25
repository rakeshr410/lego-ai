import { CircuitBreaker, CircuitOpenError } from './circuit';
import { env, strapiUrl } from './env';
import { logger } from './log';

// Server-only Strapi access. Never import this from components: it uses STRAPI_SERVER_TOKEN.
// Both are read at runtime (never import.meta.env, which Vite inlines into the build output).

export const STRAPI_URL = strapiUrl();

const TIMEOUT_MS = 10_000;

export class StrapiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Strapi ${status}`);
  }

  /** Strapi's error message ({ error: { message } }), if any. */
  get detail(): string {
    const e = (this.body as { error?: { message?: unknown } } | null)?.error;
    return typeof e?.message === 'string' ? e.message : '';
  }
}

/**
 * Strapi wasn't called because it has been failing (the circuit is open). A StrapiError with
 * status 503, so callers that map Strapi statuses treat it like Strapi answering 503.
 */
export class StrapiUnavailable extends StrapiError {
  constructor(readonly retryAfter: number) {
    super(503, { error: { message: 'Strapi is unavailable' } });
    this.name = 'StrapiUnavailable';
  }
}

/**
 * Every call to Strapi goes through this breaker. Five failures in a row (no answer, a timeout,
 * or a 5xx) open it for 10 s; calls then fail at once with StrapiUnavailable instead of waiting
 * out the timeout, so a Strapi outage can't tie up this server's sockets and handlers. A 4xx is
 * Strapi answering, so it counts as healthy; a call its caller cut off counts for nothing. /api/ready probes Strapi itself, outside the breaker.
 */
export const strapiCircuit = new CircuitBreaker('strapi', {
  threshold: 5,
  cooldownMs: 10_000,
  onChange: (to, from, failures) =>
    logger[to === 'closed' ? 'info' : 'warn']({ circuit: 'strapi', from, to, failures }, 'circuit state changed'),
});

async function send(path: string, init: RequestInit, auth?: string) {
  let res: Response;
  try {
    res = await strapiCircuit.run(
      () =>
        fetch(`${STRAPI_URL}/api${path}`, {
          ...init,
          // The caller's signal (if any) never replaces the timeout.
          signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
            ...init.headers,
          },
        }),
      // A caller's own abort (the reader went away, or a route's deadline cut the call off) says
      // nothing about Strapi either way: it neither counts as a failure nor as a success, so
      // routine cut-offs while Strapi hangs can't keep the breaker from opening, or close it.
      { isNeutral: () => init.signal?.aborted === true, badResult: (r) => r.status >= 500 },
    );
  } catch (err) {
    if (err instanceof CircuitOpenError) throw new StrapiUnavailable(err.retryAfter);
    throw err;
  }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new StrapiError(res.status, body);
  return { res, body };
}

async function request<T>(path: string, init: RequestInit, auth?: string): Promise<T> {
  return (await send(path, init, auth)).body as T;
}

/** Calls Strapi with the server token (Ask notes, topics, systems). */
export function serverFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = env('STRAPI_SERVER_TOKEN');
  if (!token) throw new Error('STRAPI_SERVER_TOKEN is not set (see web/.env.example)');
  return request<T>(path, init, token);
}

/** Calls Strapi as a signed-in reader (their JWT), or anonymously for sign-in/registration. */
export function userFetch<T>(path: string, init: RequestInit = {}, jwt?: string): Promise<T> {
  return request<T>(path, init, jwt);
}

const REFRESH_COOKIE = 'strapi_up_refresh';

/**
 * Calls a users-permissions auth route and returns its body plus the refresh token. With
 * sessions.httpOnly=false Strapi returns the token in the body; with httpOnly=true it only
 * sets it as a cookie on this server-to-server response, so read it from there.
 */
export async function authFetch<T extends object>(
  path: string,
  init: RequestInit = {},
  jwt?: string,
): Promise<T & { refreshToken?: string }> {
  const { res, body } = await send(path, init, jwt);
  const out = (body ?? {}) as T & { refreshToken?: string };
  if (typeof out.refreshToken !== 'string') {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      if (pair.slice(0, eq).trim() === REFRESH_COOKIE && pair.slice(eq + 1)) {
        out.refreshToken = decodeURIComponent(pair.slice(eq + 1));
      }
    }
  }
  return out;
}
