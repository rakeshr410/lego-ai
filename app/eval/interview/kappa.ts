// The kappa study (design section 8; docs/interview/README.md "Rollout"): before numeric ratings are
// shown, the grader's section ratings must agree with two human raters on at least 20 sessions at a
// quadratic-weighted Cohen's kappa of 0.6 or more, against each rater. Ratings are 0-4 (sessions.ts
// Rating). Input: rows of (session, key, rater, rating), the grader's from
// scripts/interview-cost-report.ts --ratings, the humans' from their sheets.

export type RatingRow = { session: string; key: string; rater: string; rating: number };

export const CATEGORIES = 5;
export const KAPPA_GATE = 0.6;
export const MIN_SESSIONS = 20;

/** Parses `session,key,rater,rating` CSV (a header line is skipped; blank lines ignored). */
export function parseRatingsCsv(text: string): RatingRow[] {
  const rows: RatingRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length < 4 || !cells[0] || cells[0].toLowerCase() === 'session') continue;
    const rating = Number(cells[3]);
    if (!Number.isInteger(rating) || rating < 0 || rating >= CATEGORIES) throw new Error(`bad rating ${cells[3]} for ${cells[0]} ${cells[1]} ${cells[2]} (0-${CATEGORIES - 1})`);
    rows.push({ session: cells[0], key: cells[1], rater: cells[2], rating });
  }
  return rows;
}

/**
 * Cohen's kappa with quadratic weights over `categories` ordered categories: 1 is perfect
 * agreement, 0 chance, negative worse than chance. Two equal lists of ratings. NaN with no pairs or
 * when both raters give one constant rating (no variance to agree on).
 */
export function weightedKappa(a: number[], b: number[], categories = CATEGORIES): number {
  if (a.length !== b.length) throw new Error('rating lists differ in length');
  const n = a.length;
  if (!n) return NaN;
  const w = (i: number, j: number) => ((i - j) * (i - j)) / ((categories - 1) * (categories - 1));
  const pa = new Array<number>(categories).fill(0);
  const pb = new Array<number>(categories).fill(0);
  let observed = 0;
  for (let k = 0; k < n; k++) {
    pa[a[k]] += 1 / n;
    pb[b[k]] += 1 / n;
    observed += w(a[k], b[k]) / n;
  }
  let expected = 0;
  for (let i = 0; i < categories; i++) for (let j = 0; j < categories; j++) expected += pa[i] * pb[j] * w(i, j);
  if (expected === 0) return NaN;
  return 1 - observed / expected;
}

export type PairResult = { a: string; b: string; n: number; sessions: number; kappa: number };
export type KappaReport = {
  raters: string[];
  pairs: PairResult[];
  /** The grader against each human rater. */
  grader: PairResult[];
  /** The humans against each other (the ceiling the grader is measured against). */
  humans: PairResult[];
  sessions: number;
  gate: { kappa: number; minSessions: number };
  pass: boolean;
  reasons: string[];
};

function pair(rows: RatingRow[], a: string, b: string): PairResult {
  const byA = new Map(rows.filter((r) => r.rater === a).map((r) => [`${r.session}\u0000${r.key}`, r] as const));
  const xs: number[] = [];
  const ys: number[] = [];
  const sessions = new Set<string>();
  for (const r of rows) {
    if (r.rater !== b) continue;
    const m = byA.get(`${r.session}\u0000${r.key}`);
    if (!m) continue;
    xs.push(m.rating);
    ys.push(r.rating);
    sessions.add(r.session);
  }
  return { a, b, n: xs.length, sessions: sessions.size, kappa: weightedKappa(xs, ys) };
}

/** The study's verdict: every human against the grader at or above the gate, on enough sessions. */
export function kappaReport(rows: RatingRow[], opts: { grader?: string; gate?: number; minSessions?: number } = {}): KappaReport {
  const graderName = opts.grader ?? 'grader';
  const gate = opts.gate ?? KAPPA_GATE;
  const minSessions = opts.minSessions ?? MIN_SESSIONS;
  const raters = [...new Set(rows.map((r) => r.rater))].sort((x, y) => (x === graderName ? -1 : y === graderName ? 1 : x.localeCompare(y)));
  const humans = raters.filter((r) => r !== graderName);
  const pairs: PairResult[] = [];
  for (let i = 0; i < raters.length; i++) for (let j = i + 1; j < raters.length; j++) pairs.push(pair(rows, raters[i], raters[j]));
  const grader = pairs.filter((p) => p.a === graderName || p.b === graderName);
  const human = pairs.filter((p) => p.a !== graderName && p.b !== graderName);
  const sessions = new Set(rows.filter((r) => r.rater === graderName).map((r) => r.session)).size;
  const reasons: string[] = [];
  if (!raters.includes(graderName)) reasons.push(`no rows from the grader (rater "${graderName}")`);
  if (humans.length < 2) reasons.push(`${humans.length} human rater(s); the study needs two`);
  for (const p of grader) {
    if (p.sessions < minSessions) reasons.push(`${p.a} vs ${p.b}: ${p.sessions} shared sessions, ${minSessions} needed`);
    if (!(p.kappa >= gate)) reasons.push(`${p.a} vs ${p.b}: kappa ${Number.isNaN(p.kappa) ? 'n/a' : p.kappa.toFixed(3)} below ${gate}`);
  }
  return { raters, pairs, grader, humans: human, sessions, gate: { kappa: gate, minSessions }, pass: reasons.length === 0, reasons };
}

export function renderKappa(r: KappaReport): string {
  const lines = [`Kappa study: ${r.sessions} sessions rated by the grader; raters ${r.raters.join(', ')}`];
  for (const p of r.pairs) lines.push(`  ${p.a} vs ${p.b}: weighted kappa ${Number.isNaN(p.kappa) ? 'n/a' : p.kappa.toFixed(3)} on ${p.n} ratings over ${p.sessions} sessions`);
  lines.push(`gate: kappa >= ${r.gate.kappa} against each human rater on >= ${r.gate.minSessions} sessions: ${r.pass ? 'PASS (numeric ratings may be shown)' : 'FAIL'}`);
  for (const why of r.reasons) lines.push(`  - ${why}`);
  return lines.join('\n');
}
