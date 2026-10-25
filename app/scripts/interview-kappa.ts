#!/usr/bin/env node
/**
 * The kappa study (docs/interview/README.md "Rollout"; design section 8): the grader's section
 * ratings against two human raters, quadratic-weighted Cohen's kappa, gate 0.6 on 20 sessions.
 * Exit 0 when the gate passes (numeric ratings may be shown), 1 when it does not.
 *
 *   node scripts/interview-kappa.ts ratings.csv [more.csv ...] [--gate 0.6] [--min-sessions 20] [--grader grader] [--json]
 *
 * CSV rows: session,key,rater,rating (0-4). The grader's rows come from
 * `scripts/interview-cost-report.ts --ratings grader.csv`; each human rater's from their sheet,
 * with their name in the rater column. Several files are concatenated.
 */
import { readFileSync } from 'node:fs';
import { kappaReport, parseRatingsCsv, renderKappa } from '../eval/interview/kappa.ts';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--json'));
if (!files.length) {
  console.error('usage: node scripts/interview-kappa.ts ratings.csv [more.csv ...] [--gate 0.6] [--min-sessions 20] [--grader grader] [--json]');
  process.exit(2);
}
const rows = files.flatMap((f) => parseRatingsCsv(readFileSync(f, 'utf8')));
const report = kappaReport(rows, { gate: Number(opt('gate', '0.6')), minSessions: Number(opt('min-sessions', '20')), grader: opt('grader', 'grader') });
console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : renderKappa(report));
process.exitCode = report.pass ? 0 : 1;
