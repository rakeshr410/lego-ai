import { interviewMinutes, type STAGE_KINDS } from '@arrowbox/content-kit';
import { sectionAnchors } from './anchors';
import type { SnapshotDrill, SnapshotInterview } from './content-snapshot';
import { interviewSystemOpen } from './flags';
import { FLAGS, getSystems, getTopics } from './sd';

// Mock interview plans for pages (P3-11), at build time only (pages call these in their frontmatter;
// components import nothing but its types): which systems have one, and the candidate-facing part of
// a plan for its landing page and room. The private fields (briefs, follow-ups, signals, red flags,
// the grader's brief) never leave the server: pages get only what toInterviewPage copies.
//
// Drills (docs/README.md, "Drills"): on a track with `interviewDrills`, each topic and each
// of its sections is a short interview of its own. A system's page lists them; a concept system (no
// whole-product plan) has a page of drills only. A drill's own projection is served by
// /api/interview?topic=…, not prerendered: the system's page is the one HTML for every scope.

export type InterviewDrill = {
  topic: string;
  /** The section's key, or null for the topic's drill. */
  section: string | null;
  /** The topic's title, or the section's. */
  title: string;
  minutes: number;
  /** The drill's page: the system's interview page with the scope in the query. */
  href: string;
};

export type InterviewPage = {
  system: { slug: string; name: string; icon: string | null };
  /** The system's whole interview, or a topic's or a section's drill. */
  scope: 'system' | 'topic' | 'section';
  topic: string | null;
  section: string | null;
  /** The system has a whole-product interview; false on a concept system's page, which has drills only. */
  full: boolean;
  title: string;
  summary: string;
  minutes: number;
  feedbackMinutes: number;
  stages: { key: string; kind: (typeof STAGE_KINDS)[number]; title: string; minutes: number; goal: string; sections: string[] }[];
  /** The sections the interview covers (ADR 0003): what the feedback is reported by, each linking to its heading. Empty for a plan used whole. */
  sections: { key: string; title: string; topic: string; href: string | null }[];
  /** Derived from the system's topics, or a hand-written plan used whole. */
  derived: boolean;
  dimensions: { key: string; title: string; description: string | null }[];
  readFirst: { title: string; href: string | null }[];
  checklist: string[];
  /** The system's drills, topics in order and each topic's sections after it; empty on a drill's own page and on tracks without drills. */
  drills: InterviewDrill[];
  /** A coaching playlist's lesson (docs/coaching.md): `system` is then the playlist, and the page is the lesson's own. */
  course?: { playlist: string; lesson: string; hub: string; href: string };
};

/** A coaching playlist's page: its lessons in order. */
export type PlaylistPage = {
  slug: string;
  title: string;
  summary: string;
  outline: string;
  lessons: { slug: string; title: string; summary: string; minutes: number; parts: string[]; href: string }[];
};

const publishedStatus = (status: SnapshotInterview['reviewStatus']) => !FLAGS.reviewedOnly || status === 'reviewed';

/** Published plans: all of them, or only reviewed ones in a reviewed-only build (like topics), on the systems the build opens. */
async function plans(): Promise<SnapshotInterview[]> {
  const { getSnapshot } = await import('./content-snapshot');
  return (getSnapshot().interviews ?? []).filter((i) => publishedStatus(i.reviewStatus) && interviewSystemOpen(i.system));
}

/** Published drills, the same way. */
async function drills(): Promise<SnapshotDrill[]> {
  const { getSnapshot } = await import('./content-snapshot');
  return (getSnapshot().drills ?? []).filter((d) => publishedStatus(d.reviewStatus) && interviewSystemOpen(d.system));
}

/** The systems with an interview page (a whole interview, or drills only); none while the interview flag is off. */
export async function interviewSystems(): Promise<Set<string>> {
  if (!FLAGS.interview) return new Set();
  const [all, allDrills] = await Promise.all([plans(), drills()]);
  return new Set([...all.map((p) => p.system), ...allDrills.map((d) => d.system)]);
}

type TopicOf = (slug: string) => { title: string; slug: string; available: boolean; system: { slug: string } } | undefined;

