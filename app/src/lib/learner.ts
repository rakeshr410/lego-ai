// The learner model's rules (P3-1, P3-9): what counts as reading a topic, the streak, XP and the
// daily pick. Shared by the browser (lib/progress.ts, the reader and the picker) and the server
// (lib/server/learner.ts), so a reader's numbers are the same signed in or not.

/** A reader's progress on one topic. */
export type TopicProgress = {
  /** The sections read (their block keys), each one after enough time in it (components/sd/reading.ts). */
  sections: string[];
  /** Read far enough to count as finished (sectionsNeeded). Stays finished when the topic grows. */
  complete: boolean;
  /** The topic's contentVersion when the last of these was recorded; null when not known. */
  version: string | null;
};

export type LearnerState = {
  /** By `<system>/<topic>`. */
  topics: Record<string, TopicProgress>;
  /** The best score (0 to 1) on each quiz, by `<system>/<topic>` and the quiz's block key. */
  quizzes: Record<string, Record<string, number>>;
  /** Days with a section read or a quiz answered, YYYY-MM-DD in the reader's own time zone, oldest first. */
  days: string[];
};

/** What /api/progress answers with: the state, plus the numbers derived from it. */
export type ProgressSummary = LearnerState & { streak: number; xp: number };

export const emptyState = (): LearnerState => ({ topics: {}, quizzes: {}, days: [] });

export const topicKey = (system: string, topic: string) => `${system}/${topic}`;

/** How many days of activity are kept: enough for any streak worth showing, and a year of history. */
export const MAX_DAYS = 400;

// ---------- days ----------

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** The calendar day in the reader's own time zone, e.g. "2026-09-26". */
export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The day `n` days after `day` (before, when negative). */
export function shiftDay(day: string, n: number): string {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * Whether `day` can be today somewhere on Earth (UTC-12 to UTC+14): the only days a reader can
 * report as theirs. The server takes the reader's day from them (it has no time zone of theirs)
 * and refuses the rest, so a streak can't be written for days long past or yet to come.
 */
export function isToday(day: string, now = Date.now()): boolean {
  if (!isDay(day)) return false;
  const start = Date.parse(`${day}T00:00:00Z`);
  return now >= start - 14 * 3_600_000 && now < start + 36 * 3_600_000;
}

/**
 * The streak: consecutive days with activity, up to today. A streak lives through a day not yet
 * read in: until the reader's midnight, yesterday's streak still counts.
 */
export function streak(days: readonly string[], today: string): number {
  const active = new Set(days);
  let day = active.has(today) ? today : shiftDay(today, -1);
  let n = 0;
  while (active.has(day)) {
    n++;
    day = shiftDay(day, -1);
  }
  return n;
}

// ---------- reading ----------

/** The share of a topic's sections that finishes it: most of them, not a jump to the end. */
export const COMPLETE_SHARE = 0.8;

/** How many sections finish a topic of `count` sections. */
export const sectionsNeeded = (count: number) => Math.max(1, Math.ceil(count * COMPLETE_SHARE));

// ---------- XP (P3-9) ----------

/** What a topic is worth, from the catalog. */
export type XpTopic = {
  /** The topic's XP (content/<system>/<topic>.yaml `xp`). */
  xp: number;
  sectionCount: number;
  quizCount: number;
};

/** The share of a topic's XP earned by reading it; the rest comes from its quizzes' best scores. */
export const READING_XP = 0.7;

/**
 * XP earned on one topic: its sections read (a finished topic counts in full) for READING_XP of
 * it, and the best score on each of its quizzes for the rest. A topic without quizzes is all reading.
 */
export function topicXp(t: XpTopic, progress: TopicProgress | undefined, best: Record<string, number> | undefined): number {
  if (t.xp <= 0) return 0;
  const read = progress?.complete ? 1 : t.sectionCount > 0 ? Math.min(progress?.sections.length ?? 0, t.sectionCount) / t.sectionCount : 0;
  if (!t.quizCount) return Math.round(t.xp * read);
  const scores = Object.values(best ?? {}).sort((a, b) => b - a).slice(0, t.quizCount);
  const quiz = scores.reduce((sum, s) => sum + Math.min(1, Math.max(0, s)), 0) / t.quizCount;
  return Math.round(t.xp * (READING_XP * read + (1 - READING_XP) * quiz));
}

/** XP over every topic in the catalog; progress on topics no longer in it earns nothing. */
export function totalXp(catalog: ReadonlyMap<string, XpTopic>, state: LearnerState): number {
  let sum = 0;
  for (const [key, t] of catalog) sum += topicXp(t, state.topics[key], state.quizzes[key]);
  return sum;
}

// ---------- combining ----------

const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

/** Everything either state has: sections, finished topics, best scores and days. */
export function mergeStates(a: LearnerState, b: LearnerState): LearnerState {
  const topics: Record<string, TopicProgress> = { ...a.topics };
  for (const [key, p] of Object.entries(b.topics)) {
    const q = topics[key];
    topics[key] = q
      ? { sections: union(q.sections, p.sections), complete: q.complete || p.complete, version: p.version ?? q.version }
      : { ...p, sections: [...p.sections] };
  }
  const quizzes: Record<string, Record<string, number>> = {};
  for (const src of [a.quizzes, b.quizzes]) {
    for (const [key, scores] of Object.entries(src)) {
      const into = (quizzes[key] ??= {});
      for (const [quiz, s] of Object.entries(scores)) into[quiz] = Math.max(into[quiz] ?? 0, s);
    }
  }
  return { topics, quizzes, days: union(a.days, b.days).sort().slice(-MAX_DAYS) };
}

// ---------- the daily pick (P3-9) ----------

/** FNV-1a: a small, stable hash, so everyone gets the same pick on the same day. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Today's pick: one of the candidates, chosen by the day, so it changes at the reader's midnight
 * and is the same all day. Topics the reader has finished are passed over while any are left.
 */
export function dailyPick<T extends { key: string }>(candidates: readonly T[], day: string, finished: ReadonlySet<string> = new Set()): T | null {
  const fresh = candidates.filter((c) => !finished.has(c.key));
  const pool = fresh.length ? fresh : candidates;
  if (!pool.length) return null;
  const sorted = [...pool].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sorted[hash(day) % sorted.length];
}
