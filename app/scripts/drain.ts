import type { IncomingMessage, Server, ServerResponse } from 'node:http';

// Graceful shutdown for the web server (used by scripts/serve.ts). On SIGTERM the instance:
//
//   1. flips readiness: /api/ready answers 503 "draining" at once, so the load balancer takes
//      it out of rotation, while it keeps serving whatever still arrives for `delayMs`;
//   2. stops accepting connections and closes idle keep-alive ones; responses from then on
//      carry `Connection: close`;
//   3. waits for in-flight requests (a paid Ask answer takes 5-20 s) until `graceMs` after the
//      signal, then cuts whatever is left;
//   4. runs the shutdown hooks the server bundle registered (flush Sentry, close Redis).
//
// The platform's termination grace period must be longer than `graceMs` (docs/deploy.md).
//
// This file ships in the runtime image next to the bundle, which it can't import from, so it
// reaches the bundle's lifecycle state (src/lib/server/lifecycle.ts) through the same
// registered symbol. Keep the two shapes in step.

type Lifecycle = { draining: boolean; drainingSince: number | null; hooks: Set<() => unknown> };

const LIFECYCLE_KEY = Symbol.for('arrowbox.lifecycle');

function lifecycle(): Lifecycle {
  const g = globalThis as { [LIFECYCLE_KEY]?: Lifecycle };
  g[LIFECYCLE_KEY] ??= { draining: false, drainingSince: null, hooks: new Set() };
  return g[LIFECYCLE_KEY];
}

export type DrainLog = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;

export type DrainOptions = {
  /** How long to keep serving with readiness failing before closing the listener. */
  delayMs: number;
  /** Most time from the signal to exit, in-flight requests included. */
  graceMs: number;
  /** Most time the shutdown hooks get, within graceMs where it can. */
  hookTimeoutMs?: number;
  log?: DrainLog;
};

export type DrainOutcome = 'drained' | 'forced';

export type Drain = {
  /** Starts draining (once; later calls return the same promise). */
  drain(reason: string): Promise<DrainOutcome>;
  readonly started: boolean;
  /** Requests being handled right now. */
  inFlight(): number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)).unref());

async function runHooks(hooks: Iterable<() => unknown>, timeoutMs: number, log: DrainLog) {
  const all = Promise.allSettled([...hooks].map(async (h) => h())).then((results) => {
    for (const r of results) if (r.status === 'rejected') log('warn', 'shutdown hook failed', { error: String((r.reason as Error)?.message ?? r.reason) });
  });
  await Promise.race([all, sleep(timeoutMs)]);
}

export function createDrain(server: Server, opts: DrainOptions): Drain {
  const log: DrainLog = opts.log ?? (() => {});
  const hookTimeoutMs = opts.hookTimeoutMs ?? 2_000;
  const active = new Set<ServerResponse>();
  let started: Promise<DrainOutcome> | null = null;

  // First in line, so it marks the response before the app can send its headers.
  server.prependListener('request', (_req: IncomingMessage, res: ServerResponse) => {
    active.add(res);
    if (started) res.shouldKeepAlive = false;
    res.once('close', () => {
      active.delete(res);
      // Once the listener is closed, a connection that just went idle has nothing left to do.
      if (started && !server.listening) server.closeIdleConnections();
    });
  });

  async function run(reason: string): Promise<DrainOutcome> {
    const state = lifecycle();
    const t0 = Date.now();
    state.draining = true;
    state.drainingSince = t0;
    log('info', 'draining', { reason, inFlight: active.size, delayMs: opts.delayMs, graceMs: opts.graceMs });
    for (const res of active) if (!res.headersSent) res.shouldKeepAlive = false;

    await sleep(Math.min(opts.delayMs, opts.graceMs));
    const closed = new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });
    server.closeIdleConnections();
    const left = t0 + opts.graceMs - Date.now();
    const forced = await Promise.race([closed.then(() => false), sleep(left).then(() => true)]);
    if (forced) {
      log('warn', 'drain timed out; closing open connections', { inFlight: active.size });
      server.closeAllConnections();
    } else {
      log('info', 'drained', { ms: Date.now() - t0 });
    }
    await runHooks(state.hooks, Math.min(hookTimeoutMs, Math.max(250, t0 + opts.graceMs - Date.now())), log);
    return forced ? 'forced' : 'drained';
  }

  return {
    drain(reason) {
      started ??= run(reason);
      return started;
    },
    get started() {
      return started !== null;
    },
    inFlight: () => active.size,
  };
}