const topicLookup = (topics: Awaited<ReturnType<typeof getTopics>>, system: string): TopicOf => (slug) => topics.find((t) => t.system.slug === system && t.slug === slug);

/** The system's drills as its page lists them: each topic's, then its sections'. */
export function drillList(list: readonly SnapshotDrill[], system: string, topicOf: TopicOf): InterviewDrill[] {
  const own = list.filter((d) => d.system === system);
  return own
    .filter((d) => d.section === null)
    .flatMap((d) => {
      const topic = topicOf(d.topic);
      if (!topic?.available) return [];
      const href = (section: string | null) => `/systems/${system}/interview?topic=${encodeURIComponent(d.topic)}${section ? `&section=${encodeURIComponent(section)}` : ''}`;
      return [
        { topic: d.topic, section: null, title: topic.title, minutes: interviewMinutes(d.plan), href: href(null) },
        ...own
          .filter((x) => x.topic === d.topic && x.section !== null)
          .map((x) => ({ topic: d.topic, section: x.section, title: x.plan.sections[0]?.title ?? x.section!, minutes: interviewMinutes(x.plan), href: href(x.section) })),
      ];
    });
}

/** Every interview page's props; none while the interview flag is off. */
export async function getInterviewPages(): Promise<InterviewPage[]> {
  if (!FLAGS.interview) return [];
  const [all, allDrills, systems, topics] = await Promise.all([plans(), drills(), getSystems(), getTopics()]);
  const slugs = [...new Set([...all.map((p) => p.system), ...allDrills.map((d) => d.system)])];
  return slugs.flatMap((slug) => {
    const system = systems.find((s) => s.slug === slug);
    if (!system) return [];
    const topicOf = topicLookup(topics, slug);
    const sys = { slug: system.slug, name: system.name, icon: system.icon ?? null };
    const entry = all.find((p) => p.system === slug);
    const list = drillList(allDrills, slug, topicOf);
    if (entry) return [{ ...toInterviewPage(entry, sys, topicOf), drills: list }];
    // A concept system: the page is its drills.
    const page: InterviewPage = {
      system: sys,
      scope: 'system',
      topic: null,
      section: null,
      full: false,
      title: system.name,
      summary: system.summary ?? '',
      minutes: 0,
      feedbackMinutes: 0,
      stages: [],
      sections: [],
      derived: true,
      dimensions: [],
      readFirst: list.filter((d) => d.section === null).map((d) => ({ title: d.title, href: topicOf(d.topic)?.available ? `/systems/${slug}/${d.topic}` : null })),
      checklist: [],
      drills: list,
    };
    return [page];
  });
}

/**
 * A drill's page projection for the API (the system's page is prerendered; a drill's is fetched
 * with the overview), or null when the system or the drill is not published.
 */
export async function drillPage(system: string, topic: string, section: string | null): Promise<InterviewPage | null> {
  if (!FLAGS.interview) return null;
  const [allDrills, systems, topics] = await Promise.all([drills(), getSystems(), getTopics()]);
  const drill = allDrills.find((d) => d.system === system && d.topic === topic && d.section === section);
  const sys = systems.find((s) => s.slug === system);
  if (!drill || !sys) return null;
  return toInterviewPage({ plan: drill.plan, derived: true }, { slug: sys.slug, name: sys.name, icon: sys.icon ?? null }, topicLookup(topics, system));
}

/** The drill links a topic page's rail offers: the topic's drill and each section's, by section key. */
export async function topicDrillLinks(system: string, topic: string): Promise<{ topic: string | null; sections: Record<string, string> } | null> {
  if (!FLAGS.interview) return null;
  const own = (await drills()).filter((d) => d.system === system && d.topic === topic);
  if (!own.length) return null;
  const href = (section: string | null) => `/systems/${system}/interview?topic=${encodeURIComponent(topic)}${section ? `&section=${encodeURIComponent(section)}` : ''}`;
  return {
    topic: own.some((d) => d.section === null) ? href(null) : null,
    sections: Object.fromEntries(own.filter((d) => d.section !== null).map((d) => [d.section!, href(d.section)])),
  };
}

