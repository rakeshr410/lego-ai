import { createHash } from 'node:crypto';
import type { DerivedItem, DerivedPlan, DerivedSection, DerivedStage } from '@arrowbox/content-kit';
import { getSnapshot } from '../../content-snapshot';
import { FLAGS } from '../../sd';
import type { Plan } from '../interview/plans';
import { lessonBoard } from './catalog';
import { startIds, type Layout } from './layout';
import { coachingCatalog, packStanding, packTopic, type PackStanding } from './material';
import type { ListPlan } from '../interview/draw';
import { listChars } from './catalog';
import { CELL, type Lesson, type Pack, type Playlist } from './schema';

// A playlist's lesson as the coach runs it (docs/coaching.md): turned into the plan shape the coach
// already teaches from (coach.ts), so the room, the voice, the quota, the progress rail and the
// export work on a lesson as on any coach session. Each part of the lesson is a stage; each pack is
// one of its sections; each beat is an item, its check the item's question and its misconceptions
// the wrong answers to listen for. A section whose pack is not usable (the article changed since,
// or the pack is a draft in a reviewed-only build) falls back to the article: one item for the
// section, taught from its text and its diagrams, as a coach lesson on a system is.

/** What a plan carries when it is a playlist's lesson (absent on a system's plans). */
export type LessonInfo = {
  playlist: { slug: string; title: string };
  slug: string;
  title: string;
  /** The lesson's board plan: every element and arrow its packs place, by id. */
  layout: Layout;
  /** Ids drawn before the first move (what the first pack keeps from earlier lessons). */
  start: string[];
  /** Each section the lesson teaches, in order, with the pack that teaches it when that pack is usable. */
  sections: { key: string; system: string; packId: string; standing: PackStanding; pack: Pack | null }[];
  /** The numbered lists of the lesson's packs, in board pixels (draw.ts places their lines in order). */
  lists: ListPlan[];
  /** The parts the learner gives first (coaching/schema.ts ask), as the coach runs them (coach.ts CoachAsk). */
  asks: LessonAsk[];
  /** What earlier lessons left with this learner (coaching/progress.ts), from the session; set when a session's plan is read. */
  recall?: string[];
};

const sectionKeyOf = (packId: string) => packId.split('/').slice(1).join('/');

/** An ask, by the lesson's items: which items' parts the learner gives, the ids drawn before asking, and the words. */
export type LessonAsk = {
  key: string;
  /** The list the learner's points go on in their words; without one, each point places the plan's element it matches. */
  list?: string;
  /** Item ids (`<section key>/<n>`), in order. */
  items: string[];
  /** Each item's parts the learner can give, by element id. */
  lines: Record<string, string[]>;
  /** Each item's other drawing (arrows, notes on why), placed with what the learner left out. */
  rest: Record<string, string[]>;
  /** What the asked beats draw before the coach asks (the frame, a heading). */
  before: string[];
  /** The parts' words, by element id. */
  labels: Record<string, string>;
  question: string;
  hints: string[];
  /** The characters a line in the learner's words may have. */
  chars: number;
};

function packLists(p: Pack): ListPlan[] {
  const label = (id: string) => p.board.elements.find((e) => e.id === id)?.label ?? id;
  return (p.board.lists ?? []).map((l) => ({
    id: l.id,
    x: l.at[0] * CELL,
    y: l.at[1] * CELL,
    step: l.step * CELL,
    slots: l.slots,
    chars: listChars(l),
    items: l.items.map((id) => ({ id, label: label(id) })),
  }));
}

function packAsks(p: Pack, key: string): LessonAsk[] {
  const kind = (id: string) => p.board.elements.find((e) => e.id === id)?.kind;
  const label = (id: string) => p.board.elements.find((e) => e.id === id)?.label ?? id;
  return (p.asks ?? []).map((a) => {
    const list = a.list ? p.board.lists?.find((l) => l.id === a.list) : undefined;
    const givable = new Set(list?.items ?? a.ids ?? []);
    const drawn = a.beats.flatMap((n) => p.beats[n - 1]?.draw ?? []);
    // The frame: named, or a list's heading and region, or the beats' regions the learner does not give.
    const before = a.frame ?? drawn.filter((id) => !givable.has(id) && (list ? !p.board.arrows.some((r) => r.id === id) : kind(id) === 'region'));
    const lines: Record<string, string[]> = {};
    const rest: Record<string, string[]> = {};
    for (const n of a.beats) {
      const draw = p.beats[n - 1]?.draw ?? [];
      lines[`${key}/${n}`] = draw.filter((id) => givable.has(id));
      rest[`${key}/${n}`] = draw.filter((id) => !givable.has(id) && !before.includes(id));
    }
    return {
      key: `${key}#${a.list ?? a.beats.join('-')}`,
      ...(a.list ? { list: a.list } : {}),
      items: a.beats.map((n) => `${key}/${n}`),
      lines,
      rest,
      before,
      labels: Object.fromEntries([...givable].map((id) => [id, label(id)])),
      question: a.question,
      hints: a.hints,
      chars: list ? listChars(list) - 4 : 40,
    };
  });
}

/** The playlists this build serves (none while the interview is off). */
export function playlists(): Playlist[] {
  if (!FLAGS.interview) return [];
  return [...coachingCatalog().playlists.values()];
}

export function getPlaylist(slug: string): Playlist | null {
  return playlists().find((p) => p.slug === slug) ?? null;
}

