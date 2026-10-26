import { getStore } from '../store';
import type { CoachState } from '../interview/coach';
import type { Plan } from '../interview/plans';
import { coachingCatalog } from './material';

// What a playlist's lessons left with one learner (docs/coaching.md, "The learner's thread"):
// per lesson, whether it was finished, which of its points held, which stayed shaky, and the
// questions the coach parked. Updated after every coach move of a lesson; read when the learner
// starts the next lesson, so the coach builds on what held and revisits what did not. Kept by
// meaning (the points' words), not by item ids, which change when a pack is edited. Exported and
// deleted with the reader's sessions (privacy.md), and kept no longer than they are.

export type LessonProgress = {
  status: 'started' | 'finished';
  at: string;
  understood: string[];
  shaky: string[];
  parked: string[];
};
export type PlaylistProgress = { lessons: Record<string, LessonProgress> };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Points and questions kept per lesson. */
const KEEP = 12;
/** Lines of recall a new lesson is given, and their characters in all. */
const RECALL_LINES = 12;
const RECALL_CHARS = 2400;

export const progressKey = (readerId: string, playlist: string) => `coach:progress:${readerId}:${playlist}`;

export async function readProgress(readerId: string, playlist: string): Promise<PlaylistProgress> {
  const raw = await (await getStore()).get(progressKey(readerId, playlist));
  if (!raw) return { lessons: {} };
  try {
    const p = JSON.parse(raw) as PlaylistProgress;
    return p && typeof p.lessons === 'object' ? p : { lessons: {} };
  } catch {
    return { lessons: {} };
  }
}

/** The lesson's standing from the coach's state: each item's words by what became of it. */
export function lessonProgress(plan: Plan, state: CoachState | undefined, parked: readonly string[], finished: boolean, at: string): LessonProgress {
  const items = plan.plan.stages.flatMap((s) => s.items);
  const by = (status: string) => items.filter((i) => state?.items[i.id] === status).map((i) => i.text).slice(0, KEEP);
  return { status: finished ? 'finished' : 'started', at, understood: by('understood'), shaky: by('shaky'), parked: parked.slice(0, KEEP) };
}

/** Records a lesson's standing (a no-op for a session that is not a playlist's lesson). Never lowers a finished lesson. */
export async function recordProgress(readerId: string, plan: Plan, state: CoachState | undefined, parked: readonly string[], finished: boolean, retentionDays: number): Promise<void> {
  const info = plan.lesson;
  if (!info) return;
  const store = await getStore();
  const key = progressKey(readerId, info.playlist.slug);
  const now = new Date().toISOString();
  const all = await readProgress(readerId, info.playlist.slug);
  const was = all.lessons[info.slug];
  const next = lessonProgress(plan, state, [...new Set([...(was?.parked ?? []), ...parked])], finished || was?.status === 'finished', now);
  all.lessons[info.slug] = next;
  await store.set(key, JSON.stringify(all), retentionDays * DAY_MS);
}

/** What the coach is told of the learner's earlier lessons in the playlist, newest first (never the lesson being started). */
export function recallLines(progress: PlaylistProgress, titles: ReadonlyMap<string, string>, current: string): string[] {
  const lines: string[] = [];
  let chars = 0;
  const entries = Object.entries(progress.lessons)
    .filter(([slug]) => slug !== current && titles.has(slug))
    .sort(([, a], [, b]) => b.at.localeCompare(a.at));
  for (const [slug, l] of entries) {
    const parts = [
      `"${titles.get(slug)}" (${l.status})`,
      l.understood.length ? `held: ${l.understood.slice(0, 4).join('; ')}` : '',
      l.shaky.length ? `shaky: ${l.shaky.slice(0, 4).join('; ')}` : '',
      l.parked.length ? `asked and parked: ${l.parked.slice(0, 2).join('; ')}` : '',
    ].filter(Boolean);
    const line = parts.join(' — ');
    if (lines.length >= RECALL_LINES || chars + line.length > RECALL_CHARS) break;
    lines.push(line);
    chars += line.length;
  }
  return lines;
}

/** The recall for a lesson about to start. */
export async function recallFor(readerId: string, plan: Plan): Promise<string[]> {
  const info = plan.lesson;
  if (!info) return [];
  const pl = coachingCatalog().playlists.get(info.playlist.slug);
  const titles = new Map((pl?.lessons ?? []).map((l) => [l.slug, l.title] as const));
  return recallLines(await readProgress(readerId, info.playlist.slug), titles, info.slug);
}

/** Every playlist's progress for a reader (the account export). */
export async function exportProgress(readerId: string): Promise<Record<string, PlaylistProgress>> {
  const out: Record<string, PlaylistProgress> = {};
  for (const slug of coachingCatalog().playlists.keys()) {
    const p = await readProgress(readerId, slug);
    if (Object.keys(p.lessons).length) out[slug] = p;
  }
  return out;
}

/** Deletes a reader's progress on every playlist (account deletion). */
export async function purgeProgress(readerId: string): Promise<void> {
  const store = await getStore();
  for (const slug of coachingCatalog().playlists.keys()) await store.del(progressKey(readerId, slug));
}
