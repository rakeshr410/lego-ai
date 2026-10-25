import { canonicalTopic } from '@arrowbox/content-kit/aliases';
import {
  isDay,
  isToday,
  MAX_DAYS,
  sectionsNeeded,
  shiftDay,
  streak,
  topicKey,
  totalXp,
  type LearnerState,
  type ProgressSummary,
  type XpTopic,
} from '../learner';
import { freeCut, freeInFull, type FreeTier } from '../free-tier';
import { getAliases, getTopics, type QuizBlock, type Topic } from '../sd';
import { topicIds } from './ask-context';
import { serverFetch, StrapiError } from './strapi-server';

// The learner model on the server (P3-1): a signed-in reader's progress, quiz attempts and active
// days, kept in Strapi (cms/src/api/learner-progress) and keyed by the topic's documentId, which
// the content sync never changes, so renaming a topic keeps everyone's progress. What a reader
// sends is checked against the content this server was built with: sections and quizzes the
// topic has, its contentVersion, and quiz answers scored here, never taken from the browser.
// Like Ask threads, every call is scoped to the signed-in reader and made with the server token.

/** What a topic of this build offers the learner model. */
type CatalogTopic = {
  key: string;
  system: string;
  slug: string;
  version: string | null;
  /** Its sections' block keys, in order. */
  sections: string[];
  /** Its quizzes by block key: the section each follows and the right option per question (0 to 3). */
  quizzes: Map<string, { section: string | null; answers: number[] }>;
  xp: XpTopic;
  content: Topic['content'];
};

const quizAnswers = (q: QuizBlock) => q.questions.map((x) => 'ABCD'.indexOf(x.answer));

function catalogTopic(t: Topic): CatalogTopic {
  const sections: string[] = [];
  const quizzes = new Map<string, { section: string | null; answers: number[] }>();
  for (const b of t.content) {
    if (b.__component === 'sd.section' && b.key) sections.push(b.key);
    else if (b.__component === 'sd.quiz' && b.key && b.questions.length) {
      quizzes.set(b.key, { section: sections.at(-1) ?? null, answers: quizAnswers(b) });
    }
  }
  return {
    key: topicKey(t.system.slug, t.slug),
    system: t.system.slug,
    slug: t.slug,
    version: t.contentVersion ?? null,
    sections,
    quizzes,
    xp: { xp: t.xp ?? 0, sectionCount: sections.length, quizCount: quizzes.size },
    content: t.content,
  };
}

/**
 * What a reader with these topic entitlements (entitlements.ts) can record of a topic: null for
 * everything, or, when they get only the free tier's cut of it (lib/free-tier.ts), the sections
 * with nothing locked and the quizzes left in the cut. A section locked in part (Requirements, when
 * only its Functional requirements are open) isn't recorded: it would count as read, towards the
 * topic and its XP, after an upgrade the reader hasn't read the rest of it since. Nothing else they
 * send about it counts.
 */
export function recordable(t: Pick<CatalogTopic, 'key' | 'content'>, topics: 'all' | FreeTier): { sections: Set<string>; quizzes: Set<string> } | null {
  if (topics === 'all' || freeInFull(topics, t.key)) return null;
  const cut = freeCut(t.content, topics.previewSections);
  const sections = new Set<string>();
  const quizzes = new Set<string>();
  let section = -1;
  for (const b of cut.content) {
    if (b.__component === 'sd.section') {
      section++;
      if (cut.locks[section] === 'none' && b.key) sections.add(b.key);
    } else if (b.__component === 'sd.quiz' && b.key) quizzes.add(b.key);
  }
  return { sections, quizzes };
}

let built: { from: Topic[]; topics: Map<string, CatalogTopic> } | null = null;

/** Every topic this build publishes, by `<system>/<topic>`. */
async function catalog(): Promise<Map<string, CatalogTopic>> {
  const topics = await getTopics();
  if (built?.from !== topics) {
    built = { from: topics, topics: new Map(topics.filter((t) => t.available).map((t) => [topicKey(t.system.slug, t.slug), catalogTopic(t)])) };
  }
  return built.topics;
}

/** The published topic a key names, reading old slugs as the current ones (content/slug-aliases.yaml). */
async function findTopic(key: string): Promise<CatalogTopic | null> {
  const topics = await catalog();
  const [system, slug] = key.split('/');
  if (!system || !slug) return null;
  return topics.get(key) ?? topics.get(canonicalTopic(await getAliases(), system, slug) ?? '') ?? null;
}

