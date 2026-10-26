import type { DerivedItem, DerivedPlan, DerivedStage } from '@arrowbox/content-kit';

// The director (docs/README.md, design section 5): a decision table, run once per
// candidate turn (and on idle rungs), that decides what the interviewer does next: which coverage
// item to ask about, whether to probe a wrong answer, rephrase, hint, skip, move to the next
// section inside the stage, advance the stage or wrap up. The model has no tools: it reads the
// decision as a <director> element (prompt.ts) and speaks; the service performs the move.
//
// Pure: everything here is a function of the plan, the session's director state, the clock, the
// candidate's last message and the live signal from the evaluator (one turn behind, null until the
// evaluator has run). The same table is replayed on golden transcripts (director.test.ts) and,
// later, ported to the voice service.

export type Move =
  | 'ask'
  | 'drill_into'
  | 'probe_wrong'
  | 'move_on'
  | 'rephrase'
  | 'give_hint'
  | 'skip_item'
  | 'bridge_section'
  | 'redirect'
  | 'advance_stage'
  | 'end_interview';

export type Intent = { kind: 'advance' } | { kind: 'dont_know' } | { kind: 'drill'; target: string } | null;

/** What the director remembers between turns; stored on the session and reset on a stage change. */
export type DirectorState = {
  /** The current section key (`<topic>/<sectionKey>`) inside the stage; '' for a plan used whole. */
  section: string;
  sectionStartedAt: string;
  /** The item (id) the interviewer is on. */
  focus: string | null;
  /** Consecutive candidate turns that made no progress on the focus item. */
  stuck: number;
  /** Hints given per item (at most two). */
  hints: Record<string, number>;
  /** Items whose wrong answer was probed once (then left alone: realistic mode). */
  probed: string[];
  /** Items skipped (declined, stuck or time). */
  skipped: string[];
  /** Consecutive skips in this stage (two in a row trigger a different move). */
  skipsInARow: number;
  /** The last idle rung applied in this stage (seconds), or null. */
  idle: number | null;
  /** Rows of the last decisions, newest last (for logs and the goldens). */
  rows: number[];
};

/** The live signal the evaluator writes (design section 8); null before its first run. */
export type LiveSignal = {
  basedOnTurn: number;
  items: { id: string; status: 'covered' | 'partial' | 'wrong' | 'contested' | 'declined' | 'open'; conf: number; probed: boolean }[];
  /** The kinds of the last candidate utterances, newest last. */
  recent: string[];
};

export type ItemStatus = 'covered' | 'partial' | 'contested' | 'open' | 'skipped';

export type Decision = {
  row: number;
  move: Move;
  /** The item the move is about (its id), and its 1-based index in the stage notes. */
  item?: string;
  index?: number;
  /** For move_on, skip_item, bridge_section, redirect: where to go next. */
  next?: string;
  nextIndex?: number;
  level?: 1 | 2;
  reason?: 'covered' | 'time' | 'candidate' | 'last_stage' | 'declined' | 'stuck';
  /** For bridge_section: the section keys. */
  from?: string;
  to?: string;
  /** What the model is told to do, in words (fixed templates: no free text from the candidate or the evaluator). */
  template: string;
  /** Time used in the stage, as a share of its minutes; core coverage from the signal. */
  t: number;
  cov: number;
  /** Item indices by status, for the <director> element. */
  covered: number[];
  partial: number[];
  open: number[];
};

export type DirectorInput = {
  plan: DerivedPlan;
  stageIndex: number;
  /** Milliseconds into the stage (pauses already taken out). */
  elapsedMs: number;
  state: DirectorState;
  /** The candidate's message (null on an idle rung). */
  text: string | null;
  intent: Intent;
  signal: LiveSignal | null;
  /** The idle rung being applied (seconds), or null for a candidate turn. */
  idleRung: number | null;
  /** The session is closed to messages (time, turns, budget). */
  closed: boolean;
};

export type DirectorResult = {
  decision: Decision;
  state: DirectorState;
  /** Set when the director moved to the next section inside the stage (an event turn records it). */
  sectionAdvance?: { from: string; to: string };
};

