import { randomUUID } from 'node:crypto';
import { destination, pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { SENTRY_DATA_COLLECTION, scrubEvent, type ErrorContext } from '../report';
import { isProduction, serverEnv } from './env';
import { onShutdown } from './lifecycle';

// Structured JSON logs on stdout (one object per line) for the log pipeline, plus server-side
// error tracking in Sentry when SENTRY_DSN is set. Never log request bodies, query strings,
// cookies or tokens: they carry passwords, confirmation codes and session ids.

declare global {
  namespace App {
    interface Locals {
      /** Set by the middleware for every on-demand request (X-Request-Id or a new UUID). */
      requestId?: string;
      /** A child of `logger` carrying the request id. */
      log?: Logger;
    }
  }
}

export type { Logger };

const settings = serverEnv();

const options: LoggerOptions = {
  level: settings.LOG_LEVEL ?? (isProduction() ? 'info' : 'debug'),
  base: { service: 'web', ...(settings.RELEASE ? { release: settings.RELEASE } : {}) },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: [
      'headers.authorization',
      'headers.cookie',
      'headers["set-cookie"]',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.jwt',
      '*.refreshToken',
      '*.token',
      '*.apiKey',
      // Billing (Phase 4): Razorpay's signatures and secrets, and what a payment says about the payer.
      'headers["x-razorpay-signature"]',
      'req.headers["x-razorpay-signature"]',
      '*.razorpay_signature',
      '*.signature',
      '*.keySecret',
      '*.webhookSecret',
      '*.vpa',
      '*.contact',
      '*.card.number',
      '*.card.name',
      '*.billing',
      '*.gstin',
    ],
    censor: '[redacted]',
  },
};

// ---------------------------------------------------------------------------------------
// A log line that can't be written is dropped and counted, never fatal. A full disk (ENOSPC), or
// a log pipe that stalls or breaks in a container, otherwise ends the process: the write error
// surfaces as an 'error' event nobody handles. The load tests hit exactly that twice.

export type LogWriteStats = {
  /** Writes that failed (each retried with the next line while the backlog has room). */
  failedWrites: number;
  /** Lines dropped because the backlog of unwritten lines was full. */
  droppedLines: number;
};

const STATS_KEY = Symbol.for('arrowbox.logWrites');

/** Failed log writes in this process (shared with scripts/serve.ts, which guards stdio too). */
export function logWriteStats(): LogWriteStats {
  const g = globalThis as { [STATS_KEY]?: LogWriteStats };
  g[STATS_KEY] ??= { failedWrites: 0, droppedLines: 0 };
  return g[STATS_KEY];
}

/** Unwritten lines held while stdout can't take them (a full disk clearing); beyond it, lines are dropped. */
const MAX_BACKLOG_BYTES = 4 * 1024 * 1024;

/** Says something on stderr without ever throwing (stderr may be the thing that's broken). */
function tell(line: string) {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    /* nothing more we can do */
  }
}

/**
 * pino's stdout destination (or `fd`'s), made failure-proof: write errors and dropped lines are
 * counted, reported once per outage on stderr, and followed by a summary line once writes work
 * again. On a broken pipe (EPIPE) pino stops writing to it for good; the process carries on.
 */
export function logDestination(fd = 1): DestinationStream {
  const stats = logWriteStats();
  const dest = destination({ dest: fd, sync: false, maxLength: MAX_BACKLOG_BYTES });
  const seen = new WeakSet<object>(); // pino re-emits the error it doesn't handle itself
  let outage: { since: string; failedWrites: number; droppedLines: number } | null = null;
  dest.on('error', (err: NodeJS.ErrnoException) => {
    if (seen.has(err)) return;
    seen.add(err);
    stats.failedWrites++;
    if (outage) return;
    outage = { since: new Date().toISOString(), failedWrites: stats.failedWrites - 1, droppedLines: stats.droppedLines };
    tell(JSON.stringify({ level: 'error', service: 'web', event: 'log_write_failed', code: err.code, msg: 'log writes are failing; holding, then dropping lines until they work again' }));
  });
  // pino flushes synchronously on exit, and sonic-boom's flushSync retries a failing write every
  // 100 ms forever (only EAGAIN ever gives up): with the disk still full, the process would hang
  // on its way out instead of exiting. During an outage the backlog is dropped instead.
  const flushSync = dest.flushSync.bind(dest);
  dest.flushSync = () => {
    if (!outage) flushSync();
  };
  dest.on('drop', () => {
    stats.droppedLines++;
  });
  dest.on('write', () => {
    if (!outage) return;
    const { since, failedWrites, droppedLines } = outage;
    outage = null;
    logger.warn(
      { event: 'log_writes_recovered', since, failedWrites: stats.failedWrites - failedWrites, droppedLines: stats.droppedLines - droppedLines },
      'log writes work again',
    );
  });
  return dest;
}

