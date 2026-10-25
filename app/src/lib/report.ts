/** Where an error came from: a block id and type, a topic, a component name. */
export type ErrorContext = Record<string, unknown>;

// Browser error tracking: on only when PUBLIC_SENTRY_DSN is set at build time (the pages are
// static). The SDK is loaded on the first report, so pages without errors never download it.
const DSN = import.meta.env.PUBLIC_SENTRY_DSN;

type SentryBrowser = typeof import('@sentry/browser');

let sentry: Promise<SentryBrowser | null> | null = null;

function browserSentry(): Promise<SentryBrowser | null> | null {
  if (!DSN || typeof window === 'undefined') return null;
  sentry ??= import('@sentry/browser')
    .then((Sentry) => {
      Sentry.init({
        dsn: DSN,
        environment: import.meta.env.PUBLIC_SENTRY_ENVIRONMENT || import.meta.env.MODE,
        release: import.meta.env.PUBLIC_RELEASE || undefined,
        dataCollection: SENTRY_DATA_COLLECTION,
        beforeSend: (event) => scrubEvent(event),
      });
      return Sentry;
    })
    .catch(() => null);
  return sentry;
}

/** What the Sentry SDKs may collect: no user info, cookies, headers, bodies, query strings or locals. */
export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [] as never[],
  urlQueryParams: false,
  stackFrameVariables: false,
  genAI: { inputs: false, outputs: false },
};

type Scrubbable = {
  request?: { cookies?: unknown; headers?: Record<string, string>; data?: unknown; query_string?: unknown };
  user?: { ip_address?: unknown } | null;
};

const PRIVATE_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization|x-forwarded-for|cf-connecting-ip|x-razorpay-signature)$/i;

/**
 * Removes what must never reach error tracking: cookies, auth headers, client IPs, request
 * bodies and query strings (passwords, confirmation and reset codes). Used on both tiers.
 */
export function scrubEvent<E extends Scrubbable>(event: E): E {
  const req = event.request;
  if (req) {
    delete req.cookies;
    delete req.data;
    delete req.query_string;
    if (req.headers) {
      for (const k of Object.keys(req.headers)) if (PRIVATE_HEADERS.test(k)) delete req.headers[k];
    }
  }
  if (event.user) delete event.user.ip_address;
  return event;
}

/**
 * The single reporting hook for render and data errors, on the server (build) and in the browser.
 * Errors go to the console, and in the browser also to Sentry when it is configured.
 */
export function reportError(error: unknown, context: ErrorContext = {}): void {
  console.error('[arrowbox]', context, error);
  void browserSentry()?.then((Sentry) =>
    Sentry?.withScope((scope) => {
      scope.setContext('arrowbox', context);
      Sentry.captureException(error);
    }),
  );
}

/** Reports a content problem that was worked around (a skipped topic, an unknown block) without an exception. */
export function reportWarning(message: string, context: ErrorContext = {}): void {
  console.warn(`[arrowbox] ${message}`, context);
}