// ---------- what the browser sends ----------

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CID = /^[A-Za-z0-9_-]{8,64}$/;
const isTopicKey = (v: string) => {
  const [system, slug, extra] = v.split('/');
  return extra === undefined && SLUG.test(system ?? '') && SLUG.test(slug ?? '');
};
const blockKeys = (v: unknown, max: number): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every((k) => typeof k === 'string' && k.length <= 64 && KEY.test(k)) ? [...new Set(v as string[])] : null;

/** Most topics and attempts one request may carry: a browser's backlog from a long time signed out. */
export const MAX_TOPICS = 500;
export const MAX_ATTEMPTS = 100;
const MAX_SECTIONS = 200;

export type ProgressInput = {
  /** The reader's own day now: the streak is counted to it. */
  today: string;
  topics: { key: string; sections: string[]; complete: boolean; day: string | null }[];
  attempts: { id: string; key: string; quiz: string; picks: (number | null)[]; day: string | null }[];
  days: string[];
};

/**
 * A day the reader may say they were active: today (theirs), or a past day at most MAX_DAYS ago.
 * Days are the reader's to report (the server has no clock of theirs); others are left out, so a
 * streak can't be written for days yet to come.
 */
function recentDay(v: string, now: number): string | null {
  const latest = new Date(now + 14 * 3_600_000).toISOString().slice(0, 10);
  return v <= latest && v >= shiftDay(latest, -MAX_DAYS) ? v : null;
}

/** A well-formed day or null: the day itself when recent, else null (undefined when malformed). */
const dayField = (v: unknown, now: number): string | null | undefined => (v == null ? null : isDay(v) ? recentDay(v, now) : undefined);

/** Validates what the browser sends to POST /api/progress; null when anything in it is malformed. */
export function readProgressInput(body: Record<string, unknown> | null, now = Date.now()): ProgressInput | null {
  if (!body || typeof body.today !== 'string' || !isToday(body.today, now)) return null;
  const rawTopics = body.topics ?? {};
  if (!rawTopics || typeof rawTopics !== 'object' || Array.isArray(rawTopics)) return null;
  const entries = Object.entries(rawTopics as Record<string, unknown>);
  if (entries.length > MAX_TOPICS) return null;
  const topics: ProgressInput['topics'] = [];
  for (const [key, v] of entries) {
    const p = (v ?? {}) as Record<string, unknown>;
    const sections = blockKeys(p.sections ?? [], MAX_SECTIONS);
    const day = dayField(p.day, now);
    if (!isTopicKey(key) || !sections || day === undefined || (p.complete !== undefined && typeof p.complete !== 'boolean')) return null;
    topics.push({ key, sections, complete: p.complete === true, day });
  }
  const rawAttempts = body.attempts ?? [];
  if (!Array.isArray(rawAttempts) || rawAttempts.length > MAX_ATTEMPTS) return null;
  const attempts: ProgressInput['attempts'] = [];
  for (const v of rawAttempts) {
    const a = (v ?? {}) as Record<string, unknown>;
    const picks = Array.isArray(a.picks) && a.picks.length <= 50 && a.picks.every((x) => x === null || (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 3)) ? (a.picks as (number | null)[]) : null;
    const day = dayField(a.day, now);
    if (typeof a.id !== 'string' || !CID.test(a.id) || typeof a.key !== 'string' || !isTopicKey(a.key)) return null;
    if (typeof a.quiz !== 'string' || !KEY.test(a.quiz) || !picks || day === undefined) return null;
    attempts.push({ id: a.id, key: a.key, quiz: a.quiz, picks, day });
  }
  const days = body.days ?? [];
  if (!Array.isArray(days) || days.length > MAX_DAYS || !days.every(isDay)) return null;
  return { today: body.today, topics, attempts, days: days.map((d) => recentDay(d, now)).filter((d): d is string => d !== null) };
}

/** An attempt scored against the quiz as this build has it; null when the topic has no such quiz. */
export function scoreAttempt(t: CatalogTopic, quiz: string, picks: readonly (number | null)[]) {
  const q = t.quizzes.get(quiz);
  if (!q) return null;
  const answers = q.answers.map((right, i) => {
    const pick = picks[i] ?? null;
    return { q: i, pick, correct: pick !== null && pick === right };
  });
  if (!answers.some((a) => a.pick !== null)) return null;
  return { section: q.section, answers, score: answers.filter((a) => a.correct).length, total: answers.length };
}

// ---------- Strapi ----------

/** The CMS doesn't have the learner routes yet (web deployed first). */
const missingRoute = (err: unknown) => err instanceof StrapiError && (err.status === 404 || err.status === 405);

