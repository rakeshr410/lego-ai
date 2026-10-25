import type { DerivedItem, DerivedPlan, DerivedStage } from '@arrowbox/content-kit';
import { stageItems } from './director';
import { quoteMatches } from './evaluator';
import type { Feedback, Rating, Turn } from './sessions';

// Grading (design section 8): the grader model gives item-level verdicts with quotes; the
// ratings are computed here, by rules the candidate can read (docs/interview/README.md). A
// verdict that credits or blames the candidate without a quote from their own words is
// downgraded, so the written feedback can never say "you said X" when they did not.

export const VERDICTS = ['covered', 'partial', 'wrong', 'missing'] as const;
export type Verdict = (typeof VERDICTS)[number];

export type ItemVerdict = { id: string; verdict: Verdict; quote: string; note: string };

/** How ratings follow from core coverage and wrong answers (the rules the report states). */
export const RATING_RULES = {
  strong: { coverage: 0.9, wrong: 0 },
  solid: { coverage: 0.7, wrong: 1 },
  developing: { coverage: 0.4 },
} as const;

const covers = (v: Verdict | undefined) => v === 'covered';
const half = (v: Verdict | undefined) => v === 'partial';

/**
 * A rating for a set of items: 4 when at least 90% of the core items are covered and nothing is
 * wrong; 3 at 70% with at most one wrong; 2 at 40%; 1 when there is any evidence at all (something
 * covered, partial or wrong, or a declined item); 0 when the ground was never reached.
 */
export function rateItems(items: readonly DerivedItem[], verdicts: ReadonlyMap<string, Verdict>, reached: boolean): Rating {
  const core = items.filter((i) => i.weight === 'core');
  const pool = core.length ? core : items;
  if (!reached) return 0;
  // Reached, but none of its items made the stage's list: there was nothing to grade it on.
  if (!pool.length) return 1;
  const covered = pool.filter((i) => covers(verdicts.get(i.id))).length + pool.filter((i) => half(verdicts.get(i.id))).length / 2;
  const wrong = items.filter((i) => verdicts.get(i.id) === 'wrong').length;
  const coverage = covered / pool.length;
  if (coverage >= RATING_RULES.strong.coverage && wrong === RATING_RULES.strong.wrong) return 4;
  if (coverage >= RATING_RULES.solid.coverage && wrong <= RATING_RULES.solid.wrong) return 3;
  if (coverage >= RATING_RULES.developing.coverage) return 2;
  return 1;
}

/** Verdicts with their quotes checked against the candidate's turns: no quote, no credit and no blame. */
export function verifyVerdicts(plan: DerivedPlan, verdicts: readonly ItemVerdict[], turns: readonly Turn[]): ItemVerdict[] {
  const candidate = turns.filter((t) => t.role === 'candidate').map((t) => t.text);
  const interviewer = turns.filter((t) => t.role === 'interviewer').map((t) => t.text).join('\n');
  const known = new Set(plan.stages.flatMap((s) => s.items.map((i) => i.id)));
  const out: ItemVerdict[] = [];
  const seen = new Set<string>();
  for (const v of verdicts) {
    if (!known.has(v.id) || seen.has(v.id)) continue;
    seen.add(v.id);
    if (v.verdict === 'missing' || v.verdict === 'partial') {
      out.push({ ...v, quote: '' });
      continue;
    }
    const quoted = candidate.some((text) => quoteMatches(v.quote, text, interviewer));
    out.push(quoted ? v : { ...v, verdict: v.verdict === 'covered' ? 'partial' : 'missing', quote: '' });
  }
  return out;
}

export type Reached = { stages: Set<string>; sections: Set<string> };

/** The stages and sections the candidate said something in (a stage opened and left unanswered is not reached). */
export function reachedIn(turns: readonly Turn[]): Reached {
  const stages = new Set<string>();
  const sections = new Set<string>();
  for (const t of turns) {
    if (t.role !== 'candidate') continue;
    stages.add(t.stage);
    if (t.meta?.section) sections.add(t.meta.section);
  }
  return { stages, sections };
}

/** The sections of a stage the candidate reached: by turn metadata, or all of them when the metadata is missing. */
function sectionsReached(stage: DerivedStage, reached: Reached): Set<string> {
  if (!reached.stages.has(stage.key)) return new Set();
  const marked = stage.sections.filter((k) => reached.sections.has(k));
  return new Set(marked.length ? marked : stage.sections);
}

export type GraderOutput = {
  summary: string;
  items: ItemVerdict[];
  stages: { key: string; strengths: string[]; improvements: string[] }[];
  dimensions: { key: string; rating: Rating; note: string }[];
  nextSteps: string[];
};

/**
 * The feedback from the grader's verified verdicts: stage and section ratings by the rules,
 * weak areas (sections rated 1 or 2 that were reached), what was not covered (sections never
 * reached), the item verdicts (what to read), and the rubric version.
 */
export function assembleFeedback(plan: DerivedPlan, out: GraderOutput, turns: readonly Turn[], rubricVersion: string): Omit<Feedback, 'at'> {
  const verdicts = new Map(out.items.map((v) => [v.id, v.verdict] as const));
  const reached = reachedIn(turns);
  // A hand-written plan used whole has stages that name no sections: nothing to report by section.
  const sections = (plan.override === 'whole' ? [] : plan.sections).map((sec) => {
    const stage = plan.stages.find((s) => s.sections.includes(sec.key));
    const items = stage ? stageItems(stage).filter((i) => i.section === sec.key) : [];
    const was = stage ? sectionsReached(stage, reached).has(sec.key) : false;
    return { key: sec.key, rating: rateItems(items, verdicts, was), items: items.length };
  });
  // A stage's rating is the item-weighted mean of its sections' (sections never reached left out;
  // all unreached: 0), rounded half up; a stage without sections is rated on its items directly.
  const stages = plan.stages.map((s) => {
    const text = out.stages.find((x) => x.key === s.key);
    const own = sections.filter((x) => s.sections.includes(x.key) && x.rating > 0);
    const weight = own.reduce((n, x) => n + x.items, 0);
    const rating: Rating = !s.sections.length
      ? rateItems(stageItems(s), verdicts, reached.stages.has(s.key))
      : own.length && weight
        ? (Math.floor(own.reduce((n, x) => n + x.rating * x.items, 0) / weight + 0.5) as Rating)
        : 0;
    return { key: s.key, rating, strengths: text?.strengths ?? [], improvements: text?.improvements ?? [] };
  });
  return {
    summary: out.summary,
    stages,
    dimensions: plan.dimensions.map((d) => out.dimensions.find((x) => x.key === d.key) ?? { key: d.key, rating: 0, note: '' }),
    nextSteps: out.nextSteps,
    sections: sections.map(({ key, rating }) => ({ key, rating })),
    weakAreas: sections.filter((s) => s.rating === 1 || s.rating === 2).map((s) => s.key),
    notCovered: sections.filter((s) => s.rating === 0).map((s) => s.key),
    items: out.items.flatMap((v) => {
      const item = plan.stages.flatMap((s) => s.items).find((i) => i.id === v.id);
      return item ? [{ id: v.id, section: item.section, text: item.text, verdict: v.verdict, note: v.note, quote: v.quote }] : [];
    }),
    rubricVersion,
  };
}