const STDIO_GUARD = Symbol.for('arrowbox.stdioGuard');

/**
 * Keeps a failed write to stdout or stderr (console.*, the Ask usage lines, other libraries) from
 * crashing the process with an unhandled 'error' event: the failure is counted instead. Installed
 * once per process, here and by scripts/serve.ts.
 */
export function guardStdio() {
  const g = globalThis as { [STDIO_GUARD]?: boolean };
  if (g[STDIO_GUARD]) return;
  g[STDIO_GUARD] = true;
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', () => {
      logWriteStats().failedWrites++;
    });
  }
}

guardStdio();

/** A JSON logger; `destination` is for tests (default: stdout, through logDestination). */
export const createLogger = (destination?: DestinationStream): Logger => pino(options, destination ?? logDestination());

export const logger: Logger = createLogger();

// A proxy's or client's X-Request-Id is kept only when it looks like an id, so it can't inject
// anything into log lines or headers.
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** The request's X-Request-Id when it is a plausible id, otherwise a new UUID. */
export function requestIdFrom(headers: Headers): string {
  const v = headers.get('x-request-id')?.trim();
  return v && REQUEST_ID.test(v) ? v : randomUUID();
}

/** A logger whose lines carry the request id. */
export const requestLogger = (requestId: string, fields: Record<string, unknown> = {}) =>
  logger.child({ requestId, ...fields });

/** The request's logger (set by the middleware), or the root logger outside a request. */
export const logFor = (locals: App.Locals | undefined): Logger => locals?.log ?? logger;

type SentryNode = typeof import('@sentry/node');

let sentry: Promise<SentryNode | null> | null = null;

/** Sentry for the server, initialised on first use; null (a no-op) without SENTRY_DSN. */
function serverSentry(): Promise<SentryNode | null> | null {
  const { SENTRY_DSN: dsn, SENTRY_ENVIRONMENT, RELEASE } = serverEnv();
  if (!dsn) return null;
  sentry ??= import('@sentry/node')
    .then((Sentry) => {
      Sentry.init({
        dsn,
        environment: SENTRY_ENVIRONMENT ?? (isProduction() ? 'production' : 'development'),
        release: RELEASE,
        dataCollection: SENTRY_DATA_COLLECTION,
        tracesSampleRate: 0,
        beforeSend: (event) => scrubEvent(event),
        beforeBreadcrumb: (crumb) => (crumb.category === 'console' ? null : crumb),
      });
      // Send queued error reports before the process exits (scripts/drain.ts).
      onShutdown(() => Sentry.close(2_000));
      return Sentry;
    })
    .catch((err: unknown) => {
      logger.warn({ err }, 'sentry init failed; errors are only logged');
      return null;
    });
  return sentry;
}

/** Sends an unexpected server error to Sentry (when configured). Logging is up to the caller. */
export function captureServerError(error: unknown, context: ErrorContext = {}) {
  void serverSentry()?.then((Sentry) =>
    Sentry?.withScope((scope) => {
      const { requestId, route, ...rest } = context;
      if (typeof requestId === 'string') scope.setTag('request_id', requestId);
      if (typeof route === 'string') scope.setTag('route', route);
      scope.setContext('arrowbox', rest);
      Sentry.captureException(error);
    }),
  );
}
