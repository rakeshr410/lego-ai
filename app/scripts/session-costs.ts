#!/usr/bin/env node
/**
 * What each session cost, by service (Claude, speech to text, the voice, Daily's room), and each person's total.
 * Reads every session from the shared store, or, with --url, asks the app for them (a dev server without Redis keeps
 * its sessions in memory); sessions are kept INTERVIEW_RETENTION_DAYS (30 by default), so the report reaches back that
 * far at most.
 *
 *   REDIS_URL=redis://... node scripts/session-costs.ts [--days 30] [--reader <id>] [--detail] [--csv] [--json]
 *   LEGO_AI_SECRET=... node scripts/session-costs.ts --url http://localhost:4323 [the same options]
 *
 * --detail lists each session's lines ("claude reply", "tts smallest", ...). Read-only. Keys and prefix are kept in
 * sync with src/lib/server/interview/sessions.ts and store.ts.
 */
import { Redis } from 'ioredis';
import { costsCsv, renderCosts, sessionCosts, type CostSession } from '../src/lib/server/interview/session-costs.ts';

const PREFIX = 'bp:';
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const days = Number(opt('days', '30'));
const reader = opt('reader', '') || undefined;
const format = args.includes('--json') ? 'json' : args.includes('--csv') ? 'csv' : 'text';

// From the app: the internal endpoint renders the same report.
const app = opt('url', '');
if (app) {
  const secret = process.env.LEGO_AI_SECRET;
  if (!secret) {
    console.error('LEGO_AI_SECRET is not set.');
    process.exit(2);
  }
  const q = new URLSearchParams({ days: String(days), format, ...(reader ? { reader } : {}), ...(args.includes('--detail') ? { detail: '1' } : {}) });
  const res = await fetch(`${app.replace(/\/$/, '')}/api/internal/interview/costs?${q}`, { headers: { authorization: `Bearer ${secret}` } });
  if (!res.ok) {
    console.error(`The app answered ${res.status}.`);
    process.exit(1);
  }
  const body = await res.text();
  console.log(format === 'json' ? JSON.stringify(JSON.parse(body), null, 2) : body.trimEnd());
  process.exit(0);
}

const url = process.env.REDIS_URL;
if (!url) {
  console.error('REDIS_URL is not set (or pass --url and LEGO_AI_SECRET to ask the app).');
  process.exit(2);
}

const redis = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 5_000, lazyConnect: true, retryStrategy: () => null });
redis.on('error', () => {});
try {
  await redis.connect();
  const keys: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = redis.scanStream({ match: `${PREFIX}interview:session:*`, count: 200 });
    stream.on('data', (batch: string[]) => keys.push(...batch));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const sessions: CostSession[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const values = await redis.mget(keys.slice(i, i + 100));
    for (const v of values) if (v) sessions.push(JSON.parse(v) as CostSession);
  }
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const report = sessionCosts(sessions, { since, reader });
  if (format === 'json') console.log(JSON.stringify(report, null, 2));
  else if (format === 'csv') console.log(costsCsv(report.sessions));
  else console.log(renderCosts(report, { detail: args.includes('--detail') }));
} catch (err) {
  console.error('Could not read the sessions:', (err as Error).message);
  process.exitCode = 1;
} finally {
  redis.disconnect();
}
