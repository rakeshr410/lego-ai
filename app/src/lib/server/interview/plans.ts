import type { DerivedPlan } from '@arrowbox/content-kit';
import { getSnapshot, type SnapshotDrill, type SnapshotInterview } from '../../content-snapshot';
import { interviewSystemOpen } from '../../flags';
import { FLAGS } from '../../sd';

// A system's interview plan, from the content snapshot this server was built with (the same one
// its pages came from): derived from the system's sections (ADR 0003), with its hand-written plan
// merged in where one exists, and what the interviewer is grounded in: the tutor briefs of the
// topics the plan draws on. Plans follow topics' publishing rule: a reviewed-only build serves a
// plan only when every source topic is reviewed. A drill (docs/interview/README.md, "Drills") is
// a topic's or one section's short plan, on the tracks that derive them.

/** Which plan a session runs: the system's whole interview (null), or a topic's or one section's drill. */
export type PlanScope = { topic: string; section: string | null } | null;

export type Plan = {
  system: { slug: string; name: string };
  plan: DerivedPlan;
  /** The plan's hash: sessions record it and notice an edit; the rubric is pinned to it. */
  version: string;
  /** Key facts from the topics the plan draws on, by slug (topics with a tutor brief only). */
  briefs: { slug: string; title: string; brief: string }[];
  scope: PlanScope;
};

const published = (i: Pick<SnapshotInterview, 'reviewStatus'>) => !FLAGS.reviewedOnly || i.reviewStatus === 'reviewed';

/** The same scope, or both the whole interview. */
export const sameScope = (a: PlanScope | undefined, b: PlanScope | undefined) => (a?.topic ?? null) === (b?.topic ?? null) && (a?.section ?? null) === (b?.section ?? null);

/** The system's published plan, or the published drill the scope names, or null. */
export function getPlan(system: string, scope: PlanScope = null): Plan | null {
  // Early access: a system outside PUBLIC_INTERVIEW_SYSTEMS has no plan here, as it has no page.
  if (!interviewSystemOpen(system)) return null;
  const snapshot = getSnapshot();
  const sys = snapshot.systems.find((s) => s.slug === system);
  if (!sys) return null;
  const entry: SnapshotInterview | SnapshotDrill | undefined = scope
    ? (snapshot.drills ?? []).find((d) => d.system === system && d.topic === scope.topic && d.section === (scope.section ?? null) && published(d))
    : (snapshot.interviews ?? []).find((i) => i.system === system && published(i));
  if (!entry) return null;
  const slugs = [...new Set([...entry.plan.sourceTopics, ...(entry.plan.readFirst ?? []), ...entry.plan.stages.flatMap((s) => s.topics ?? [])])];
  const briefs = slugs.flatMap((slug) => {
    const t = snapshot.topics.find((x) => x.system === system && x.slug === slug);
    return t?.tutorBrief ? [{ slug, title: t.title, brief: t.tutorBrief }] : [];
  });
  return { system: { slug: sys.slug, name: sys.name }, plan: entry.plan, version: entry.hash, briefs, scope: scope ? { topic: scope.topic, section: scope.section ?? null } : null };
}

/** The system's published drills: its topics' and their sections', in topic then section order. */
export function getDrills(system: string): SnapshotDrill[] {
  if (!interviewSystemOpen(system)) return [];
  return (getSnapshot().drills ?? []).filter((d) => d.system === system && published(d));
}
