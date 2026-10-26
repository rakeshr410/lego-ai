#!/usr/bin/env node
/**
 * The early-access cost re-measurement (docs/cost-model.md "Re-measuring"; the phase 3
 * gate: cost per finished session within 20% of the model). Reads every mock interview session
 * from the shared store and prints sessions and spend by day and mode against the model, plus the
 * gate. With --ratings <file> it also writes the grader's section ratings as CSV
 * (session,key,rater,rating with rater `grader`) for the kappa study (scripts/interview-kappa.ts).
 *
 *   REDIS_URL=rediss://... node scripts/interview-cost-report.ts [--days 14] [--model-text 0.35] [--model-voice 1.00] [--tolerance 0.2] [--json] [--ratings grader.csv]
 *
 * Read-only. Keys and prefix are kept in sync with src/lib/server/interview/sessions.ts and store.ts.
 */
import { writeFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import { DEFAULT_MODEL, render, summarise, type SessionRow } from '../src/lib/server/interview/cost-report.ts';

const PREFIX = 'bp:';
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const url = process.env.REDIS_URL;
if (!url) {
  console.error('REDIS_URL is not set.');
  process.exit(2);
}
const model = {
  text: Number(opt('model-text', String(DEFAULT_MODEL.text))),
  voice: Number(opt('model-voice', String(DEFAULT_MODEL.voice))),
  tolerance: Number(opt('tolerance', String(DEFAULT_MODEL.tolerance))),
  minSessions: Number(opt('min-sessions', String(DEFAULT_MODEL.minSessions))),
};
const days = Number(opt('days', '14'));
const ratingsFile = opt('ratings', '');

type Stored = SessionRow & { id: string; feedback?: { sections?: { key: string; rating: number }[]; stages?: { key: string; rating: number }[] } | null };

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
  const sessions: Stored[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const values = await redis.mget(keys.slice(i, i + 100));
    for (const v of values) if (v) sessions.push(JSON.parse(v) as Stored);
  }
  const summary = summarise(sessions, model, days);
  console.log(args.includes('--json') ? JSON.stringify(summary, null, 2) : render(summary));
  if (ratingsFile) {
    const rows = ['session,key,rater,rating'];
    for (const s of sessions) {
      const rated = s.feedback?.sections?.length ? s.feedback.sections : (s.feedback?.stages ?? []);
      for (const r of rated) rows.push(`${s.id},${r.key},grader,${r.rating}`);
    }
    writeFileSync(ratingsFile, rows.join('\n') + '\n');
    console.log(`grader ratings: ${rows.length - 1} rows written to ${ratingsFile}`);
  }
} catch (err) {
  console.error(`Could not read the store: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  redis.disconnect();
}