/** Thresholds (design section 5), per stage kind where they differ. */
export const POLICY = {
  /** Past this share of the stage's minutes the stage advances on the next turn. */
  hardTime: 1.3,
  /** Past this share the interviewer asks for one last thing, then advances. */
  softTime: 1.0,
  /** Core coverage that counts as the ground covered. */
  covered: 0.6,
  /** Time share before coverage alone advances the stage (before it, the interviewer drills instead). */
  coverAdvanceAfter: 0.5,
  maxHints: 2,
  /** A candidate turn with fewer words than this makes no progress. */
  shortAnswerWords: 12,
  /** A candidate turn with more words than this gets an acknowledge-and-redirect. */
  longAnswerWords: 220,
  /** Phrase intents fire only on utterances this short (words, fillers stripped). */
  intentMaxWords: 8,
} as const;

export const stageOf = (plan: DerivedPlan, index: number): DerivedStage => plan.stages[Math.min(index, plan.stages.length - 1)];

/** The director's state at the start of a stage. */
export function initialState(plan: DerivedPlan, stageIndex: number, at: string): DirectorState {
  const stage = stageOf(plan, stageIndex);
  return { section: stage.sections[0] ?? '', sectionStartedAt: at, focus: null, stuck: 0, hints: {}, probed: [], skipped: [], skipsInARow: 0, idle: null, rows: [] };
}

/** Supporting items beyond this many are neither numbered in the notes nor asked about (the stage has no time for them). */
export const SUPPORTING_CAP = 8;

/** The stage's items as the notes number them: core first (1..n), then supporting, in section order. */
export function stageItems(stage: DerivedStage): DerivedItem[] {
  const core = stage.items.filter((i) => i.weight === 'core');
  // Supporting items take turns by section, so a section rich in prose does not crowd its
  // neighbour out of the list (the evaluator, the grader and the ratings only see this list).
  const bySection = new Map<string, DerivedItem[]>();
  for (const i of stage.items) {
    if (i.weight === 'core') continue;
    bySection.set(i.section, [...(bySection.get(i.section) ?? []), i]);
  }
  const queues = [...stage.sections.map((k) => bySection.get(k) ?? []), ...[...bySection.entries()].filter(([k]) => !stage.sections.includes(k)).map(([, v]) => v)];
  const supporting: DerivedItem[] = [];
  for (let round = 0; supporting.length < SUPPORTING_CAP && queues.some((q) => round < q.length); round++) {
    for (const q of queues) if (round < q.length && supporting.length < SUPPORTING_CAP) supporting.push(q[round]);
  }
  return [...core, ...supporting];
}

const indexOf = (stage: DerivedStage, id: string) => stageItems(stage).findIndex((i) => i.id === id) + 1;

/** A section's share of its stage's minutes (DerivedSection.minutes), in milliseconds. */
export function sectionShareMs(plan: DerivedPlan, stage: DerivedStage, section: string): number {
  const s = plan.sections.find((x) => x.key === section);
  if (!s || !stage.sections.length) return stage.minutes * 60_000;
  const total = stage.sections.reduce((n, k) => n + (plan.sections.find((x) => x.key === k)?.minutes ?? 0), 0) || 1;
  return (stage.minutes * 60_000 * s.minutes) / total;
}

// ---------------------------------------------------------------------------------------
// Candidate intents: a short phrase that is (nearly) the whole message, never a clause inside an answer.

const FILLERS = /\b(um+|uh+|erm|hmm+|okay|ok|well|so|like|yeah|yes|please|actually|i think|i guess|maybe|just)\b/gi;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(FILLERS, ' ').replace(/\s+/g, ' ').trim();

const ADVANCE = /^(?:can we |could we |let'?s |shall we |i'?d like to |i want to )?(?:move on|move to the next|next (?:stage|topic|section|question|part)|go on|go to the next|skip (?:this|ahead)|continue)(?: (?:stage|topic|section|question|part|please))?$/;
const DONT_KNOW = /^(?:(?:i )?(?:don'?t|do not|really don'?t) know(?: (?:this|that|the answer|it))?|(?:i have |i've )?no idea|(?:i'?m )?not sure(?: about (?:this|that))?|pass(?: on (?:this|that))?|no clue)$/;
const DRILL = /^(?:can we |could we |let'?s |i'?d like to |i want to |let me )?(?:go deeper (?:on|into)|dig into|drill into|stay on|talk more about|say more about|focus on|come back to) (.+?)(?: please)?$/;

