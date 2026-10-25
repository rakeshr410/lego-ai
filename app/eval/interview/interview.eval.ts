import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { GOLDENS } from './goldens';
import { evalOptions, formatLive, replay, runLive } from './interview-eval';

// The interview eval (docs/interview/README.md, "Eval"). `npm run eval:interview` runs the offline
// replay (stub mode, no API calls); with INTERVIEW_EVAL_MODE=live and ANTHROPIC_API_KEY it also
// runs the real evaluator on every golden turn and the real grader on every golden transcript,
// under a spend cap, and fails below the gates. Settings (env):
//   INTERVIEW_EVAL_MODE       stub (default) | live
//   INTERVIEW_EVAL_EVALUATOR  the evaluator model (default claude-haiku-5-5)
//   INTERVIEW_EVAL_GRADER     the grader model (default claude-opus-5)
//   INTERVIEW_EVAL_MAX_USD    spend cap for the whole run (default 3)
//   INTERVIEW_EVAL_OUT        where the reports go (default web/eval/results/)

const opts = evalOptions(process.env);

/** A local run: the key from web/.env when the shell did not pass one. */
function keyFromDotenv(): string | undefined {
  const file = new URL('../../.env', import.meta.url);
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('ANTHROPIC_API_KEY='));
  return line?.slice('ANTHROPIC_API_KEY='.length).trim().replace(/^["']|["']$/g, '') || undefined;
}

it(`Interview goldens (${opts.mode})`, { timeout: 30 * 60_000 }, async () => {
  const replays = GOLDENS.map(replay);
  const offline = {
    director: replays.flatMap((r) => r.director.filter((d) => !d.ok).map((d) => `${r.golden.id} turn ${d.seq}: row ${d.row} ${d.move}, expected ${d.expectedRows.join('|')} ${d.expectedMove ?? ''}`)),
    statuses: replays.flatMap((r) => r.statuses.filter((s) => !s.ok).map((s) => `${r.golden.id} item ${s.n}: ${s.actual}, expected ${s.expected}`)),
    ratings: replays.flatMap((r) => r.ratings.filter((x) => x.expected !== x.actual).map((x) => `${r.golden.id} ${x.section}: ${x.actual}, expected ${x.expected}`)),
  };
  expect(offline.director, 'director rows').toEqual([]);
  expect(offline.statuses, 'aggregated statuses').toEqual([]);
  expect(offline.ratings, 'section ratings').toEqual([]);
  if (opts.mode !== 'live') return;

  const apiKey = process.env.ANTHROPIC_API_KEY || keyFromDotenv();
  if (!apiKey) throw new Error('INTERVIEW_EVAL_MODE=live needs ANTHROPIC_API_KEY (env or web/.env)');
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  const report = await runLive(opts, client);
  mkdirSync(opts.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(opts.out, `interview-eval-live-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const md = formatLive(report);
  writeFileSync(join(opts.out, `interview-eval-live-${stamp}.md`), `${md}\n`);
  console.log(md);

  expect(report.spentUsd).toBeLessThanOrEqual(opts.capUsd);
  expect(report.evaluator.hintedCredits, 'credits in the interviewer-states-the-answer case').toBe(0);
  expect(report.evaluator.precision, 'evaluator precision').toBeGreaterThanOrEqual(opts.minPrecision);
  expect(report.evaluator.recall, 'evaluator recall').toBeGreaterThanOrEqual(opts.minRecall);
  expect(report.evaluator.wrongFalsePositive, 'wrong false-positive rate').toBeLessThanOrEqual(opts.maxWrongFalsePositive);
  expect(report.grader.unparsed, 'unparsed grader replies').toBe(0);
  expect(report.grader.sectionMae, 'section rating MAE').toBeLessThanOrEqual(opts.maxSectionMae);
});