export function toInterviewPage(entry: Pick<SnapshotInterview, 'plan' | 'derived'>, system: InterviewPage['system'], topicOf: TopicOf): InterviewPage {
  const p = entry.plan;
  return {
    system,
    scope: p.scope,
    topic: p.topic ?? null,
    section: p.section ?? null,
    full: true,
    title: p.title,
    summary: p.summary,
    minutes: interviewMinutes(p),
    feedbackMinutes: p.feedbackMinutes ?? 0,
    stages: p.stages.map((s) => ({ key: s.key, kind: s.kind, title: s.title, minutes: s.minutes, goal: s.goal, sections: s.sections })),
    sections: p.sections.map((s) => {
      const t = topicOf(s.topic);
      // The heading's id as the topic page gives it (anchors.ts), from the topic's sections in order.
      const own = p.sections.filter((x) => x.topic === s.topic);
      const anchors = sectionAnchors(own.map((x, i) => ({ section: { id: i, title: x.title, railLabel: x.railLabel }, subs: [] })));
      const anchor = anchors.sections[own.indexOf(s)];
      return { key: s.key, title: s.title, topic: s.topic, href: t?.available ? `/systems/${t.system.slug}/${t.slug}${anchor ? `#${anchor}` : ''}` : null };
    }),
    derived: entry.derived,
    dimensions: p.dimensions.map((d) => ({ key: d.key, title: d.title, description: d.description ?? null })),
    readFirst: (p.readFirst ?? []).flatMap((slug) => {
      const t = topicOf(slug);
      return t ? [{ title: t.title, href: t.available ? `/systems/${t.system.slug}/${t.slug}` : null }] : [];
    }),
    checklist: p.checklist ?? [],
    drills: [],
  };
}

// Coaching playlists (docs/coaching.md): /coach/<playlist> lists its lessons, /coach/<playlist>/<lesson>
// is a lesson's landing page and room, the coach's own, built from the lesson's plan like a drill's.

/** Every playlist's page; none while the interview flag is off. */
export async function getPlaylistPages(): Promise<PlaylistPage[]> {
  if (!FLAGS.interview) return [];
  const { playlists } = await import('./server/coaching/lessons');
  return playlists().map((pl) => ({
    slug: pl.slug,
    title: pl.title,
    summary: pl.summary,
    outline: pl.outline,
    lessons: pl.lessons.map((l) => ({
      slug: l.slug,
      title: l.title,
      summary: l.summary,
      minutes: l.parts.reduce((n, p) => n + p.minutes, 0),
      parts: l.parts.map((p) => p.title),
      href: `/coach/${pl.slug}/${l.slug}`,
    })),
  }));
}

/** A lesson's page, or null when the lesson (or one of its sections) is not in this build. */
export async function lessonPage(playlist: string, lesson: string): Promise<InterviewPage | null> {
  if (!FLAGS.interview) return null;
  const { lessonPlan } = await import('./server/coaching/lessons');
  const plan = lessonPlan(playlist, lesson);
  if (!plan?.lesson) return null;
  const topics = await getTopics();
  const systems = new Set(plan.lesson.sections.map((s) => s.system));
  // A lesson's sections come from several systems; a topic slug is looked up among them.
  const topicOf: TopicOf = (slug) => topics.find((t) => t.slug === slug && systems.has(t.system.slug));
  const hub = `/coach/${playlist}`;
  return {
    ...toInterviewPage({ plan: plan.plan, derived: true }, { slug: plan.system.slug, name: plan.system.name, icon: null }, topicOf),
    readFirst: [],
    course: { playlist, lesson, hub, href: `${hub}/${lesson}` },
  };
}

/** Every lesson's page, for the prerendered routes. */
export async function getLessonPages(): Promise<InterviewPage[]> {
  const pages = await getPlaylistPages();
  const out = await Promise.all(pages.flatMap((pl) => pl.lessons.map((l) => lessonPage(pl.slug, l.slug))));
  return out.filter((p): p is InterviewPage => !!p);
}
