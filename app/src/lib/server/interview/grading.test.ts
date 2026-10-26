import { derivePlans, type DerivedPlan } from '@arrowbox/content-kit';
import { loadContent } from '@arrowbox/content-kit/node';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stageItems } from './director';
import { assembleFeedback, rateItems, reachedIn, verifyVerdicts, type ItemVerdict } from './grading';
import type { Turn } from './sessions';
import { snapshotPaths } from '../../content-snapshot.node';

// The rating rules (design section 8), on the customer-support-agent plan: ratings follow core
// coverage and wrong answers by fixed thresholds; a verdict without the candidate's words behind
// it is downgraded; sections the candidate never reached are not held against them.

// lego's content/ (CONTENT_DIR overrides it), where the build reads it too.
const contentDir = snapshotPaths(fileURLToPath(new URL('../../../../', import.meta.url))).contentDir;
const { catalog } = loadContent(contentDir);
const system = catalog.systems.find((s) => s.slug === 'customer-support-agent')!;
const plan: DerivedPlan = derivePlans({ system, topics: catalog.topics.filter((t) => t.system === system.slug).map((t) => ({ slug: t.slug, file: t.file, data: t.data })), override: null }).system!;

const stage = plan.stages[1];
const items = stageItems(stage);
const core = items.filter((i) => i.weight === 'core');
type V = ItemVerdict['verdict'];
const verdictMap = (pairs: readonly (readonly [string, V])[]) => new Map<string, V>(pairs.map(([k, v]) => [k, v]));

describe('rateItems', () => {
  it('follows the thresholds: 90% and nothing wrong is strong, 70% with one wrong solid, 40% developing, any evidence 1, unreached 0', () => {
    expect(core.length).toBe(5);
    const all = verdictMap(core.map((i) => [i.id, 'covered' as V]));
    expect(rateItems(items, all, true)).toBe(4);
    const fourOfFive = verdictMap(core.slice(0, 4).map((i) => [i.id, 'covered' as V]));
    expect(rateItems(items, fourOfFive, true)).toBe(3);
    const fourWithWrong = verdictMap([...core.slice(0, 4).map((i) => [i.id, 'covered'] as const), [core[4].id, 'wrong'] as const]);
    expect(rateItems(items, fourWithWrong, true)).toBe(3);
    const twoWrong = verdictMap([...core.slice(0, 3).map((i) => [i.id, 'covered'] as const), [core[3].id, 'wrong'] as const, [core[4].id, 'wrong'] as const]);
    expect(rateItems(items, twoWrong, true)).toBe(2);
    const two = verdictMap(core.slice(0, 2).map((i) => [i.id, 'covered' as V]));
    expect(rateItems(items, two, true)).toBe(2);
    const one = verdictMap([[core[0].id, 'partial' as V]]);
    expect(rateItems(items, one, true)).toBe(1);
    expect(rateItems(items, new Map(), true)).toBe(1);
    expect(rateItems(items, all, false)).toBe(0);
  });

  it('gives partial answers half credit', () => {
    const halves = verdictMap(core.map((i) => [i.id, 'partial' as V]));
    expect(rateItems(items, halves, true)).toBe(2);
  });
});

describe('verifyVerdicts', () => {
  const turns: Turn[] = [
    { role: 'interviewer', stage: stage.key, text: 'How would you keep the handoff summary short? Perhaps a token budget?', at: 't0' },
    { role: 'candidate', stage: stage.key, text: 'I would store the conversation state in Redis keyed by the ticket id, with a 24-hour TTL.', at: 't1', meta: { section: stage.sections[0] } },
  ];

  it('keeps a covered verdict whose quote is the candidate’s, downgrades one that is not, and drops unknown items', () => {
    const out = verifyVerdicts(
      plan,
      [
        { id: core[0].id, verdict: 'covered', quote: 'store the conversation state in Redis keyed by the ticket id', note: 'Right.' },
        { id: core[1].id, verdict: 'covered', quote: 'a short summary with a token budget', note: 'Right.' },
        { id: core[2].id, verdict: 'wrong', quote: 'I would never use a TTL', note: 'A TTL is needed.' },
        { id: core[3].id, verdict: 'missing', quote: '', note: 'Not said.' },
        { id: 'nope/none/1', verdict: 'covered', quote: 'anything', note: '' },
        { id: core[0].id, verdict: 'wrong', quote: 'duplicate', note: '' },
      ],
      turns,
    );
    expect(out.map((v) => [v.id, v.verdict])).toEqual([
      [core[0].id, 'covered'],
      [core[1].id, 'partial'],
      [core[2].id, 'missing'],
      [core[3].id, 'missing'],
    ]);
  });

  it('does not credit words the interviewer said first', () => {
    const echoed: Turn[] = [turns[0], { role: 'candidate', stage: stage.key, text: 'Perhaps a token budget, yes.', at: 't1' }];
    const out = verifyVerdicts(plan, [{ id: core[1].id, verdict: 'covered', quote: 'perhaps a token budget', note: '' }], echoed);
    expect(out[0].verdict).toBe('partial');
  });
});

describe('assembleFeedback', () => {
  const turns: Turn[] = [
    { role: 'interviewer', stage: plan.stages[0].key, text: 'opener', at: 't0', meta: { source: 'opener' } },
    { role: 'candidate', stage: plan.stages[0].key, text: 'An answer about the problem, long enough to count as one here.', at: 't1', meta: { section: plan.stages[0].sections[0] } },
    { role: 'event', stage: stage.key, text: '[Stage 2 of 6 begins]', at: 't2', meta: { stage: 1 } },
    { role: 'candidate', stage: stage.key, text: 'Another answer, in the second stage, first section only.', at: 't3', meta: { section: stage.sections[0] } },
  ];

  it('rates stages and sections, lists weak areas among reached sections and the rest as not covered', () => {
    const verdicts: ItemVerdict[] = core.filter((i) => i.section === stage.sections[0]).map((i) => ({ id: i.id, verdict: 'covered', quote: '', note: 'ok' }));
    const f = assembleFeedback(plan, { summary: 's', items: verdicts, stages: [{ key: stage.key, strengths: ['a'], improvements: [] }], dimensions: [], nextSteps: [] }, turns, 'rubric-1');
    expect(reachedIn(turns).stages).toEqual(new Set([plan.stages[0].key, stage.key]));
    // Stage 1 was reached with no verdicts: its reached section is 1, the other left out: 1. Stage 2:
    // its first section's core covered (4), its second never reached and left out: 4. Stages 3-6: 0.
    expect(f.stages.map((s) => s.rating).slice(2)).toEqual([0, 0, 0, 0]);
    expect(f.stages[0].rating).toBe(1);
    expect(f.stages[1].rating).toBe(4);
    expect(f.stages[1].strengths).toEqual(['a']);
    const first = f.sections!.find((s) => s.key === stage.sections[0])!;
    expect(first.rating).toBe(4);
    // The stage's second section was never reached (no candidate turn carries it): 0, listed as not covered.
    const second = f.sections!.find((s) => s.key === stage.sections[1])!;
    expect(second.rating).toBe(0);
    expect(f.notCovered).toContain(stage.sections[1]);
    expect(f.notCovered).not.toContain(stage.sections[0]);
    // The first stage's first section was reached with no evidence: a weak area.
    expect(f.weakAreas).toContain(plan.stages[0].sections[0]);
    expect(f.items!.every((i) => i.text && i.section)).toBe(true);
    expect(f.dimensions.map((d) => d.rating)).toEqual(plan.dimensions.map(() => 0));
    expect(f.rubricVersion).toBe('rubric-1');
  });
});
