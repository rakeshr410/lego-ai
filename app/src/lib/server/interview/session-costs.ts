// What each session cost, by service, and each person's total (scripts/session-costs.ts reads the sessions
// from Redis and hands them here). Pure. A session's spend by service (Session.spend) is grouped into Claude,
// speech to text, the voice and the room; what a session's total has beyond its lines (sessions from before
// the lines were kept) is "unsplit".

export type CostSession = {
  id: string;
  readerId: string;
  learnerName?: string;
  system: string;
  kind?: 'interview' | 'coach';
  mode?: 'text' | 'voice';
  course?: { lesson: string };
  status: 'active' | 'finished';
  startedAt: string;
  updatedAt: string;
  costUsd: number;
  spend?: Record<string, number>;
};

export const GROUPS = ['claude', 'stt', 'tts', 'room', 'unsplit'] as const;
export type Group = (typeof GROUPS)[number];

export type SessionCost = {
  id: string;
  readerId: string;
  name: string | null;
  what: string;
  mode: 'text' | 'voice';
  status: 'active' | 'finished';
  startedAt: string;
  minutes: number;
  totalUsd: number;
  groups: Record<Group, number>;
  /** Every line as kept ("claude reply", "tts smallest", ...). */
  lines: Record<string, number>;
};

export type PersonCost = { readerId: string; name: string | null; sessions: number; minutes: number; totalUsd: number; groups: Record<Group, number> };

const groupOf = (line: string): Group => (line.startsWith('claude') ? 'claude' : line.startsWith('stt') ? 'stt' : line.startsWith('tts') ? 'tts' : line.endsWith('room') ? 'room' : 'unsplit');
const empty = (): Record<Group, number> => ({ claude: 0, stt: 0, tts: 0, room: 0, unsplit: 0 });

export function sessionCost(s: CostSession): SessionCost {
  const lines = { ...s.spend };
  const groups = empty();
  for (const [line, usd] of Object.entries(lines)) groups[groupOf(line)] += usd;
  const split = Object.values(lines).reduce((a, b) => a + b, 0);
  // Rounding leaves a trace between the lines and the total; anything more is spend from before the lines.
  if (s.costUsd - split > 1e-6) groups.unsplit += s.costUsd - split;
  return {
    id: s.id,
    readerId: s.readerId,
    name: s.learnerName ?? null,
    what: s.kind === 'coach' ? `lesson ${s.course?.lesson ?? s.system}` : `interview ${s.system}`,
    mode: s.mode === 'voice' ? 'voice' : 'text',
    status: s.status,
    startedAt: s.startedAt,
    minutes: Math.max(0, (Date.parse(s.updatedAt) - Date.parse(s.startedAt)) / 60_000),
    totalUsd: s.costUsd,
    groups,
    lines,
  };
}

/** The sessions started since `since`, newest first, optionally one person's, and each person's totals, the costliest first. */
export function sessionCosts(sessions: readonly CostSession[], opts: { since: string; reader?: string }): { sessions: SessionCost[]; people: PersonCost[] } {
  const rows = sessions
    .filter((s) => s.startedAt >= opts.since && (!opts.reader || s.readerId === opts.reader))
    .map(sessionCost)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const people = new Map<string, PersonCost>();
  for (const r of rows) {
    const p = people.get(r.readerId) ?? { readerId: r.readerId, name: r.name, sessions: 0, minutes: 0, totalUsd: 0, groups: empty() };
    p.sessions += 1;
    p.minutes += r.minutes;
    p.totalUsd += r.totalUsd;
    p.name ??= r.name;
    for (const g of GROUPS) p.groups[g] += r.groups[g];
    people.set(r.readerId, p);
  }
  return { sessions: rows, people: [...people.values()].sort((a, b) => b.totalUsd - a.totalUsd) };
}

const usd = (n: number) => (n ? `$${n.toFixed(n < 0.1 ? 4 : 2)}` : '-');
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const lpad = (s: string, n: number) => s.padStart(n);

/** The report as text: one line a session, its lines by service under it, then each person's totals. */
export function renderCosts(r: { sessions: SessionCost[]; people: PersonCost[] }, opts: { detail?: boolean } = {}): string {
  const head = `${pad('started', 17)}${pad('session', 10)}${pad('person', 16)}${pad('what', 34)}${pad('mode', 6)}${lpad('min', 5)}${lpad('total', 10)}${GROUPS.map((g) => lpad(g, 10)).join('')}`;
  const out = ['Sessions', head, '-'.repeat(head.length)];
  for (const s of r.sessions) {
    const who = s.name ? `${s.name} ${s.readerId.slice(0, 6)}` : s.readerId.slice(0, 14);
    out.push(
      `${pad(s.startedAt.slice(0, 16).replace('T', ' '), 17)}${pad(s.id.slice(0, 8), 10)}${pad(who, 16)}${pad(s.what + (s.status === 'active' ? ' (on)' : ''), 34)}${pad(s.mode, 6)}${lpad(s.minutes.toFixed(0), 5)}${lpad(usd(s.totalUsd), 10)}${GROUPS.map((g) => lpad(usd(s.groups[g]), 10)).join('')}`,
    );
    if (opts.detail) for (const [line, v] of Object.entries(s.lines).sort((a, b) => b[1] - a[1])) out.push(`${' '.repeat(43)}${pad(line, 22)}${lpad(usd(v), 10)}`);
  }
  if (!r.sessions.length) out.push('(no sessions)');
  const total = r.sessions.reduce((a, s) => a + s.totalUsd, 0);
  out.push('', `People (${r.people.length}), ${r.sessions.length} sessions, ${usd(total)} in all`);
  const phead = `${pad('person', 30)}${lpad('sessions', 9)}${lpad('min', 7)}${lpad('total', 10)}${lpad('per session', 13)}${GROUPS.map((g) => lpad(g, 10)).join('')}`;
  out.push(phead, '-'.repeat(phead.length));
  for (const p of r.people) {
    out.push(
      `${pad(p.name ? `${p.name} (${p.readerId})` : p.readerId, 30)}${lpad(String(p.sessions), 9)}${lpad(p.minutes.toFixed(0), 7)}${lpad(usd(p.totalUsd), 10)}${lpad(usd(p.totalUsd / p.sessions), 13)}${GROUPS.map((g) => lpad(usd(p.groups[g]), 10)).join('')}`,
    );
  }
  return out.join('\n');
}

/** The sessions as CSV, one row a session, a column a group. */
export function costsCsv(rows: readonly SessionCost[]): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [['started', 'session', 'reader', 'name', 'what', 'mode', 'status', 'minutes', 'total_usd', ...GROUPS.map((g) => `${g}_usd`)].join(',')];
  for (const s of rows) {
    lines.push(
      [s.startedAt, s.id, s.readerId, s.name ?? '', s.what, s.mode, s.status, s.minutes.toFixed(1), s.totalUsd.toFixed(6), ...GROUPS.map((g) => s.groups[g].toFixed(6))].map(cell).join(','),
    );
  }
  return lines.join('\n');
}
