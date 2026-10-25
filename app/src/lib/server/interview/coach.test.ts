import type { DerivedItem, DerivedPlan } from '@arrowbox/content-kit';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { COACH_POLICY, decideCoach, initialCoachState, isQuestion, lessonItems, lessonView, type CoachInput, type CoachState } from './coach';
import type { LiveSignal } from './director';

// The coach's decision table (docs/interview/coach-mode.md), replayed on a small synthetic plan:
// two parts, the first with two sections. The coach opens, teaches and draws, checks, confirms,
// reteaches a shaky answer once, answers doubts inside a cap and parks the rest, recaps a section,
// moves on when the ground is covered or time is up, and closes on the last part.

const item = (section: string, n: number, weight: DerivedItem['weight'], extra: Partial<DerivedItem> = {}): DerivedItem =>
  ({
    id: `${section}/${n}`,
    section,
    kind: 'concept',
    weight,
    text: `Item ${section}/${n}`,
    source: 'prose',
    ...extra,
  }) as DerivedItem;

const A = 'topic/a';
const B = 'topic/b';
const C = 'topic/c';
const plan = {
  prompt: 'Design the thing.',
  stages: [
    {
      key: 's1',
      title: 'Part one',
      minutes: 10,
      sections: [A, B],
      items: [item(A, 1, 'core', { probe: 'Why?', drawable: true }), item(A, 2, 'core', { probe: 'How?' }), item(A, 3, 'supporting'), item(B, 1, 'core', { probe: 'What?' })],
      drawTasks: [],
    },
    { key: 's2', title: 'Part two', minutes: 10, sections: [C], items: [item(C, 1, 'core', { probe: 'When?' })], drawTasks: [] },
  ],
  sections: [
    { key: A, title: 'Section A' },
    { key: B, title: 'Section B' },
    { key: C, title: 'Section C' },
  ],
} as unknown as DerivedPlan;