/** The candidate's intent, or null when the message is an answer. */
export function intentOf(text: string | null): Intent {
  if (!text) return null;
  const n = normalize(text);
  if (!n || words(n).length > POLICY.intentMaxWords) return null;
  if (ADVANCE.test(n)) return { kind: 'advance' };
  if (DONT_KNOW.test(n)) return { kind: 'dont_know' };
  const drill = DRILL.exec(n);
  if (drill) return { kind: 'drill', target: drill[1] };
  return null;
}

/** The first open or covered core item of the section (or item) the drill names, if it is in this stage. */
function resolveDrill(plan: DerivedPlan, stage: DerivedStage, target: string, statuses: Map<string, ItemStatus>): DerivedItem | null {
  const t = normalize(target);
  const tokens = new Set(words(t));
  const score = (s: string) => words(normalize(s)).filter((w) => tokens.has(w) && w.length > 2).length;
  let best: { item: DerivedItem; score: number } | null = null;
  for (const key of stage.sections) {
    const section = plan.sections.find((x) => x.key === key);
    if (!section) continue;
    const sectionScore = Math.max(score(section.title), score(section.railLabel), score(section.sectionKey.replace(/-/g, ' ')));
    for (const item of stage.items.filter((i) => i.section === key)) {
      const s = Math.max(sectionScore, score(item.text));
      if (s > 0 && (!best || s > best.score) && item.weight === 'core' && statuses.get(item.id) !== 'skipped') best = { item, score: s };
    }
  }
  return best?.item ?? null;
}

// ---------------------------------------------------------------------------------------
// The table

const TEMPLATES = {
  ask: (i: number) => `Ask about item ${i}, using its question. One question only; do not mention items you have marked covered.`,
  drill_into: (i: number) => `Go deeper on item ${i}: ask for the flip condition, the failure case or the number behind it. One question.`,
  probe_wrong: (i: number) => `The last answer contradicts item ${i}. Ask one counter-question that would expose it. Do not say it is wrong and do not state the answer.`,
  move_on: (i: number, j: number) => `Item ${i} stays unresolved: acknowledge in one clause without correcting it, then ask about item ${j}. Do not state the answer.`,
  rephrase: (i: number) => `Rephrase the question on item ${i} with a concrete example from the pm-facts. One question.`,
  hint1: (i: number) => `Give a small hint on item ${i}: name the area it lives in, as a question. Do not give the answer.`,
  hint2: (i: number) => `Give half the answer to item ${i} as a question, and let the candidate finish it.`,
  skip_item: (i: number, j: number) => `Leave item ${i} without comment and ask about item ${j}.`,
  bridge: (from: string, to: string, i: number) => `We are moving from "${from}" to "${to}" inside this stage: say so in one clause, then ask about item ${i}.`,
  redirect: (i: number) => `The last answer was long: acknowledge it in one clause and redirect to item ${i} with one question.`,
  advanceCovered: () => `The ground of this stage is covered: acknowledge the last answer in one sentence and say you are moving to the next stage. Ask nothing; the next stage's opener follows.`,
  advanceTime: () => `Time for this stage is up: acknowledge the last answer in one sentence and say you are moving to the next stage. Ask nothing; the next stage's opener follows.`,
  advanceCandidate: () => `The candidate asked to move on: agree in one sentence and say you are moving to the next stage. Ask nothing; the next stage's opener follows.`,
  lastThing: (i: number) => `Time for this stage is nearly up: say so in one clause and ask one last question about item ${i}.`,
  end: (reason: string) => `This was the last stage (${reason}): thank the candidate in one or two sentences and close the interview. Ask nothing and give no feedback.`,
} as const;

/** Items' statuses from the signal, with the director's own skips on top. */
function statusesOf(stage: DerivedStage, state: DirectorState, signal: LiveSignal | null): Map<string, ItemStatus> {
  const out = new Map<string, ItemStatus>();
  for (const i of stage.items) out.set(i.id, 'open');
  for (const s of signal?.items ?? []) {
    if (!out.has(s.id)) continue;
    out.set(s.id, s.status === 'covered' ? 'covered' : s.status === 'partial' ? 'partial' : s.status === 'wrong' || s.status === 'contested' ? 'contested' : s.status === 'declined' ? 'skipped' : 'open');
  }
  for (const id of state.skipped) out.set(id, 'skipped');
  return out;
}