export class LearnerUnavailable extends Error {}

async function call<T>(op: string, data: Record<string, unknown>): Promise<T> {
  try {
    return (await serverFetch<{ data: T }>(`/learner/${op}`, { method: 'POST', body: JSON.stringify({ data }) })).data;
  } catch (err) {
    if (missingRoute(err)) throw new LearnerUnavailable('The CMS has no learner model yet (deploy the CMS first)');
    throw err;
  }
}

/**
 * Records what the reader did (from one browser) in their account. Topics and quizzes this build
 * doesn't publish are skipped, and so is anything the reader's plan locks (`access`, from
 * entitlements.ts topicsFor): a Free reader records only what the free tier's cut of a topic shows.
 */
export async function mergeProgress(readerId: string, input: ProgressInput, access: 'all' | FreeTier = 'all'): Promise<{ sections: number; quizzes: number; days: number }> {
  const topics = [];
  for (const p of input.topics) {
    const t = await findTopic(p.key);
    const ids = t && (await topicIds(t.system, t.slug));
    if (!t || !ids || !t.sections.length) continue;
    const only = recordable(t, access);
    topics.push({
      topic: ids.topicDocumentId,
      contentVersion: t.version,
      sections: p.sections.filter((k) => t.sections.includes(k) && (!only || only.sections.has(k))),
      valid: t.sections,
      need: sectionsNeeded(t.sections.length),
      // A topic with locked sections can't be finished on the free tier.
      complete: only ? false : p.complete,
      day: p.day,
    });
  }
  const attempts = [];
  for (const a of input.attempts) {
    const t = await findTopic(a.key);
    if (t && !(recordable(t, access)?.quizzes.has(a.quiz) ?? true)) continue;
    const scored = t && scoreAttempt(t, a.quiz, a.picks);
    const ids = scored && (await topicIds(t.system, t.slug));
    if (!t || !scored || !ids) continue;
    attempts.push({
      topic: ids.topicDocumentId,
      contentVersion: t.version,
      quizKey: a.quiz,
      sectionKey: scored.section,
      answers: scored.answers,
      score: scored.score,
      total: scored.total,
      clientId: a.id,
      day: a.day,
    });
  }
  const days = [...new Set(input.days)];
  if (!topics.length && !attempts.length && !days.length) return { sections: 0, quizzes: 0, days: 0 };
  return call('merge', { readerId, topics, attempts, days });
}

type RawSummary = {
  progress: { topic: string | null; slug: string | null; system: string | null; contentVersion: string | null; sections: string[]; completedAt: string | null }[];
  quizzes: { slug: string; system: string | null; quizKey: string; best: number }[];
  days: string[];
};

/** The reader's learner state, keyed by current slugs, with the streak to `today` and their XP. */
export async function progressSummary(readerId: string, today: string): Promise<ProgressSummary> {
  const [raw, topics] = await Promise.all([call<RawSummary>('summary', { readerId }), catalog()]);
  const state: LearnerState = { topics: {}, quizzes: {}, days: raw.days.filter(isDay).sort().slice(-MAX_DAYS) };
  for (const p of raw.progress) {
    if (!p.system || !p.slug) continue;
    const key = topicKey(p.system, p.slug);
    const current = topics.get(key)?.sections;
    // Sections the topic no longer has don't count towards it.
    const sections = current ? p.sections.filter((k) => current.includes(k)) : p.sections;
    state.topics[key] = { sections, complete: p.completedAt !== null, version: p.contentVersion };
  }
  for (const q of raw.quizzes) {
    if (!q.system) continue;
    const key = topicKey(q.system, q.slug);
    (state.quizzes[key] ??= {})[q.quizKey] = q.best;
  }
  const xp = totalXp(new Map([...topics].map(([k, t]) => [k, t.xp])), state);
  return { ...state, streak: streak(state.days, today), xp };
}

/** Everything the learner model holds for the reader, for their data export; empty when the CMS has no learner model yet. */
export async function exportProgress(readerId: string): Promise<Record<string, unknown>> {
  try {
    return await call('export', { readerId });
  } catch (err) {
    if (err instanceof LearnerUnavailable) return { progress: [], quizAttempts: [], activeDays: [] };
    throw err;
  }
}

/** Deletes the reader's progress, quiz attempts and active days (when their account is deleted). */
export async function deleteProgress(readerId: string): Promise<void> {
  try {
    await call('purge', { readerId });
  } catch (err) {
    if (!(err instanceof LearnerUnavailable)) throw err;
  }
}
