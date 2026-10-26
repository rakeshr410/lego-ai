// The cost re-measurement of the early-access phase (docs/cost-model.md, "Re-measuring";
// design phase 3 gate: cost per session within 20% of the model). Pure: scripts/interview-cost-report.ts
// reads the sessions from Redis and hands them here. Finished sessions only count towards the
// per-session figures (a running session's cost is not complete).

export type SessionRow = {
  mode?: 'text' | 'voice';
  status: 'active' | 'finished';
  startedAt: string;
  costUsd: number;
  system: string;
  readerId: string;
};

export type Model = {
  /** The model's cost of a finished session, in USD, per mode (cost-model.md). */
  text: number;
  voice: number;
  /** The gate: |measured / model - 1| at most this. */
  tolerance: number;
  /** Finished sessions a mode needs before its gate is judged. */
  minSessions: number;
};

export const DEFAULT_MODEL: Model = { text: 0.35, voice: 1.0, tolerance: 0.2, minSessions: 5 };

export type ModeSummary = {
  sessions: number;
  finished: number;
  readers: number;
  meanUsd: number;
  p95Usd: number;
  maxUsd: number;
  model: number;
  /** mean / model, over finished sessions; null with none. */
  ratio: number | null;
  verdict: 'within' | 'over' | 'under' | 'insufficient';
};

export type DaySummary = { day: string; text: { sessions: number; usd: number }; voice: { sessions: number; usd: number } };

export type Summary = {
  since: string;
  until: string;
  days: DaySummary[];
  modes: { text: ModeSummary; voice: ModeSummary };
  systems: Record<string, number>;
  /** Every mode with enough finished sessions is within tolerance, and at least one is judged. */
  gate: 'pass' | 'fail' | 'insufficient';
};

const modeOf = (s: SessionRow) => (s.mode === 'voice' ? 'voice' : 'text');
const day = (iso: string) => iso.slice(0, 10);

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : 0);

function summariseMode(rows: SessionRow[], model: number, m: Model): ModeSummary {
  const finished = rows.filter((r) => r.status === 'finished');
  const costs = finished.map((r) => r.costUsd || 0).sort((a, b) => a - b);
  const mean = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
  const ratio = costs.length ? mean / model : null;
  const verdict: ModeSummary['verdict'] =
    finished.length < m.minSessions || ratio === null ? 'insufficient' : Math.abs(ratio - 1) <= m.tolerance ? 'within' : ratio > 1 ? 'over' : 'under';
  return {
    sessions: rows.length,
    finished: finished.length,
    readers: new Set(rows.map((r) => r.readerId)).size,
    meanUsd: mean,
    p95Usd: quantile(costs, 0.95),
    maxUsd: costs.length ? costs[costs.length - 1] : 0,
    model,
    ratio,
    verdict,
  };
}

/** Sessions started in the last `days` days (UTC), by day, mode and system, against the model. */
export function summarise(sessions: SessionRow[], model: Model = DEFAULT_MODEL, days = 14, now = new Date()): Summary {
  const until = now.toISOString();
  const sinceMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * 86_400_000;
  const since = new Date(sinceMs).toISOString();
  const rows = sessions.filter((s) => Date.parse(s.startedAt) >= sinceMs && Date.parse(s.startedAt) <= Date.parse(until));
  const byDay = new Map<string, DaySummary>();
  for (let i = 0; i < days; i++) {
    const d = day(new Date(sinceMs + i * 86_400_000).toISOString());
    byDay.set(d, { day: d, text: { sessions: 0, usd: 0 }, voice: { sessions: 0, usd: 0 } });
  }
  const systems: Record<string, number> = {};
  for (const r of rows) {
    const d = byDay.get(day(r.startedAt));
    if (d) {
      d[modeOf(r)].sessions += 1;
      d[modeOf(r)].usd += r.costUsd || 0;
    }
    systems[r.system] = (systems[r.system] ?? 0) + 1;
  }
  const modes = {
    text: summariseMode(rows.filter((r) => modeOf(r) === 'text'), model.text, model),
    voice: summariseMode(rows.filter((r) => modeOf(r) === 'voice'), model.voice, model),
  };
  const judged = [modes.text, modes.voice].filter((m) => m.verdict !== 'insufficient');
  const gate: Summary['gate'] = !judged.length ? 'insufficient' : judged.every((m) => m.verdict === 'within') ? 'pass' : 'fail';
  return { since, until, days: [...byDay.values()], modes, systems, gate };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The summary as text for the terminal. */
export function render(s: Summary): string {
  const lines: string[] = [];
  lines.push(`Mock interview cost, ${s.since.slice(0, 10)} to ${s.until.slice(0, 10)} (UTC), sessions by start day:`);
  lines.push('  day         text  (usd)     voice (usd)');
  for (const d of s.days) lines.push(`  ${d.day}  ${String(d.text.sessions).padStart(4)}  ${usd(d.text.usd).padStart(7)}  ${String(d.voice.sessions).padStart(5)}  ${usd(d.voice.usd).padStart(7)}`);
  for (const mode of ['text', 'voice'] as const) {
    const m = s.modes[mode];
    const ratio = m.ratio === null ? 'n/a' : `${Math.round(m.ratio * 100)}% of the model's ${usd(m.model)}`;
    lines.push(`${mode}: ${m.sessions} sessions (${m.finished} finished, ${m.readers} readers); finished mean ${usd(m.meanUsd)}, p95 ${usd(m.p95Usd)}, max ${usd(m.maxUsd)}; ${ratio}: ${m.verdict}`);
  }
  const systems = Object.entries(s.systems)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  if (systems) lines.push(`systems: ${systems}`);
  lines.push(`gate (cost within tolerance of the model, every mode with enough finished sessions): ${s.gate.toUpperCase()}`);
  return lines.join('\n');
}