/** The next item to ask about: section order then weight, preferring partial evidence, never a skipped or covered one. */
function nextItem(stage: DerivedStage, statuses: Map<string, ItemStatus>, section: string, after: string | null): DerivedItem | null {
  const items = stageItems(stage);
  const inSection = section ? items.filter((i) => i.section === section) : items;
  const open = (list: DerivedItem[]) => list.filter((i) => i.id !== after && (statuses.get(i.id) === 'open' || statuses.get(i.id) === 'partial'));
  const pick = (list: DerivedItem[]) => list.find((i) => i.weight === 'core' && statuses.get(i.id) === 'partial') ?? list.find((i) => i.weight === 'core') ?? list[0] ?? null;
  return pick(open(inSection)) ?? pick(open(items));
}

const sectionTitle = (plan: DerivedPlan, key: string) => plan.sections.find((s) => s.key === key)?.title ?? key;

/** Runs the table once. Pure. */
export function decide(input: DirectorInput): DirectorResult {
  const { plan, stageIndex, elapsedMs, text, intent, signal, idleRung, closed } = input;
  const stage = stageOf(plan, stageIndex);
  const last = stageIndex >= plan.stages.length - 1;
  const state: DirectorState = { ...input.state, hints: { ...input.state.hints }, probed: [...input.state.probed], skipped: [...input.state.skipped], rows: [...input.state.rows] };
  const statuses = statusesOf(stage, state, signal);
  const core = stage.items.filter((i) => i.weight === 'core');
  const coreDone = core.filter((i) => statuses.get(i.id) === 'covered' || statuses.get(i.id) === 'skipped').length;
  const cov = core.length ? coreDone / core.length : 0;
  const t = elapsedMs / (stage.minutes * 60_000);
  const items = stageItems(stage);
  const byStatus = (s: ItemStatus) => items.map((i, n) => (statuses.get(i.id) === s ? n + 1 : 0)).filter(Boolean);
  const base = { t: Math.round(t * 100) / 100, cov: Math.round(cov * 100) / 100, covered: byStatus('covered'), partial: byStatus('partial'), open: [...byStatus('open'), ...byStatus('contested')] };
  const wordCount = text ? words(text).length : 0;
  const focus = state.focus ? stage.items.find((i) => i.id === state.focus) ?? null : null;
  const focusStatus = focus ? statuses.get(focus.id) : undefined;
  // Progress: a substantive answer, or the signal saying the focus item moved.
  const progressed = !!text && wordCount >= POLICY.shortAnswerWords && intent?.kind !== 'dont_know';
  if (text !== null) state.stuck = progressed || !focus ? 0 : state.stuck + 1;

  // Section advance inside the stage: all core items of the section done or its minute share used.
  // Decided first, so every row's result records it (the service writes the event turn).
  let sectionAdvance: DirectorResult['sectionAdvance'];
  const done = (decision: Omit<Decision, 't' | 'cov' | 'covered' | 'partial' | 'open'>): DirectorResult => {
    state.rows.push(decision.row);
    if (state.rows.length > 40) state.rows.splice(0, state.rows.length - 40);
    if (decision.item) state.focus = decision.item;
    if (idleRung !== null) state.idle = idleRung;
    return { decision: { ...decision, ...base }, state, ...(sectionAdvance ? { sectionAdvance } : {}) };
  };
  const ask = (row: number, item: DerivedItem | null): DirectorResult => {
    if (!item) return done({ row: 17, move: 'ask', template: `Nothing is left to ask in this stage: ask the candidate what they would change about the design so far. One question.` });
    const index = indexOf(stage, item.id);
    if (sectionAdvance) return done({ row, move: 'bridge_section', item: item.id, index, from: sectionAdvance.from, to: sectionAdvance.to, template: TEMPLATES.bridge(sectionTitle(plan, sectionAdvance.from), sectionTitle(plan, sectionAdvance.to), index) });
    return done({ row, move: 'ask', item: item.id, index, template: TEMPLATES.ask(index) });
  };

  if (state.section && stage.sections.length > 1 && text !== null) {
    const at = stage.sections.indexOf(state.section);
    // A section with no core items (the stage's core cap went to its neighbour) advances on time only.
    const sectionCore = core.filter((i) => i.section === state.section);
    const sectionDone = sectionCore.length > 0 && sectionCore.every((i) => statuses.get(i.id) === 'covered' || statuses.get(i.id) === 'skipped');
    const shareUsed = Date.now() - Date.parse(state.sectionStartedAt) >= sectionShareMs(plan, stage, state.section);
    if (at >= 0 && at < stage.sections.length - 1 && (sectionDone || shareUsed)) {
      sectionAdvance = { from: state.section, to: stage.sections[at + 1] };
      state.section = sectionAdvance.to;
      state.sectionStartedAt = new Date().toISOString();
      state.focus = null;
    }
  }

  // 1. Closed by the service.
  if (closed) return done({ row: 1, move: 'end_interview', reason: 'time', template: TEMPLATES.end('the session is closed') });
  // 2. Hard time limit.
  if (t >= POLICY.hardTime) {
    return last
      ? done({ row: 2, move: 'end_interview', reason: 'time', template: TEMPLATES.end('time is up') })
      : done({ row: 2, move: 'advance_stage', reason: 'time', template: TEMPLATES.advanceTime() });
  }
  // 3. The candidate asked to move on.
  if (intent?.kind === 'advance') {
    return last
      ? done({ row: 3, move: 'end_interview', reason: 'candidate', template: TEMPLATES.end('the candidate asked to wrap up') })
      : done({ row: 3, move: 'advance_stage', reason: 'candidate', template: TEMPLATES.advanceCandidate() });
  }
  // 4. Covered and past half time.
  if (cov >= POLICY.covered && t >= POLICY.coverAdvanceAfter) {
    return last
      ? done({ row: 4, move: 'end_interview', reason: 'last_stage', template: TEMPLATES.end('its ground is covered') })
      : done({ row: 4, move: 'advance_stage', reason: 'covered', template: TEMPLATES.advanceCovered() });
  }
  // 5. Covered early, or a drill request: go deeper.
  if (intent?.kind === 'drill') {
    const target = resolveDrill(plan, stage, intent.target, statuses);
    if (target) return done({ row: 5, move: 'drill_into', item: target.id, index: indexOf(stage, target.id), template: TEMPLATES.drill_into(indexOf(stage, target.id)) });
  }
  if (cov >= POLICY.covered) {
    const target = core.find((i) => statuses.get(i.id) === 'covered' && !state.probed.includes(i.id)) ?? core.find((i) => statuses.get(i.id) === 'covered') ?? focus;
    if (target) return done({ row: 5, move: 'drill_into', item: target.id, index: indexOf(stage, target.id), template: TEMPLATES.drill_into(indexOf(stage, target.id)) });
  }
  // 6. Soft time limit: one last thing, then advance.
  if (t >= POLICY.softTime) {
    if (state.rows[state.rows.length - 1] === 6) {
      return last
        ? done({ row: 6, move: 'end_interview', reason: 'time', template: TEMPLATES.end('time is up') })
        : done({ row: 6, move: 'advance_stage', reason: 'time', template: TEMPLATES.advanceTime() });
    }
    const item = focus && focusStatus !== 'covered' && focusStatus !== 'skipped' ? focus : nextItem(stage, statuses, state.section, null);
    return done({ row: 6, move: 'ask', item: item?.id, index: item ? indexOf(stage, item.id) : undefined, template: TEMPLATES.lastThing(item ? indexOf(stage, item.id) : 1) });
  }
  // 7-8. A wrong answer on the focus item: probe once, then move on without correcting.
  if (focus && focusStatus === 'contested') {
    const index = indexOf(stage, focus.id);
    if (!state.probed.includes(focus.id)) {
      state.probed.push(focus.id);
      return done({ row: 7, move: 'probe_wrong', item: focus.id, index, template: TEMPLATES.probe_wrong(index) });
    }
    const next = nextItem(stage, statuses, state.section, focus.id);
    state.focus = next?.id ?? null;
    return done({ row: 8, move: 'move_on', item: focus.id, index, next: next?.id, nextIndex: next ? indexOf(stage, next.id) : undefined, template: TEMPLATES.move_on(index, next ? indexOf(stage, next.id) : index) });
  }
  // 9. "I don't know": skip, never wrong. The declined item is the focus, or, when the signal has
  // since marked the focus covered (the interviewer moved on before the signal caught up), the
  // first open item.
  if (intent?.kind === 'dont_know' && focus) {
    const declined = (focusStatus === 'covered' ? nextItem(stage, statuses, state.section, null) : null) ?? focus;
    state.skipped.push(declined.id);
    state.skipsInARow += 1;
    state.stuck = 0;
    const next = nextItem(stage, statuses, state.section, declined.id);
    const index = indexOf(stage, declined.id);
    return done({ row: 9, move: 'skip_item', reason: 'declined', item: declined.id, index, next: next?.id, nextIndex: next ? indexOf(stage, next.id) : undefined, template: TEMPLATES.skip_item(index, next ? indexOf(stage, next.id) : index) });
  }
  // 10-12. Stuck on the focus item: rephrase, hint, hint, skip. An idle rung counts as being stuck.
  const stuck = idleRung !== null ? Math.max(state.stuck, idleRung >= 120 ? 2 : 1) : state.stuck;
  if (focus && focusStatus !== 'covered' && focusStatus !== 'skipped' && stuck >= 1) {
    const index = indexOf(stage, focus.id);
    const given = state.hints[focus.id] ?? 0;
    if (stuck === 1 && given === 0 && idleRung !== 120) return done({ row: 10, move: 'rephrase', item: focus.id, index, template: TEMPLATES.rephrase(index) });
    if (given < POLICY.maxHints) {
      const level = (given + 1) as 1 | 2;
      state.hints[focus.id] = level;
      return done({ row: 11, move: 'give_hint', item: focus.id, index, level, template: level === 1 ? TEMPLATES.hint1(index) : TEMPLATES.hint2(index) });
    }
    state.skipped.push(focus.id);
    state.skipsInARow += 1;
    state.stuck = 0;
    const next = nextItem(stage, statuses, state.section, focus.id);
    return done({ row: 12, move: 'skip_item', reason: 'stuck', item: focus.id, index, next: next?.id, nextIndex: next ? indexOf(stage, next.id) : undefined, template: TEMPLATES.skip_item(index, next ? indexOf(stage, next.id) : index) });
  }
  if (text !== null && progressed) state.skipsInARow = 0;
  // 16. A long answer: acknowledge and redirect.
  if (wordCount > POLICY.longAnswerWords) {
    const item = nextItem(stage, statuses, state.section, null);
    if (item) return done({ row: 16, move: 'redirect', item: item.id, index: indexOf(stage, item.id), template: TEMPLATES.redirect(indexOf(stage, item.id)) });
  }
  // 17. Default: the next core item in section order, then weight.
  const keepFocus = focus && focusStatus === 'partial' && !sectionAdvance ? focus : null;
  return ask(17, keepFocus ?? nextItem(stage, statuses, state.section, null));
}

/** The compact record of a decision kept on the turn (Turn.meta.director) and rendered into the prompt. */
export type DirectorMeta = Pick<Decision, 'row' | 'move' | 'index' | 'nextIndex' | 'level' | 'reason' | 'from' | 'to' | 'template' | 't' | 'cov' | 'covered' | 'partial' | 'open'> & { stuck: number };

export const toMeta = (d: Decision, state: DirectorState): DirectorMeta => ({
  row: d.row,
  move: d.move,
  ...(d.index !== undefined ? { index: d.index } : {}),
  ...(d.nextIndex !== undefined ? { nextIndex: d.nextIndex } : {}),
  ...(d.level !== undefined ? { level: d.level } : {}),
  ...(d.reason !== undefined ? { reason: d.reason } : {}),
  ...(d.from !== undefined ? { from: d.from, to: d.to } : {}),
  template: d.template,
  t: d.t,
  cov: d.cov,
  covered: d.covered,
  partial: d.partial,
  open: d.open,
  stuck: state.stuck,
});