function packItems(p: Pack, key: string): DerivedItem[] {
  return p.beats.map((b, n) => ({
    id: `${key}/${n + 1}`,
    section: key,
    kind: b.kind,
    weight: b.weight,
    text: b.point,
    ...(b.check ? { probe: b.check } : {}),
    ...(b.misconceptions?.length ? { wrongSignals: b.misconceptions } : {}),
    ...(b.draw?.length ? { drawable: true } : {}),
    source: 'author' as const,
  }));
}

/** A section with no usable pack: one item, taught from the article's own text. */
function articleItems(key: string, title: string): DerivedItem[] {
  return [{ id: `${key}/1`, section: key, kind: 'mechanism', weight: 'core', text: `The ideas of "${title}", as the article explains them`, source: 'plan' }];
}

/** The lesson as a plan, or null when the playlist, the lesson or one of its sections is not in this build. */
export function lessonPlan(playlistSlug: string, lessonSlug: string): Plan | null {
  const pl = getPlaylist(playlistSlug);
  const lesson = pl?.lessons.find((l) => l.slug === lessonSlug);
  if (!pl || !lesson) return null;
  const { packs } = coachingCatalog();
  const ids = lesson.parts.flatMap((part) => part.packs);
  const sections: LessonInfo['sections'] = [];
  const planSections: DerivedSection[] = [];
  for (const id of ids) {
    const topic = packTopic(id);
    const p = packs.get(id);
    if (!topic || !p) return null;
    const standing = packStanding(p);
    if (standing === 'missing') return null;
    const key = sectionKeyOf(id);
    const usable = standing === 'fresh' ? p : null;
    sections.push({ key, system: id.split('/')[0], packId: id, standing, pack: usable });
    const items = usable ? packItems(usable, key) : articleItems(key, p.title);
    planSections.push({ key, topic: topic.slug, sectionKey: id.split('/')[2], title: p.title, railLabel: p.title, ordinal: null, kind: 'deep-dive', items, pmFacts: [], minutes: 0, weight: 1 });
  }
  const stages: DerivedStage[] = lesson.parts.map((part, n) => {
    const keys = part.packs.map(sectionKeyOf);
    const items = planSections.filter((s) => keys.includes(s.key)).flatMap((s) => s.items);
    const tasks = part.packs.flatMap((id) => {
      const s = sections.find((x) => x.packId === id);
      const task = s?.pack?.task;
      return task ? [{ prompt: task.prompt, expects: task.expects.map((i) => `${s.key}/${i}`) }] : [];
    });
    return {
      key: `part-${n + 1}`,
      kind: 'deep-dive',
      title: part.title,
      minutes: part.minutes,
      goal: `Understand ${part.title.charAt(0).toLowerCase()}${part.title.slice(1)}.`,
      opener: `Part ${n + 1}: ${part.title}.`,
      signals: items.filter((i) => i.weight === 'core').map((i) => i.text).slice(0, 12).concat(items.length ? [] : [part.title]),
      assesses: ['understanding'],
      sections: keys,
      items,
      drawTasks: tasks.slice(0, 1),
    };
  });
  const topics = [...new Set(ids.map((id) => id.split('/').slice(0, 2).join('/')))];
  const plan: DerivedPlan = {
    title: lesson.title,
    summary: lesson.summary,
    prompt: `${lesson.title}: ${lesson.summary}`,
    dimensions: [{ key: 'understanding', title: 'Understanding' }],
    feedbackMinutes: 0,
    scope: 'topic',
    profile: 'concept',
    system: pl.slug,
    stages,
    sections: planSections,
    pmFacts: [],
    sourceTopics: topics.map((t) => t.split('/')[1]),
    board: { components: [], edges: [] },
  };
  const layout = lessonBoard(packs, ids);
  const first = sections[0]?.pack;
  const snapshot = getSnapshot();
  const briefs = topics.flatMap((ref) => {
    const [system, slug] = ref.split('/');
    const t = snapshot.topics.find((x) => x.system === system && x.slug === slug);
    return t?.tutorBrief ? [{ slug, title: t.title, brief: t.tutorBrief }] : [];
  });
  // The plan's version: the lesson, its packs and which of them are in use. A pack restamped or a section gone stale changes it.
  const version = createHash('sha256')
    .update(JSON.stringify({ lesson, packs: sections.map((s) => [s.packId, s.standing, s.pack?.source.hash ?? null]) }))
    .digest('hex')
    .slice(0, 16);
  const info: LessonInfo = {
    playlist: { slug: pl.slug, title: pl.title },
    slug: lesson.slug,
    title: lesson.title,
    layout,
    start: first ? startIds(layout, first.board.keep) : [],
    sections,
    lists: sections.flatMap((s) => (s.pack ? packLists(s.pack) : [])),
    asks: sections.flatMap((s) => (s.pack ? packAsks(s.pack, s.key) : [])),
  };
  return { system: { slug: pl.slug, name: pl.title }, plan, version, briefs, scope: null, lesson: info };
}

/** The lesson after this one in its playlist, or null at the end. */
export function nextLesson(playlistSlug: string, lessonSlug: string): Lesson | null {
  const pl = getPlaylist(playlistSlug);
  const at = pl?.lessons.findIndex((l) => l.slug === lessonSlug) ?? -1;
  return at >= 0 ? (pl!.lessons[at + 1] ?? null) : null;
}
