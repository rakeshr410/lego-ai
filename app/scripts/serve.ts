import type { Server } from 'node:http';
import { createDrain, type DrainLog } from './drain.ts';

// Production entry: `node scripts/serve.ts` (npm start, the Dockerfile, the e2e server). Starts
// the built Astro standalone server and drains it gracefully on SIGTERM (scripts/drain.ts):
// readiness fails at once, requests in flight get up to SHUTDOWN_GRACE_MS (default 30 s) to
// finish, then the process exits. A second SIGINT (Ctrl-C twice) exits straight away.
//
//   SHUTDOWN_DELAY_MS   keep serving this long after SIGTERM so the load balancer sees
//                       /api/ready fail before the listener closes (default 5000)
//   SHUTDOWN_GRACE_MS   most time from SIGTERM to exit (default 30000)

type Entry = { startServer: () => { server: { server: Server } } };

const ms = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n >= 0 ? n : fallback;
};

// A failed write to stdout or stderr (a full disk, a broken log pipe) must not end the process
// with an unhandled 'error' event; count it instead. The server's log module installs the same
// guard (guardStdio in src/lib/server/log.ts); the shared symbols keep it to one per process.
const g = globalThis as { [k: symbol]: unknown };
const STDIO_GUARD = Symbol.for('arrowbox.stdioGuard');
if (!g[STDIO_GUARD]) {
  g[STDIO_GUARD] = true;
  const stats = (g[Symbol.for('arrowbox.logWrites')] ??= { failedWrites: 0, droppedLines: 0 }) as { failedWrites: number };
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => void stats.failedWrites++);
}

// Same shape as the server's pino lines (src/lib/server/log.ts).
const log: DrainLog = (level, msg, fields = {}) => {
  const line = { level, time: new Date().toISOString(), service: 'web', ...(process.env.RELEASE ? { release: process.env.RELEASE } : {}), ...fields, msg };
  (level === 'info' ? process.stdout : process.stderr).write(`${JSON.stringify(line)}\n`);
};

process.env.ASTRO_NODE_AUTOSTART = 'disabled';
const { startServer } = (await import(new URL('../dist/server/entry.mjs', import.meta.url).href)) as Entry;
const { server } = startServer();

const drain = createDrain(server.server, {
  delayMs: ms(process.env.SHUTDOWN_DELAY_MS, 5_000),
  graceMs: ms(process.env.SHUTDOWN_GRACE_MS, 30_000),
  log,
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (drain.started) {
      if (signal === 'SIGINT') process.exit(130);
      return;
    }
    drain.drain(signal).then(
      () => process.exit(0),
      (err: unknown) => {
        log('error', 'drain failed', { error: (err as Error).message });
        process.exit(1);
      },
    );
  });
}