const NOW = Date.parse('2026-10-24T09:00:00Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

const minutes = (m: number) => m * 60_000;
const AT = new Date(NOW).toISOString();

function run(overrides: Partial<CoachInput> & { stageIndex?: number }, state?: CoachState) {
  const stageIndex = overrides.stageIndex ?? 0;
  return decideCoach({ plan, stageIndex, elapsedMs: minutes(1), state: state ?? initialCoachState(plan, stageIndex, AT), text: null, signal: null, closed: false, ...overrides });
}

const signal = (items: { id: string; status: LiveSignal['items'][number]['status'] }[]): LiveSignal => ({ basedOnTurn: 1, items: items.map((i) => ({ ...i, conf: 0.9, probed: false })), recent: ['answer'] });

describe('a lesson from the top', () => {
  it('opens with the first item, drawing it, then checks it, then confirms the answer', () => {
    const open = run({});
    expect(open.decision).toMatchObject({ row: 10, move: 'intro', index: 1, draw: true });
    expect(open.decision.template).toContain('Open the lesson');
    expect(open.decision.template).toContain('<draw>');
    expect(open.state.items[`${A}/1`]).toBe('explained');
    expect(open.state.drawn).toEqual([`${A}/1`]);

    const check = run({}, open.state);
    expect(check.decision).toMatchObject({ row: 9, move: 'check', index: 1 });
    expect(check.state.items[`${A}/1`]).toBe('checked');

    const confirm = run({ text: 'Because the reads outnumber the writes by far.' }, check.state);
    expect(confirm.decision).toMatchObject({ row: 4, move: 'confirm', index: 1 });
    expect(confirm.state.items[`${A}/1`]).toBe('understood');
    expect(confirm.decision.understood).toEqual([1]);

    // The next continue teaches item 2; not a part to draw, so it is written down as a note.
    const next = run({}, confirm.state);
    expect(next.decision).toMatchObject({ row: 10, move: 'teach', index: 2, draw: true });
    expect(next.decision.template).toContain('<note');
    expect(next.state.drawn).toEqual([`${A}/1`, `${A}/2`]);
    expect(next.decision.left).toEqual([3, 4]);
  });

  it('teaches an item again once when the evaluator finds the answer shaky, then settles it', () => {
    let s = run({}).state;
    s = run({}, s).state; // checked
    s = run({ text: 'It is because of the cache, mostly, I think.' }, s).state; // understood in words
    // On the continue the signal says the answer was wrong: reteach, with the question again.
    const re = run({ signal: signal([{ id: `${A}/1`, status: 'wrong' }]) }, { ...s, items: { ...s.items, [`${A}/1`]: 'checked' } });
    expect(re.decision).toMatchObject({ row: 8, move: 'reteach', index: 1 });
    expect(re.state.checks[`${A}/1`]).toBe(2);
    // Still shaky after the second check: left shaky, the lesson moves on.
    const on = run({ signal: signal([{ id: `${A}/1`, status: 'partial' }]) }, re.state);
    expect(on.decision).toMatchObject({ row: 10, move: 'teach', index: 2 });
    expect(on.state.items[`${A}/1`]).toBe('shaky');
    expect(on.decision.shaky).toEqual([1]);
  });

  it('states the answer plainly on "I don’t know", marking the item shaky', () => {
    let s = run({}).state;
    s = run({}, s).state;
    const out = run({ text: "I don't know" }, s);
    expect(out.decision).toMatchObject({ row: 4, move: 'confirm', index: 1 });
    expect(out.decision.template).toContain("doesn't know");
    expect(out.state.items[`${A}/1`]).toBe('shaky');
  });
});

describe('doubts and remarks', () => {
  it('answers a question, parks them past the section’s share, and treats a short reply as a remark', () => {
    let s = run({}).state;
    const q = run({ text: 'Why not a queue here?' }, s);
    expect(q.decision).toMatchObject({ row: 5, move: 'answer', index: 1 });
    expect(q.state.doubts).toBe(1);
    s = { ...q.state, doubts: COACH_POLICY.doubtsPerSection };
    const parked = run({ text: 'And what about retries?' }, s);
    expect(parked.decision).toMatchObject({ row: 6, move: 'park' });
    expect(parked.state.parked).toEqual(['And what about retries?']);
    const remark = run({ text: 'ok' }, s);
    expect(remark.decision).toMatchObject({ row: 7, move: 'answer' });
    expect(remark.decision.template).toContain('remark');
  });

  it('knows a question by its shape', () => {
    expect(isQuestion('What does the policy service do?')).toBe(true);
    expect(isQuestion('why would that scale')).toBe(true);
    expect(isQuestion('The cache sits in front of the store.')).toBe(false);
  });

  it('a question during a check is a doubt, not an answer', () => {
    let s = run({}).state;
    s = run({}, s).state;
    const out = run({ text: 'Do you mean the read path or the write path?' }, s);
    expect(out.decision).toMatchObject({ row: 5, move: 'answer', index: 1 });
    expect(out.state.items[`${A}/1`]).toBe('checked');
  });
});

describe('sections and parts', () => {
  /** Walks section A to its end: both core items understood, the supporting one taught. */
  function throughA() {
    let s = run({}).state;
    s = run({}, s).state;
    s = run({ text: 'Because reads dominate and the cache absorbs them.' }, s).state;
    s = run({}, s).state; // teach 2
    s = run({}, s).state; // check 2
    s = run({ text: 'By sharding on the user id, so each shard stays small.' }, s).state;
    const sup = run({}, s); // the supporting item: taught, no question
    expect(sup.decision).toMatchObject({ move: 'teach', index: 4 }); // the notes number core items first, so the supporting one is 4
    return sup.state;
  }

  it('recaps the section and moves to the next one, answering parked doubts, once its items are done', () => {
    const s = throughA();
    const r = run({}, { ...s, parked: ['What about retries?'] });
    expect(r.decision).toMatchObject({ row: 10, move: 'recap', from: A, to: B, index: 3 });
    expect(r.decision.template).toContain('"Section A"');
    expect(r.decision.template).toContain('parked');
    expect(r.sectionAdvance).toEqual({ from: A, to: B });
    expect(r.state.section).toBe(B);
    expect(r.state.parked).toEqual([]);
    expect(r.state.items[`${A}/3`]).toBe('understood');
  });

  it('ends the part once every section is taught, and the lesson on the last part', () => {
    let s = throughA();
    s = run({}, s).state; // recap into B, teaching B/1
    s = run({}, s).state; // check
    s = run({ text: 'The approval record goes to a billing lead.' }, s).state;
    const done = run({}, s);
    expect(done.decision).toMatchObject({ row: 11, move: 'advance_stage', reason: 'done' });
    expect(done.decision.taught).toBe(1);
    // Part two, with the items carried over: the first continue introduces the part.
    const next = initialCoachState(plan, 1, AT, done.state);
    expect(next.items[`${A}/1`]).toBe('understood');
    const open = run({ stageIndex: 1 }, next);
    expect(open.decision).toMatchObject({ move: 'teach', index: 1 });
    expect(open.decision.template).toContain('"Part two"');
    let t = run({ stageIndex: 1 }, open.state).state;
    t = run({ stageIndex: 1, text: 'When the month total stays under the cap.' }, t).state;
    expect(run({ stageIndex: 1 }, t).decision).toMatchObject({ row: 11, move: 'end', reason: 'done' });
  });

  it('skips the rest of the section on "let’s move on", and leaves the part from its last section', () => {
    const s = run({}).state;
    const on = run({ text: "let's move on" }, s);
    expect(on.decision).toMatchObject({ row: 3, move: 'recap', from: A, to: B });
    expect(on.state.items[`${A}/2`]).toBe('skipped');
    expect(on.state.items[`${A}/1`]).toBe('explained');
    const out = run({ text: 'move on' }, on.state);
    expect(out.decision).toMatchObject({ row: 3, move: 'advance_stage', reason: 'learner' });
  });

  it('teaches briefly without checks when the part’s time is used, and advances at the hard limit', () => {
    const s = run({}).state;
    const brief = run({ elapsedMs: minutes(10) }, s);
    expect(brief.decision).toMatchObject({ move: 'teach', index: 2, draw: false });
    expect(brief.decision.template).toContain('short');
    expect(brief.state.items[`${A}/1`]).toBe('understood');
    expect(run({ elapsedMs: minutes(13) }, s).decision).toMatchObject({ row: 2, move: 'advance_stage', reason: 'time' });
    expect(run({ stageIndex: 1, elapsedMs: minutes(13) }).decision).toMatchObject({ row: 2, move: 'end', reason: 'time' });
    expect(run({ closed: true }).decision).toMatchObject({ row: 1, move: 'advance_stage' });
  });
});

describe('the lesson view', () => {
  it('lists every part’s sections and items with their status, and counts them', () => {
    const s = run({}).state;
    const v = lessonView(plan, { ...s, items: { ...s.items, [`${A}/1`]: 'understood', [`${A}/2`]: 'shaky' } }, 0);
    expect(v.stages.map((x) => x.sections.map((y) => y.items.map((i) => i.status)))).toEqual([[['understood', 'shaky', 'queued'], ['queued']], [['queued']]]);
    expect(v).toMatchObject({ understood: 1, shaky: 1, left: 3, focus: `${A}/1`, waiting: 'continue' });
    expect(lessonView(plan, { ...s, items: { ...s.items, [`${A}/1`]: 'checked' } }, 0).waiting).toBe('answer');
    // Items of a part already left are reported as skipped.
    expect(lessonView(plan, s, 1).stages[0].sections[1].items[0].status).toBe('skipped');
    expect(lessonItems(plan.stages[0]).map((i) => i.id)).toEqual([`${A}/1`, `${A}/2`, `${A}/3`, `${B}/1`]);
  });
});

describe('a draw task (coach-mode.md, "Drawing"; phase 3)', () => {
  const withTask = {
    ...plan,
    stages: [{ ...plan.stages[0], drawTasks: [{ prompt: 'Draw part one: the parts and the arrows between them.', expects: [`${A}/1`, `${A}/3`, `${B}/1`] }] }, plan.stages[1]],
  } as unknown as DerivedPlan;
  const taught = (): CoachState => ({ ...initialCoachState(withTask, 0, AT), section: B, opened: true, items: { [`${A}/1`]: 'understood', [`${A}/2`]: 'understood', [`${A}/3`]: 'shaky', [`${B}/1`]: 'understood' } });
  const go = (overrides: Partial<CoachInput>, state: CoachState) => decideCoach({ plan: withTask, stageIndex: 0, elapsedMs: minutes(1), text: null, signal: null, closed: false, ...overrides, state });

  it('asks for the drawing once the part is taught, waits for it, and reviews what the matcher found on the learner’s board', () => {
    const asked = go({}, taught());
    expect(asked.decision).toMatchObject({ row: 12, move: 'draw_task', task: 'Draw part one: the parts and the arrows between them.' });
    expect(asked.decision.template).toContain('press "Done drawing"');
    expect(asked.decision.draw).toBeUndefined();
    expect(asked.state.drawTasks).toEqual({ s1: 'asked' });
    expect(lessonView(withTask, asked.state, 0)).toMatchObject({ waiting: 'draw', task: 'Draw part one: the parts and the arrows between them.', focus: null });
    // A question meanwhile is a doubt; the task still waits.
    const doubt = go({ text: 'Should the cache go in too?' }, asked.state);
    expect(doubt.decision).toMatchObject({ row: 5, move: 'answer' });
    expect(lessonView(withTask, doubt.state, 0).waiting).toBe('draw');
    // "Done drawing" (a continue): the learner's boxes cover two of the three items (numbered as the notes list them, core first); the shaky one they drew is understood now.
    const review = go({ drawn: [`${A}/1`], signal: signal([{ id: `${A}/3`, status: 'partial' }]) }, doubt.state);
    expect(review.decision).toMatchObject({ row: 13, move: 'draw_review', hit: [1, 4], missed: [3], draw: true });
    expect(review.decision.template).toContain('items 1, 4 but not 3');
    expect(review.state.items[`${A}/3`]).toBe('understood');
    expect(review.state.drawTasks).toEqual({ s1: 'done' });
    expect(lessonView(withTask, review.state, 0)).toMatchObject({ waiting: 'continue', task: null });
    // Then the part is done.
    expect(go({}, review.state).decision).toMatchObject({ row: 11, move: 'advance_stage', reason: 'done' });
  });

  it('speaks to an empty board and a complete one, and skips the task when time is short', () => {
    const asked = go({}, taught()).state;
    const none = go({ text: 'done' }, asked);
    expect(none.decision).toMatchObject({ row: 13, move: 'draw_review', hit: [], missed: [1, 3, 4], draw: true });
    expect(none.decision.template).toContain('none of the parts');
    const all = go({ drawn: [`${A}/1`, `${A}/3`, `${B}/1`] }, asked);
    expect(all.decision).toMatchObject({ row: 13, hit: [1, 3, 4], missed: [] });
    expect(all.decision.draw).toBe(false);
    expect(all.decision.template).toContain('drew the parts asked');
    expect(go({ elapsedMs: minutes(11) }, taught()).decision).toMatchObject({ row: 11, move: 'advance_stage', reason: 'time' });
  });
});
