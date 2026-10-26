import { derivePlans, type DerivedPlan } from '@arrowbox/content-kit';
import { loadContent } from '@arrowbox/content-kit/node';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decide, initialState, intentOf, POLICY, stageItems, type DirectorInput, type DirectorState, type LiveSignal } from './director';
import { snapshotPaths } from '../../content-snapshot.node';

// The director's decision table (ADR 0003, design section 5), replayed on scripted candidates
// over the real customer-support-agent plan: a strong candidate reaches the covered-and-advance
// rows, a stuck one walks rephrase, hint, hint, skip at the right turns, a drill request lands on
// the item it names, "let's move on" mid-sentence is an answer and never an intent, and the last
// stage ends instead of looping.

// lego's content/ (CONTENT_DIR overrides it), where the build reads it too.
const contentDir = snapshotPaths(fileURLToPath(new URL('../../../../', import.meta.url))).contentDir;
const { catalog } = loadContent(contentDir);
const system = catalog.systems.find((s) => s.slug === 'customer-support-agent')!;
const plan: DerivedPlan = derivePlans({ system, topics: catalog.topics.filter((t) => t.system === system.slug).map((t) => ({ slug: t.slug, file: t.file, data: t.data })), override: null }).system!;

const NOW = Date.parse('2026-10-23T09:00:00Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

const minutes = (m: number) => m * 60_000;
const answer = (n = 20) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

function run(overrides: Partial<DirectorInput> & { stageIndex?: number }, state?: DirectorState) {
  const stageIndex = overrides.stageIndex ?? 0;
  return decide({
    plan,
    stageIndex,
    elapsedMs: minutes(1),
    state: state ?? initialState(plan, stageIndex, new Date(NOW).toISOString()),
    text: answer(),
    intent: null,
    signal: null,
    idleRung: null,
    closed: false,
    ...overrides,
  });
}

/** A signal that marks the given core items of the stage covered. */
function covered(stageIndex: number, count: number, extra: LiveSignal['items'] = []): LiveSignal {
  const core = stageItems(plan.stages[stageIndex]).filter((i) => i.weight === 'core');
  return { basedOnTurn: 1, items: [...core.slice(0, count).map((i) => ({ id: i.id, status: 'covered' as const, conf: 0.9, probed: false })), ...extra], recent: ['answer'] };
}

describe('intents', () => {
  it('fires on a short phrase that is the whole message, never on a clause inside an answer', () => {
    expect(intentOf("Let's move on")).toEqual({ kind: 'advance' });
    expect(intentOf('ok, next stage please')).toEqual({ kind: 'advance' });
    expect(intentOf("I don't know")).toEqual({ kind: 'dont_know' });
    expect(intentOf('Hmm, not sure about that.')).toEqual({ kind: 'dont_know' });
    expect(intentOf('Can we go deeper on failures?')).toEqual({ kind: 'drill', target: 'failures' });
    expect(intentOf("Let's move on to how the cache handles that, since the queue is the bottleneck here")).toBeNull();
    expect(intentOf("I don't know if a queue is needed here, but a log would do")).toBeNull();
    expect(intentOf('')).toBeNull();
    expect(intentOf(null)).toBeNull();
  });
});

describe('the default move', () => {
  it('asks the first item of the first section, then keeps section order', () => {
    const items = stageItems(plan.stages[0]);
    const first = run({});
    expect(first.decision).toMatchObject({ row: 17, move: 'ask' });
    expect(first.decision.open.length).toBe(items.length);
    expect(first.decision.template).toContain(`Ask about item ${first.decision.index}`);
    const asked = items.find((i) => i.id === first.decision.item)!;
    expect(asked.section).toBe(plan.stages[0].sections[0]);
    expect(first.state.focus).toBe(asked.id);
    expect(first.sectionAdvance).toBeUndefined();
    // On a stage whose first section holds core items: with item 1 covered, the next ask is item 2.
    const stageIndex = plan.stages.findIndex((s) => stageItems(s)[0].section === s.sections[0]);
    const one = run({ stageIndex });
    expect(one.decision).toMatchObject({ row: 17, move: 'ask', index: 1 });
    const second = run({ stageIndex, signal: covered(stageIndex, 1) }, one.state);
    expect(second.decision).toMatchObject({ row: 17, move: 'ask', index: 2 });
    expect(second.decision.covered).toEqual([1]);
  });

  it('moves to the next section inside the stage once the section’s core items are covered, with a bridge', () => {
    // A stage whose first section holds some, but under 60%, of the core items: covering them moves the section without covering the stage.
    const stage = plan.stages.find((s) => {
      const core = stageItems(s).filter((i) => i.weight === 'core');
      const n = core.filter((i) => i.section === s.sections[0]).length;
      return s.sections.length === 2 && n > 0 && n / core.length < POLICY.covered;
    })!;
    const stageIndex = plan.stages.indexOf(stage);
    const firstSection = stage.sections[0];
    const core = stageItems(stage).filter((i) => i.weight === 'core');
    const sectionCore = core.filter((i) => i.section === firstSection);
    const signal: LiveSignal = { basedOnTurn: 3, items: sectionCore.map((i) => ({ id: i.id, status: 'covered', conf: 0.9, probed: false })), recent: ['answer'] };
    const out = run({ stageIndex, signal });
    expect(out.sectionAdvance).toEqual({ from: firstSection, to: stage.sections[1] });
    expect(out.decision.move).toBe('bridge_section');
    expect(out.decision.template).toContain('We are moving from');
    expect(out.state.section).toBe(stage.sections[1]);
    const asked = stageItems(stage).find((i) => i.id === out.decision.item)!;
    expect(asked.section).toBe(stage.sections[1]);
  });

  it('moves to the next section when its share of the stage’s minutes is used', () => {
    const stage = plan.stages.find((s) => s.sections.length === 2)!;
    const stageIndex = plan.stages.indexOf(stage);
    const state = initialState(plan, stageIndex, new Date(NOW - minutes(stage.minutes)).toISOString());
    const out = run({ stageIndex, elapsedMs: minutes(stage.minutes) * 0.9 }, state);
    expect(out.sectionAdvance?.to).toBe(stage.sections[1]);
  });
});

describe('a strong candidate', () => {
  it('is drilled while there is time, then advanced once the ground is covered past half time', () => {
    const early = run({ signal: covered(0, 4), elapsedMs: minutes(2) });
    expect(early.decision).toMatchObject({ row: 5, move: 'drill_into' });
    expect(early.decision.cov).toBeGreaterThanOrEqual(POLICY.covered);
    const later = run({ signal: covered(0, 4), elapsedMs: minutes(plan.stages[0].minutes * 0.6) });
    expect(later.decision).toMatchObject({ row: 4, move: 'advance_stage', reason: 'covered' });
    expect(later.decision.template).toContain('moving to the next stage');
  });

  it('ends the interview instead of advancing on the last stage', () => {
    const last = plan.stages.length - 1;
    const out = run({ stageIndex: last, signal: covered(last, 5), elapsedMs: minutes(plan.stages[last].minutes * 0.7) });
    expect(out.decision).toMatchObject({ row: 4, move: 'end_interview', reason: 'last_stage' });
  });
});

describe('time', () => {
  it('asks one last thing at the planned length, then advances; hard limit advances at once', () => {
    const soft = run({ elapsedMs: minutes(plan.stages[0].minutes) });
    expect(soft.decision).toMatchObject({ row: 6, move: 'ask' });
    expect(soft.decision.template).toContain('nearly up');
    const again = run({ elapsedMs: minutes(plan.stages[0].minutes) + 30_000 }, soft.state);
    expect(again.decision).toMatchObject({ row: 6, move: 'advance_stage', reason: 'time' });
    const hard = run({ elapsedMs: minutes(plan.stages[0].minutes * POLICY.hardTime) });
    expect(hard.decision).toMatchObject({ row: 2, move: 'advance_stage', reason: 'time' });
    const lastHard = run({ stageIndex: plan.stages.length - 1, elapsedMs: minutes(plan.stages[plan.stages.length - 1].minutes * POLICY.hardTime) });
    expect(lastHard.decision).toMatchObject({ row: 2, move: 'end_interview', reason: 'time' });
  });

  it('wraps up when the service closed the session', () => {
    expect(run({ closed: true }).decision).toMatchObject({ row: 1, move: 'end_interview' });
  });
});

describe('the candidate steers', () => {
  it('advances on "let’s move on", and ends on the last stage', () => {
    expect(run({ text: "let's move on", intent: { kind: 'advance' } }).decision).toMatchObject({ row: 3, move: 'advance_stage', reason: 'candidate' });
    expect(run({ stageIndex: plan.stages.length - 1, text: 'next', intent: { kind: 'advance' } }).decision).toMatchObject({ row: 3, move: 'end_interview', reason: 'candidate' });
  });

  it('drills into the section the candidate names when it is in the stage', () => {
    const stage = plan.stages.find((s) => s.sections.some((k) => k.endsWith('/failures')))!;
    const stageIndex = plan.stages.indexOf(stage);
    const out = run({ stageIndex, text: 'can we go deeper on failures', intent: { kind: 'drill', target: 'failures' } });
    expect(out.decision).toMatchObject({ row: 5, move: 'drill_into' });
    expect(stageItems(stage).find((i) => i.id === out.decision.item)!.section).toMatch(/\/failures$/);
  });

  it('skips the item on "I don’t know" without marking it wrong, and moves to the next', () => {
    const stageIndex = plan.stages.findIndex((s) => stageItems(s)[0].section === s.sections[0]);
    const first = run({ stageIndex });
    const out = run({ stageIndex, text: "I don't know", intent: { kind: 'dont_know' } }, first.state);
    expect(out.decision).toMatchObject({ row: 9, move: 'skip_item', reason: 'declined', index: 1, nextIndex: 2 });
    expect(out.state.skipped).toEqual([first.state.focus]);
    expect(out.state.stuck).toBe(0);
  });
});

describe('a stuck candidate', () => {
  it('walks rephrase, hint, hint, skip over four short answers', () => {
    let state = run({}).state;
    const rows: number[] = [];
    for (let i = 0; i < 4; i++) {
      const out = run({ text: 'um, the thing?' }, state);
      rows.push(out.decision.row);
      state = out.state;
    }
    expect(rows).toEqual([10, 11, 11, 12]);
    expect(state.skipped.length).toBe(1);
    expect(state.hints[Object.keys(state.hints)[0]]).toBe(2);
  });

  it('treats idle rungs as being stuck: a rephrase at 60 s, a hint at 120 s', () => {
    const asked = run({}).state;
    const quiet = run({ text: null, idleRung: 60 }, asked);
    expect(quiet.decision).toMatchObject({ row: 10, move: 'rephrase' });
    expect(quiet.state.idle).toBe(60);
    const longer = run({ text: null, idleRung: 120 }, quiet.state);
    expect(longer.decision).toMatchObject({ row: 11, move: 'give_hint', level: 1 });
  });

  it('resets once the candidate answers properly', () => {
    const asked = run({}).state;
    const stuck = run({ text: 'hmm' }, asked);
    expect(stuck.state.stuck).toBe(1);
    const back = run({ text: answer(30) }, stuck.state);
    expect(back.state.stuck).toBe(0);
  });
});

describe('a wrong answer', () => {
  it('is probed once, then left alone without correction', () => {
    const stageIndex = plan.stages.findIndex((s) => stageItems(s)[0].section === s.sections[0]);
    const asked = run({ stageIndex }).state;
    const wrong: LiveSignal = { basedOnTurn: 2, items: [{ id: asked.focus!, status: 'contested', conf: 0.9, probed: false }], recent: ['answer'] };
    const probe = run({ stageIndex, signal: wrong }, asked);
    expect(probe.decision).toMatchObject({ row: 7, move: 'probe_wrong', index: 1 });
    expect(probe.decision.template).toContain('do not state the answer');
    const after = run({ stageIndex, signal: wrong }, probe.state);
    expect(after.decision).toMatchObject({ row: 8, move: 'move_on', index: 1, nextIndex: 2 });
    expect(after.decision.template).not.toMatch(/wrong/i);
  });
});

describe('long answers', () => {
  it('get an acknowledge-and-redirect', () => {
    const out = run({ text: answer(POLICY.longAnswerWords + 10) });
    expect(out.decision).toMatchObject({ row: 16, move: 'redirect' });
  });
});

describe('a plan used whole (no sections)', () => {
  it('still asks items in order and never tries a section move', () => {
    const instagram = catalog.systems.find((s) => s.slug === 'instagram')!;
    const whole = derivePlans({ system: instagram, topics: catalog.topics.filter((t) => t.system === 'instagram').map((t) => ({ slug: t.slug, file: t.file, data: t.data })), override: catalog.interviews.find((i) => i.system === 'instagram')!.data }).system!;
    expect(whole.override).toBe('whole');
    const state = initialState(whole, 0, new Date(NOW).toISOString());
    expect(state.section).toBe('');
    const out = decide({ plan: whole, stageIndex: 0, elapsedMs: minutes(1), state, text: answer(), intent: null, signal: null, idleRung: null, closed: false });
    expect(out.decision).toMatchObject({ row: 17, move: 'ask', index: 1 });
    expect(out.sectionAdvance).toBeUndefined();
  });
});
