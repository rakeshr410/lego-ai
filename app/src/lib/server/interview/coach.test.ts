import type { DerivedItem, DerivedPlan } from '@arrowbox/content-kit';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asksLearner, COACH_POLICY, decideCoach, dropQuestions, initialCoachState, isNod, questionFilter, isQuestion, lessonItems, lessonView, type CoachInput, type CoachState } from './coach';
import type { LiveSignal } from './director';

// The coach's decision table (docs/coach-mode.md), replayed on a small synthetic plan:
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

  it('with questions off, teaches straight through: no check after an item, no draw task at the end', () => {
    const open = run({ questions: false });
    const next = run({ questions: false }, open.state);
    expect(next.decision).toMatchObject({ row: 10, move: 'teach', index: 2 });
    expect(next.state.items[`${A}/1`]).toBe('explained');
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
  it('answers a question, parks them past the section’s share, and treats a remark as one', () => {
    let s = run({}).state;
    const q = run({ text: 'Why not a queue here?' }, s);
    expect(q.decision).toMatchObject({ row: 5, move: 'answer', index: 1, aside: true });
    expect(q.state.doubts).toBe(1);
    s = { ...q.state, doubts: COACH_POLICY.doubtsPerSection };
    const parked = run({ text: 'And what about retries?' }, s);
    expect(parked.decision).toMatchObject({ row: 6, move: 'park' });
    expect(parked.state.parked).toEqual(['And what about retries?']);
    const remark = run({ text: 'we did something like this at my last job' }, s);
    expect(remark.decision).toMatchObject({ row: 7, move: 'answer' });
    expect(remark.decision.aside).toBeUndefined();
    expect(remark.decision.template).toContain('remark');
  });

  it('a question said over a teaching move is answered first, then the lesson goes back to it and draws what is missing', () => {
    // Item 1 is taught and drawn on the opening move; the learner cuts it short with a question.
    const open = run({});
    const q = run({ text: 'Wait, why a phone frame?', cutIn: true }, open.state);
    expect(q.decision).toMatchObject({ row: 5, move: 'answer', index: 1 });
    expect(q.decision.template).toContain('cut you off');
    expect(q.decision.template).not.toContain('Then return');
    // The cut move is taken back: not taught, not drawn, and marked to resume.
    expect(q.state.items[`${A}/1`]).toBe('queued');
    expect(q.state.drawn).toEqual([]);
    // The next continue goes back to it ("Okay, now let's go back to ..."), drawing it, not on to a check.
    const back = run({}, q.state);
    expect(back.decision).toMatchObject({ row: 10, move: 'teach', index: 1, draw: true });
    expect(back.decision.template).toContain("Okay, now let's go back to");
    expect(back.decision.template).toContain('<draw>');
    expect(back.state.resume).toBeUndefined();
    // Then the lesson carries on as before: the item is checked.
    expect(run({}, back.state).decision).toMatchObject({ row: 9, move: 'check', index: 1 });
  });

  it('gives the floor to a learner who cuts in with only "okay so" or "wait", rather than taking it as a nod', () => {
    const open = run({});
    for (const said of ['Okay so', 'Wait.']) {
      const out = run({ text: said, cutIn: true }, open.state);
      expect(out.decision).toMatchObject({ row: 7, move: 'answer' });
      expect(out.decision.template).toContain('go ahead');
    }
    // Not cut in, "okay" is still a nod: the lesson carries on to the check.
    expect(run({ text: 'Okay so' }, open.state).decision).toMatchObject({ row: 9, move: 'check' });
    // A cut check stands: what they say over it is taken as their answer.
    const check = run({}, open.state);
    const answer = run({ text: 'Because the feed loads as you scroll.', cutIn: true }, check.state);
    expect(answer.decision).toMatchObject({ row: 4, move: 'confirm', index: 1 });
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
    // Taught without a question: nothing shows it landed, so it is explained, not understood.
    expect(r.state.items[`${A}/3`]).toBe('explained');
  });

  it('counts nothing as understood in a lesson the learner never answered, and gives the answer it asked for', () => {
    let s = run({}).state; // teach 1
    const check = run({}, s);
    expect(check.decision).toMatchObject({ row: 9, move: 'check', index: 1 });
    // The voice's idle wait ran out with no answer: a continue.
    const next = run({}, check.state);
    expect(next.state.items[`${A}/1`]).toBe('shaky');
    expect(next.decision).toMatchObject({ move: 'teach', index: 2 });
    expect(next.decision.template).toMatch(/^The learner gave no answer to the check on item 1: .*praise nothing/);
    expect(next.decision.template).toContain('Teach item 2');
    s = next.state;
    for (let i = 0; i < 12; i++) s = run({}, s).state;
    expect(lessonView(plan, s, 0).understood).toBe(0);
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
    expect(brief.state.items[`${A}/1`]).toBe('explained');
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
    expect(v).toMatchObject({ understood: 1, explained: 0, shaky: 1, left: 3, focus: `${A}/1`, waiting: 'continue' });
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

  it('skips the task when the coach has drawn everything it asks for (the learner would redraw what is there)', () => {
    const drawn = { ...taught(), drawn: [`${A}/1`, `${A}/3`, `${B}/1`] };
    expect(go({}, drawn).decision).toMatchObject({ row: 11, move: 'advance_stage' });
    // Something left to draw: the task stands.
    expect(go({}, { ...drawn, drawn: [`${A}/1`] }).decision).toMatchObject({ row: 12, move: 'draw_task' });
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

  it('reads a nod as a continue: the lesson carries on, and the check it follows gets its answer', () => {
    for (const nod of ['Okay.', 'mhmm', 'Sure', 'yeah, go on', 'Continue', 'Okay?', 'got it!', 'Tell me.']) expect(isNod(nod), nod).toBe(true);
    for (const answer of ['the client', 'okay so the client renders it', 'move on', 'what do you want me to do?']) expect(isNod(answer), answer).toBe(false);
    // After a check: the same move as a continue (the answer, then the next item), not a remark.
    const asked = run({ text: null }).state;
    const checked = run({ text: null }, asked).state;
    expect(run({ text: 'Okay.' }, checked).decision).toEqual(run({ text: null }, checked).decision);
    expect(run({ text: 'Okay.' }, checked).decision.move).not.toBe('answer');
  });

  it('keeps questions to the checks: a teaching move that ends on one says it without the question', () => {
    expect(asksLearner('check')).toBe(true);
    expect(asksLearner('teach')).toBe(false);
    const reply = 'You design the client. <draw><place ids="prompt"/></draw> The server stays a black box. So, quick check: which part are you designing?';
    expect(dropQuestions(reply)).toBe('You design the client. <draw><place ids="prompt"/></draw> The server stays a black box.');
    // A question with a drawing in it keeps the drawing, not its words; a reply that is only a question is kept as it is.
    expect(dropQuestions('Do you see it <draw><box label="Feed"/></draw> here? Yes.')).toBe('<draw><box label="Feed"/></draw>Yes.');
    expect(dropQuestions('Ready?')).toBe('Ready?');
    // Streamed in pieces, the same: numbers and drawings are not sentence ends.
    const out: string[] = [];
    const f = questionFilter((d) => out.push(d));
    for (const d of ['LCP is 2', '.5 s on a phone. <draw><note text="a. b"/></dr', 'aw> Does that make ', 'sense? Next, the ', 'list.']) f.onText(d);
    f.flush();
    expect(out.join('')).toBe('LCP is 2.5 s on a phone. <draw><note text="a. b"/></draw>Next, the list.');
    expect(dropQuestions('One. <draw><box label="A"/></draw> Does that make sense? Two.')).toBe('One. <draw><box label="A"/></draw>Two.');
    // A question after the last drawing leaves nothing after it to say (the voice would open an empty segment).
    expect(dropQuestions('One. <draw><box label="A"/></draw> Does that make sense?')).toBe('One. <draw><box label="A"/></draw>');
    // A question the coach answers itself is kept when more follows; at the end, or put to the learner, it is not.
    expect(dropQuestions('So why not an offset? Picture this: five new tweets. Can you see why?')).toBe('So why not an offset? Picture this: five new tweets.');
    expect(dropQuestions('Pages shift. So why not an offset?')).toBe('Pages shift.');
    const said: string[] = [];
    const g = questionFilter((d) => said.push(d));
    for (const d of ['So why not ', 'an offset? <draw><box label="A"/></draw> ', 'Pages shift. Why', ' not?']) g.onText(d);
    g.flush();
    expect(said.join('')).toBe('So why not an offset? <draw><box label="A"/></draw> Pages shift. ');
  });
});


describe('a part the learner gives first', () => {
  const ask = {
    key: `${A}#list`,
    list: 'list' as string | undefined,
    items: [`${A}/2`, `${A}/3`],
    lines: { [`${A}/2`]: ['l1', 'l2'], [`${A}/3`]: ['l3'] },
    before: ['frame'],
    labels: { l1: 'never repeats', l2: 'loads early', l3: 'says when it ends' },
    question: 'What should the feed do?',
    hints: ['Think about scrolling.'],
    chars: 40,
  };
  const go = (state: CoachState, text: string | null, lines = { placed: [] as string[], given: [] as string[] }) => run({ questions: false, asks: [ask], lines, text }, state);

  it('asks for the list with its frame, writes each point, hints on a pause, then teaches only what was left out', () => {
    const intro = go(initialCoachState(plan, 0, AT), null);
    expect(intro.decision.move).toBe('intro');
    const asked = go(intro.state, null);
    expect(asked.decision).toMatchObject({ row: 14, move: 'ask', item: `${A}/2`, draw: true, place: ['frame'] });
    expect(asked.decision.template).toContain('"What should the feed do?"');
    expect(asked.decision.template).toContain('<place ids="frame"/>');
    expect(asksLearner('ask')).toBe(true);
    expect(lessonView(plan, asked.state, 0).waiting).toBe('answer');

    const got = go(asked.state, 'It should never show a tweet twice.');
    expect(got.decision).toMatchObject({ row: 15, move: 'capture', draw: true, open: ['l1: never repeats', 'l2: loads early', 'l3: says when it ends'] });
    expect(got.decision.template).toContain('covers="ID"');

    const lines = { placed: ['l1'], given: ['l1'] };
    const nudge = go(got.state, null, lines);
    expect(nudge.decision).toMatchObject({ row: 16, move: 'nudge' });
    expect(nudge.decision.template).toContain('Think about scrolling.');

    // Past the hints, a pause closes the list: item 2 lost one line, item 3 both.
    const fill = go(nudge.state, null, lines);
    expect(fill.decision).toMatchObject({ move: 'teach', item: `${A}/2`, draw: true, place: ['l2'] });
    expect(fill.decision.template).toContain('they did not name');
    expect(fill.decision.template).toContain('named 1 of the 3 lines themselves');
    expect(lessonView(plan, fill.state, 0).waiting).toBe('continue');
    const last = go(fill.state, null, { placed: ['l1', 'l2'], given: ['l1'] });
    expect(last.decision).toMatchObject({ move: 'teach', item: `${A}/3`, place: ['l3'] });
    expect(last.decision.template).not.toContain('lines themselves');
  });

  it('credits a learner who named every line, and "that’s all" goes on as a continue', () => {
    const asked = go(go(initialCoachState(plan, 0, AT), null).state, null);
    const all = { placed: ['l1', 'l2', 'l3'], given: ['l1', 'l2', 'l3'] };
    const done = go(asked.state, "That's all.", all);
    for (const said of ['that is all', 'Nothing comes to mind.', "I'm out of ideas", 'no, that is it']) expect(go(asked.state, said, all).decision.move).toBe('credit');
    expect(done.decision).toMatchObject({ row: 17, move: 'credit' });
    expect(done.state.items[`${A}/2`]).toBe('understood');
    expect(done.state.items[`${A}/3`]).toBe('understood');
    // The next part is taught as usual.
    expect(go(done.state, null, all).decision).toMatchObject({ move: 'recap', item: `${B}/1` });
  });

  it('teaches the part as usual when the lesson asks nothing, or time is short', () => {
    const intro = run({ questions: false }, initialCoachState(plan, 0, AT));
    expect(run({ questions: false }, intro.state).decision).toMatchObject({ move: 'teach', item: `${A}/2` });
    const late = go(intro.state, null);
    expect(run({ questions: false, asks: [ask], elapsedMs: minutes(11) }, intro.state).decision.move).not.toBe('ask');
    expect(late.decision.move).toBe('ask');
  });

  it('asks for parts of the plan: what they named is drawn as theirs, and the rest of the drawing comes with the fill', () => {
    const parts = { ...ask, list: undefined, lines: { [`${A}/2`]: ['b1', 'b2'], [`${A}/3`]: ['b3'] }, rest: { [`${A}/2`]: ['b1-b2'], [`${A}/3`]: [] }, labels: { b1: 'Store', b2: 'Client', b3: 'Cache' } };
    const step = (state: CoachState, text: string | null, lines = { placed: [] as string[], given: [] as string[] }) => run({ questions: false, asks: [parts], lines, text }, state);
    const asked = step(step(initialCoachState(plan, 0, AT), null).state, null);
    expect(asked.decision).toMatchObject({ move: 'ask', place: ['frame'] });
    const got = step(asked.state, 'A store and a client.');
    expect(got.decision.template).toContain('the board draws the plan');
    expect(got.decision.open).toEqual(['b1: Store', 'b2: Client', 'b3: Cache']);
    // Both boxes of item 2 given: its arrow is still to come; item 3's box is left out.
    const lines = { placed: ['b1', 'b2'], given: ['b1', 'b2'] };
    const fill = step(got.state, "That's all.", lines);
    expect(fill.decision).toMatchObject({ move: 'teach', item: `${A}/2`, place: ['b1-b2'] });
    expect(fill.decision.template).toContain('named 2 of the 3 parts themselves');
    expect(step(fill.state, null, { placed: ['b1', 'b2', 'b1-b2'], given: ['b1', 'b2'] }).decision).toMatchObject({ move: 'teach', item: `${A}/3`, place: ['b3'] });
  });

  it('opens a lesson by asking when its first part is the learner’s', () => {
    const first = { ...ask, key: `${A}#first`, items: [`${A}/1`], lines: { [`${A}/1`]: ['l1'] } };
    const open = run({ questions: false, asks: [first], lines: { placed: [], given: [] } }, initialCoachState(plan, 0, AT));
    expect(open.decision).toMatchObject({ move: 'ask', item: `${A}/1` });
    expect(open.decision.template).toContain('Open the lesson in one sentence');
    expect(open.state.opened).toBe(true);
  });
});


describe('the learner turns the questions off (the room’s toggle)', () => {
  const ask = {
    key: `${A}#list`,
    list: 'list' as string | undefined,
    items: [`${A}/2`, `${A}/3`],
    lines: { [`${A}/2`]: ['l1', 'l2'], [`${A}/3`]: ['l3'] },
    before: ['frame'],
    labels: { l1: 'never repeats', l2: 'loads early', l3: 'says when it ends' },
    question: 'What should the feed do?',
    hints: ['Think about scrolling.'],
    chars: 40,
  };
  const lines = { placed: [] as string[], given: [] as string[] };

  it('asks nothing: no check after an item, no list to give, the part taught as it comes', () => {
    const intro = run({}, initialCoachState(plan, 0, AT));
    expect(run({}, intro.state).decision.move).toBe('check');
    expect(run({ quiet: true }, intro.state).decision).toMatchObject({ move: 'teach', item: `${A}/2` });
    expect(run({ asks: [ask], lines, quiet: true }, intro.state).decision).toMatchObject({ move: 'teach', item: `${A}/2` });
  });

  it('settles what was still asked: an open list closes and its lines are taught, what the learner says is answered', () => {
    const intro = run({ questions: false, asks: [ask], lines }, initialCoachState(plan, 0, AT));
    const asked = run({ questions: false, asks: [ask], lines }, intro.state);
    expect(asked.decision.move).toBe('ask');
    expect(lessonView(plan, asked.state, 0, false).waiting).toBe('continue');
    const on = run({ questions: false, asks: [ask], lines, quiet: true }, asked.state);
    expect(on.decision).toMatchObject({ move: 'teach', item: `${A}/2` });
    expect(on.state.asked?.[ask.key]?.open).toBe(false);
    const said = run({ questions: false, asks: [ask], lines, quiet: true, text: 'Why does it load early?' }, asked.state);
    expect(said.decision).toMatchObject({ row: 5, move: 'answer' });
  });

  it('drops a drawing it asked for, unreviewed, and the view waits for nobody', () => {
    const withTask = { ...plan, stages: [{ ...plan.stages[0], drawTasks: [{ prompt: 'Draw part one.', expects: [`${A}/1`, `${B}/1`] }] }, plan.stages[1]] } as unknown as DerivedPlan;
    const taught: CoachState = { ...initialCoachState(withTask, 0, AT), section: B, opened: true, items: { [`${A}/1`]: 'understood', [`${A}/2`]: 'understood', [`${A}/3`]: 'understood', [`${B}/1`]: 'understood' } };
    const go = (overrides: Partial<CoachInput>, state: CoachState) => decideCoach({ plan: withTask, stageIndex: 0, elapsedMs: minutes(1), text: null, signal: null, closed: false, ...overrides, state });
    const asked = go({}, taught);
    expect(asked.decision.move).toBe('draw_task');
    expect(lessonView(withTask, asked.state, 0, false)).toMatchObject({ waiting: 'continue', task: null, discussion: false });
    const quiet = go({ quiet: true }, asked.state);
    expect(quiet.decision).toMatchObject({ row: 11, move: 'advance_stage' });
    expect(quiet.state.drawTasks).toEqual({ s1: 'done' });
  });
});
