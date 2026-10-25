import type { APIRoute } from 'astro';
import { strapiUrl } from '../../lib/server/env';
import { json } from '../../lib/server/http';
import { isDraining } from '../../lib/server/lifecycle';
import { logFor } from '../../lib/server/log';
import { getStore } from '../../lib/server/store';

export const prerender = false;

const TIMEOUT_MS = 1_500;
// Load balancers poll this; one round of checks per instance every couple of seconds is plenty.
const CACHE_MS = 2_000;

type Check = 'ok' | 'fail';
type Checks = { store: Check; strapi: Check };

async function probe(run: (signal: AbortSignal) => Promise<unknown>): Promise<Check> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const timeout = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
  });
  try {
    await Promise.race([run(signal), timeout]);
    return 'ok';
  } catch {
    return 'fail';
  }
}

async function checkAll(): Promise<Checks> {
  const [store, strapi] = await Promise.all([
    // Any command is a round trip to Redis (and a no-op for the dev in-memory store).
    probe(async () => (await getStore()).get('ready:probe')),
    probe(async (signal) => {
      const res = await fetch(`${strapiUrl()}/_health`, { signal });
      if (!res.ok) throw new Error(`Strapi ${res.status}`);
    }),
  ]);
  return { store, strapi };
}

let last: { at: number; checks: Promise<Checks> } | null = null;

/**
 * Readiness: this instance can serve API traffic, meaning the shared store (Redis) and Strapi
 * both answer within 1.5 s. Take the instance out of rotation while it returns 503. From
 * SIGTERM on it returns 503 "draining" at once (scripts/drain.ts), with no dependency checks.
 */
export const GET: APIRoute = async ({ locals }) => {
  if (isDraining()) return json({ status: 'draining' }, 503);
  if (!last || Date.now() - last.at > CACHE_MS) last = { at: Date.now(), checks: checkAll() };
  const checks = await last.checks;
  const ready = checks.store === 'ok' && checks.strapi === 'ok';
  if (!ready) logFor(locals).warn({ checks }, 'not ready');
  return json({ status: ready ? 'ready' : 'unavailable', checks }, ready ? 200 : 503);
};
