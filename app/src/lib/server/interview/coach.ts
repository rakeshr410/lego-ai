import type { DerivedItem, DerivedPlan, DerivedStage } from '@arrowbox/content-kit';
import { intentOf, POLICY, sectionShareMs, stageItems, stageOf, type Intent, type LiveSignal } from './director';

// The coach director (docs/coach-mode.md): a decision table, run on each learner
// message and on each "continue", that decides what the coach does next. Where the interviewer
// (director.ts) probes what the candidate drives, the coach drives: it walks the stage's sections
// and their items in order, teaches one, draws it when it can be drawn, checks it with the item's
// own question, corrects what the answer got wrong, answers the learner's doubts inside the
// syllabus, parks what is outside it, recaps a section and moves on. The model has no tools: it
// reads the decision as a <coach> element (prompt.ts) and writes; the service performs the move.
//
// Pure: a function of the plan, the coach's state, the clock, the learner's message (null on a
// continue) and the evaluator's live signal (one turn behind). Replayed in coach.test.ts.

export type CoachMove =
  | 'intro' // the lesson's first words: what it covers, then the first item
  | 'teach' // explain an item (and draw it when the decision says so)
  | 'check' // ask the item's question
  | 'confirm' // the learner answered a check: say what was right, correct the rest, go on
  | 'reteach' // the answer missed: explain it again, differently
  | 'answer' // a doubt, inside the syllabus
  | 'ask' // a part the learner gives first: ask for their list (the frame drawn first)
  | 'capture' // the learner gave points: write each in their words, then ask what else
  | 'nudge' // the learner paused while giving a list: a hint, not the answer
  | 'credit' // the learner gave every line of the list: say so
  | 'park' // a doubt outside the syllabus, or one too many: note it and return
  | 'recap' // the section is done: sum it up, then the next section's first item
  | 'draw_task' // the stage's parts are taught: ask the learner to draw them (the room shows "Done drawing")
  | 'draw_review' // the learner drew: say what the board has and what it lacks, from the matcher's reading
  | 'advance_stage' // the stage is done: sum it up; the service opens the next stage
  | 'end'; // the last stage is done: close the lesson

export type CoachItemStatus = 'queued' | 'explained' | 'checked' | 'understood' | 'shaky' | 'skipped';

/** What the coach remembers; stored on the session. Items persist across stages (the end screen reads them). */
export type CoachState = {
  /** The stage the section and focus belong to (reset when the stage changes). */
  stage: number;
  /** The current section key inside the stage; '' for a plan used whole. */
  section: string;
  sectionStartedAt: string;
  /** The item being taught or checked, or null between items. */
  focus: string | null;
  items: Record<string, CoachItemStatus>;
  /** Items the coach drew (at most one drawing an item). */
  drawn: string[];
  /** The stage's draw task (plan.stages[].drawTasks[0]), by stage key: asked of the learner, then reviewed. */
  drawTasks?: Record<string, 'asked' | 'done'>;
  /** Checks asked per item (a reteach asks once more). */
  checks: Record<string, number>;
  /** Doubts answered in the current section (past the cap they are parked). */
  doubts: number;
  /** Doubts parked for later, as the learner put them (the recap can name them). */
  parked: string[];
  /** The lesson's opening words were said. */
  opened: boolean;
  rows: number[];
  /** The last move, so a move the learner cut short can be taken back (`cutIn`). */
  last?: { move: CoachMove; item?: string };
  /** An item whose teaching the learner cut short: the next move that teaches it goes back to it. */
  resume?: string;
  /** The parts the learner was asked to give (CoachAsk.key): hints given, and whether the learner is still giving it. */
  asked?: Record<string, { nudges: number; open: boolean }>;
};

/**
 * A part of the lesson the learner gives first (coaching/lessons.ts LessonAsk): the coach asks for the list, writes
 * each point in the learner's words, gives a hint when they pause, then teaches the lines they did not name.
 */
export type CoachAsk = {
  key: string;
  /** The list the learner's points are written on in their words; without one, a point places the plan's part it matches. */
  list?: string;
  items: readonly string[];
  /** Each item's parts the learner can give, by element id. */
  lines: Readonly<Record<string, readonly string[]>>;
  /** Each item's other drawing (arrows, notes on why), placed with what the learner left out. */
  rest?: Readonly<Record<string, readonly string[]>>;
  /** Ids placed when the coach asks (the frame, a heading). */
  before: readonly string[];
  labels: Readonly<Record<string, string>>;
  question: string;
  hints: readonly string[];
  chars: number;
};

export type CoachDecision = {
  row: number;
  move: CoachMove;
  item?: string;
  index?: number;
  /** teach: the item can be drawn now (the prompt allows a <draw> element on this reply). */
  draw?: boolean;
  /** answer: the coach may sketch or write its answer in the lesson's side notes (coaching/aside.ts), never placing the plan's parts. */
  aside?: boolean;
  /** The board plan's ids this move places, when they are not the item's own (an ask's frame, the lines a learner left out). */
  place?: string[];
  /** capture: the lines still open, as `id: words`, and how long a line may be. */
  open?: string[];
  /** recap: the section keys. */
  from?: string;
  to?: string;
  /** advance_stage and end: why. */
  reason?: 'done' | 'time' | 'learner';
  /** draw_task: what the learner is asked to draw (the plan's words). */
  task?: string;
  /** draw_review: the task's items the learner's board has, and the ones it lacks, by index. */
  hit?: number[];
  missed?: number[];
  /** What the model is told to do: fixed templates, no free text from the learner or the evaluator. */
  template: string;
  /** Time used in the stage as a share of its minutes; items taught as a share of the stage's core items. */
  t: number;
  taught: number;
  /** Item indices by status, for the <coach> element. */
  understood: number[];
  shaky: number[];
  left: number[];
};

export type CoachInput = {
  plan: DerivedPlan;
  stageIndex: number;
  /** Milliseconds into the stage. */
  elapsedMs: number;
  state: CoachState;
  /** The learner's message, or null on a continue. */
  text: string | null;
  signal: LiveSignal | null;
  /** The session is closed to messages (time, turns, budget). */
  closed: boolean;
  /** Items the board matcher found on the learner's own drawing this turn (service.ts), for a draw task's review. */
  drawn?: readonly string[];
  /** The learner cut the coach's last move short (they spoke over it): what they say is answered, never a nod. */
  cutIn?: boolean;
  /** The lesson may ask the learner things (checks, draw tasks); false teaches straight through. Default true. */
  questions?: boolean;
  /** The parts the learner gives first (none: every part is taught). */
  asks?: readonly CoachAsk[];
  /** List lines on the board, by element id: all of them, and those written in the learner's words. */
  lines?: { placed: readonly string[]; given: readonly string[] };
};

export type CoachResult = {
  decision: CoachDecision;
  state: CoachState;
  /** Set when the coach moved to the next section inside the stage (an event turn records it). */
  sectionAdvance?: { from: string; to: string };
};

/** Thresholds, beside the director's POLICY. */
export const COACH_POLICY = {
  /** Past this share of the stage's minutes the stage advances on the next turn. */
  hardTime: 1.3,
  /** Past this share, no more checks: the remaining core items are taught briefly, the supporting ones left. */
  softTime: 1.0,
  /** Doubts answered per section before the rest are parked for the recap. */
  doubtsPerSection: 4,
  /** How many times an item is checked at most (the check, then once more after a reteach). */
  maxChecks: 2,
  /** A learner message with at least this many words, after a check, is an answer rather than a remark. */
  answerWords: 4,
} as const;

export function initialCoachState(plan: DerivedPlan, stageIndex: number, at: string, prev?: CoachState): CoachState {
  const stage = stageOf(plan, stageIndex);
  return {
    stage: stageIndex,
    section: stage.sections[0] ?? '',
    sectionStartedAt: at,
    focus: null,
    items: prev?.items ?? {},
    drawn: prev?.drawn ?? [],
    drawTasks: prev?.drawTasks ?? {},
    checks: prev?.checks ?? {},
    doubts: 0,
    parked: [],
    opened: prev?.opened ?? false,
    rows: [],
  };
}

const indexOf = (stage: DerivedStage, id: string) => stageItems(stage).findIndex((i) => i.id === id) + 1;
const sectionTitle = (plan: DerivedPlan, key: string) => plan.sections.find((s) => s.key === key)?.title ?? key.split('/').pop() ?? key;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/** A question, by its shape: a question mark, or an opening question word on a short message. */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  if (t.endsWith('?')) return true;
  return /^(?:what|why|how|when|where|which|who|does|do|is|are|can|could|would|should|isn'?t|aren'?t|don'?t|doesn'?t)\b/i.test(t) && words(t).length <= 30;
}

// A learner who cut the coach off is answered first; the lesson goes back to where it stopped on the next move.
const CUT_ANSWER =
  'They cut you off to say this: answer only it, and do not go back to the lesson in this reply. Your drawing stopped where your voice did: speak only of what the <board> shows now, not of what you were about to draw.';

const TEMPLATES = {
  intro: (i: number) => `Open the lesson in one sentence: what it covers, and that the learner can ask anything or say "move on" at any time. Then teach item ${i}.`,
  teach: (i: number) => `Teach item ${i} in two or three short sentences: the idea, how it works, why. Ask nothing yet.`,
  teachDraw: (i: number) =>
    `Teach item ${i} as above, and draw it as you go: each part's <draw> element at the point in your sentence where the part comes in (boxes, arrows, a note), in the article's layout where the notes show it, not after the explanation.`,
  teachWrite: (i: number) =>
    `Teach item ${i} as above, and write it down: one <draw><note text="..."/></draw> where you state it, its gist in under ten words, so the board builds up this part's list as you teach. When it is the first note of this part, put a heading note before it naming the list.`,
  teachBrief: (i: number) => `Time in this stage is short: teach item ${i} in two sentences, the essential idea only. Ask nothing.`,
  stageIntro: (title: string, i: number) => `A new stage, "${title}", begins: say so in one sentence, then teach item ${i}.`,
  check: (i: number) => `Check item ${i}: turn to the learner ("So ..., tell me,"), ask its question, one question only, and wait for the answer. Explain nothing more.`,
  confirm: (i: number) => `The learner answered the check on item ${i}: say what was right in one sentence, correct what was wrong or missing plainly (state the correct idea), then go on to the next part. Ask nothing.`,
  reteach: (i: number) => `The answer on item ${i} missed the idea: explain it again differently, with a concrete example, then ask the question once more in simpler words.`,
  giveUp: (i: number) => `The learner doesn't know item ${i}: state the answer plainly in two sentences, without any reproach, then go on. Ask nothing.`,
  unanswered: (i: number) =>
    `The learner gave no answer to the check on item ${i}: nobody answered, so praise nothing and judge nothing. Give the answer yourself in one sentence ("The answer is ..."), then:`,
  answer: (i: number | null, cut = false) =>
    `The learner asked a question: answer it in a few sentences from the lesson's material if it is inside this lesson's sections. If it belongs to another section or topic, say in one sentence where it is covered and don't teach it here. ${cut ? CUT_ANSWER : `Then return to ${i ? `item ${i}` : 'the lesson'}.`}`,
  remark: (i: number | null, cut = false) => `The learner made a remark: respond to it in one or two sentences${cut ? `. ${CUT_ANSWER}` : `, then return to ${i ? `item ${i}` : 'the lesson'}.`}`,
  cutIn: (said: string) =>
    `The learner cut in but only said "${said}": stop and let them speak, in a few words ("Yes, go ahead?" or "Sure, what is it?"), and wait. Say nothing else.`,
  resume: (i: number) =>
    `You were cut off while teaching item ${i}. Go back to it: open with "Okay, now let's go back to" and the part you were on (for example "the mock-up"), then pick up where you stopped, without repeating what they already heard, drawing what is not on the board yet. Then: `,
  park: () => `The learner asked another question: say you'll note it and come back to it at the end of this section, in one sentence, and continue where you were. Don't answer it now.`,
  recap: (from: string, to: string, i: number) => `Section "${from}" is done: sum it up in one sentence. Then say you're moving to "${to}" and teach item ${i}.`,
  recapParked: (from: string, to: string, i: number) => `Section "${from}" is done: sum it up in one sentence, then answer the questions you parked, briefly. Then say you're moving to "${to}" and teach item ${i}.`,
  drawTask: (prompt: string) =>
    `The parts of this stage are taught: now the learner draws. Ask them, in two sentences: "${prompt}" Say they can take their time and press "Done drawing" (or tell you) when finished, and that you'll look at it then. Draw nothing yourself, teach nothing more, ask nothing else.`,
  drawReview: (hit: number[], missed: number[]) =>
    hit.length && !missed.length
      ? `The learner drew the parts asked (items ${hit.join(', ')} are on their board). Say so warmly in one sentence and name one thing their drawing shows well, from the <board> element. Then go on. Ask nothing.`
      : hit.length
        ? `The learner's board shows items ${hit.join(', ')} but not ${missed.join(', ')}. Say what is there in one sentence, then say plainly what is missing and where it belongs, without reproach; you may draw the missing parts (draw="yes"). Then go on. Ask nothing.`
        : `The learner's board shows none of the parts asked (items ${missed.join(', ')}); they may have skipped the task. Say in one sentence what the drawing should have had and draw it yourself (draw="yes"), without reproach. Then go on. Ask nothing.`,
  advance: (reason: string) => `This stage is done (${reason}): sum it up in one or two sentences and say you're moving to the next stage. Teach nothing more; the next stage follows.`,
  ask: (question: string, lead = '', frame: readonly string[] = []) =>
    `This part the learner gives first: ask them for it, in two or three sentences at most. ${frame.length ? `First put up the part's frame, <draw><place ids="${frame.join(',')}"/></draw>. ` : ''}${lead}` +
    `Then ask, in your words: "${question}", and say you'll put what they say on the board as they go. The question is the last thing you say. Teach nothing, describe nothing of the part, and name none of its points yourself.`,
  capture: (open: readonly string[], chars: number) =>
    `The learner is giving the list. Write each point they made as one line in their own words, tidied and short (under ${chars} characters, no number): <draw><note text="..." covers="ID"/></draw>, ID being the open line it matches (${open.join('; ')}), or no covers for a point none of them matches. When they give a number and the line it matches has another, write theirs, and say the line's figure in a few words as the usual target, never as a correction. Write only what they said, in their order, each at the point you acknowledge it. Acknowledge in a few words, warmly, and never judge a point: don't say whether it is right, a requirement, in scope or for later, don't correct or add to it, and don't teach. Then ask briefly what else. If they asked you something instead, answer it in a sentence or two, write nothing, and invite them to go on.`,
  captureParts: (open: readonly string[]) =>
    `The learner is giving this part. For each thing they named that matches one of the parts still open (${open.join('; ')}), put it on the board as they say it: <draw><note text="their words" covers="ID"/></draw>, ID being that part (several ids, comma-separated, when one point covers several); the board draws the plan's part where it belongs, in their colour. A sound point none of them matches is a <note text="..."/> in their words, short, with no covers; it goes in the side notes. Put down only what they said, in their order, each at the point you acknowledge it, using their words aloud. Acknowledge in a few words, warmly, and never judge a point: don't say whether it is right or in scope, don't correct or add to it, and don't teach. Then ask briefly what else. If they asked you something instead, answer it in a sentence or two, draw nothing, and invite them to go on.`,
  nudge: (hint: string) => `The learner has paused while giving this part. Offer a pointer, not the answer, in one sentence: "${hint}" Write nothing, teach nothing.`,
  fill: (i: number) => `Then teach item ${i}, only what it says that they did not name, in two or three short sentences, putting each part on the board as you state it; don't repeat what they gave.`,
  given: (k: number, n: number, what = 'lines') => `The learner has given what they had. Open by saying, warmly and in one sentence, that they named ${k} of the ${n} ${what} themselves. `,
  credit: () => `The learner named every part asked for themselves. Say so warmly in one sentence, naming one they put well. Teach nothing more, ask nothing.`,
  end: (reason: string) => `This was the last stage (${reason}): sum up the lesson in three sentences, say what the learner should read next, and close. Ask nothing.`,
} as const;

/** The stage's items the coach teaches, in section order: core first within each section, then supporting. */
export function lessonItems(stage: DerivedStage): DerivedItem[] {
  const items = stageItems(stage);
  const sections = stage.sections.length ? stage.sections : [...new Set(items.map((i) => i.section))];
  return sections.flatMap((key) => [...items.filter((i) => i.section === key && i.weight === 'core'), ...items.filter((i) => i.section === key && i.weight !== 'core')]);
}

const statusOf = (state: CoachState, id: string): CoachItemStatus => state.items[id] ?? 'queued';

/** The next item to teach in the section, or in the stage when the section has none left. */
function nextItem(stage: DerivedStage, state: CoachState, brief: boolean): DerivedItem | null {
  const all = lessonItems(stage);
  const open = (list: DerivedItem[]) => list.filter((i) => statusOf(state, i.id) === 'queued' && (!brief || i.weight === 'core'));
  const inSection = state.section ? all.filter((i) => i.section === state.section) : all;
  return open(inSection)[0] ?? null;
}

/** The learner is done giving a list: "that's all", "nothing else", "I don't know", "that's it". */
const DONE = /^(?:(?:no|nope|nah|okay|ok|so|well|um+|uh+|hmm+)[\s,.!]+)*(?:that(?:'?s| is) (?:all|it|everything|about it)|nothing (?:else|more)|no more|(?:i'?m|i am) done|done|i don'?t know(?: (?:any ?more|more))?|i can'?t think of (?:any|anything)(?: (?:more|else))?|(?:that(?:'?s| is) )?all i (?:have|got|can think of)|nothing comes to mind|i'?m out(?: of ideas)?|you (?:go|take it|continue)|go ahead|no)\b[\s,.!…]*$/i;

/** Runs the table once. Pure. */
/**
 * A nod: the learner acknowledging what was said ("okay", "mhmm", "sure", "go on", "continue"). In a lesson it
 * carries on as a continue does (a check it follows gets its answer first); only "move on" or "skip" leaves a
 * section. Without this, every "okay" was a remark the coach acknowledged, and the lesson stood still.
 */
const NOD = /^(?:(?:ok(?:ay)?|yes|yeah|yep|yup|sure|m+h?m+|uh[ -]?huh|right|alright|all right|cool|fine|nice|great|good|got it|i see|understood|makes sense|sounds good|go on|go ahead|carry on|continue|keep going|next|tell me|and then|then|so|hmm+|ah+|oh+)\b[\s,.!?…-]*)+$/i;
export const isNod = (text: string): boolean => NOD.test(text.trim().toLowerCase().replace(/['’]/g, ''));

/** The moves that ask the learner something; every other move's questions are dropped (askRule in prompt.ts). */
export const asksLearner = (move: CoachMove): boolean => move === 'check' || move === 'reteach' || move === 'draw_task' || move === 'ask' || move === 'capture' || move === 'nudge';

const QUESTION = /\?["'”’)\]]*\s*$/;
const CLOSERS = `"'”’)]`;
const DRAWING = /<draw>[\s\S]*?<\/draw>|<place\b[^>]*>/gi;
/** A sentence as said: a question keeps only its drawings (the board still gets them), nothing of its words. */
const unasked = (sentence: string) => {
  if (!QUESTION.test(sentence)) return sentence;
  const drawings = sentence.match(DRAWING) ?? [];
  return drawings.join('');
};
/** Words to say, beyond any drawing. */
const says = (sentence: string) => /\w/.test(sentence.replace(DRAWING, ''));
/** A question to the learner ("Does that make sense?", "Can you see why?"), not one the coach asks to answer itself. */
const TO_LEARNER = /\b(?:you|your|yourself|yours)\b|\bmake[s]? sense\b|\b(?:right|ok|okay|clear|ready|got it|agreed|follow)\s*\?/i;
/**
 * A question the coach answers itself ("So why not an offset? Picture this: ..."), kept when more of the reply
 * follows it: spoken, it makes the point a turn, and nobody is left waiting to answer.
 */
const rhetorical = (sentence: string) => QUESTION.test(sentence) && !TO_LEARNER.test(sentence.replace(DRAWING, ''));

/** The reply's finished sentences (an end mark, then a space, outside any drawing), and the rest still to come. */
function sentences(text: string): { done: string[]; rest: string } {
  const done: string[] = [];
  let from = 0;
  let tag = false;
  let draw = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<') {
      tag = true;
      const t = text.slice(i, i + 7).toLowerCase();
      if (t.startsWith('<draw>')) draw = true;
      else if (t.startsWith('</draw>')) draw = false;
      continue;
    }
    if (tag) {
      if (c === '>') tag = false;
      continue;
    }
    if (draw || (c !== '.' && c !== '!' && c !== '?')) continue;
    let j = i + 1;
    while (j < text.length && CLOSERS.includes(text[j])) j++;
    if (j >= text.length || !/\s/.test(text[j])) continue;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (j >= text.length) break; // the spaces may run on: the sentence is told when the next one starts
    done.push(text.slice(from, j));
    from = j;
    i = j - 1;
  }
  return { done, rest: text.slice(from) };
}

/** A reply without the questions it asks the learner (a move that is not a check: teaching never ends on one). */
export function dropQuestions(text: string): string {
  const { done, rest } = sentences(text);
  const all = [...done, rest];
  const kept = all.map((s, k) => (rhetorical(s) && all.slice(k + 1).some(says) ? s : unasked(s))).join('').trim();
  return kept || text.trim();
}

/** The same, as the reply streams: each sentence goes on when it is finished, unless it asks something. */
export function questionFilter(forward: (delta: string) => void): { onText: (delta: string) => void; flush: () => void } {
  let held = '';
  // A question the coach may answer itself waits for what follows: said if more comes, dropped at the end.
  let pending: string[] = [];
  const settle = (more: boolean) => {
    for (const q of pending) {
      const said = more ? q : unasked(q);
      if (said) forward(said);
    }
    pending = [];
  };
  return {
    onText: (delta) => {
      const { done, rest } = sentences(held + delta);
      for (const s of done) {
        if (says(s)) settle(true);
        if (rhetorical(s) || (pending.length && !says(s))) {
          pending.push(s);
          continue;
        }
        const said = unasked(s);
        if (said) forward(said);
      }
      held = rest;
    },
    flush: () => {
      if (says(held) && !rhetorical(held)) settle(true);
      settle(false);
      const said = held && unasked(held);
      if (said) forward(said);
      held = '';
    },
  };
}

export function decideCoach(input: CoachInput): CoachResult {
  const { plan, stageIndex, elapsedMs, signal, closed } = input;
  const cutIn = !!input.cutIn;
  const asks = input.questions !== false;
  // Said over the coach, even "okay so" means the learner wants the floor: it is answered, not taken as a nod.
  const text = input.text !== null && !cutIn && isNod(input.text) ? null : input.text;
  const stage = stageOf(plan, stageIndex);
  const last = stageIndex >= plan.stages.length - 1;
  const state: CoachState = {
    ...input.state,
    items: { ...input.state.items },
    drawn: [...input.state.drawn],
    drawTasks: { ...(input.state.drawTasks ?? {}) },
    checks: { ...input.state.checks },
    parked: [...input.state.parked],
    rows: [...input.state.rows],
    ...(input.state.asked ? { asked: Object.fromEntries(Object.entries(input.state.asked).map(([k, v]) => [k, { ...v }])) } : {}),
  };
  const parts = input.asks ?? [];
  const placed = new Set(input.lines?.placed ?? []);
  const given = new Set(input.lines?.given ?? []);
  const askOf = (id: string) => parts.find((a) => a.items.includes(id));
  // A teaching move the learner cut short did not happen as planned: its item is taught (and drawn) again, from
  // where the voice stopped, once the learner has been answered. A cut check stands (they are likely answering it).
  const cut = cutIn ? input.state.last : undefined;
  if (cut?.item && (cut.move === 'intro' || cut.move === 'teach' || cut.move === 'recap') && state.items[cut.item] === 'explained') {
    state.items[cut.item] = 'queued';
    state.drawn = state.drawn.filter((id) => id !== cut.item);
    state.resume = cut.item;
  }
  const items = stageItems(stage);
  const core = items.filter((i) => i.weight === 'core');
  const t = elapsedMs / (stage.minutes * 60_000);
  const brief = t >= COACH_POLICY.softTime;
  const intent: Intent = intentOf(text);
  const focus = state.focus ? (items.find((i) => i.id === state.focus) ?? null) : null;
  const focusStatus = focus ? statusOf(state, focus.id) : null;

  // The signal's verdict on a checked item: the evaluator tagged the learner's answer (one turn behind).
  const verdict = (id: string): 'understood' | 'shaky' | null => {
    const s = signal?.items.find((i) => i.id === id);
    if (!s) return null;
    if (s.status === 'covered') return 'understood';
    if (s.status === 'wrong' || s.status === 'contested' || s.status === 'partial') return 'shaky';
    return null;
  };

  let sectionAdvance: CoachResult['sectionAdvance'];
  // A check the learner let pass without a word (a continue, the voice's idle): the next move gives its answer first.
  let unanswered: number | null = null;
  const finish = (decision: Omit<CoachDecision, 't' | 'taught' | 'understood' | 'shaky' | 'left'>): CoachResult => {
    if (unanswered !== null) decision = { ...decision, template: `${TEMPLATES.unanswered(unanswered)} ${decision.template}` };
    state.last = { move: decision.move, ...(decision.item ? { item: decision.item } : {}) };
    state.rows.push(decision.row);
    if (state.rows.length > 40) state.rows.splice(0, state.rows.length - 40);
    if (decision.item) state.focus = decision.item;
    const by = (f: (s: CoachItemStatus) => boolean) => items.map((i, n) => (f(statusOf(state, i.id)) ? n + 1 : 0)).filter(Boolean);
    const taught = core.length ? core.filter((i) => statusOf(state, i.id) !== 'queued').length / core.length : 0;
    return {
      decision: {
        ...decision,
        t: Math.round(t * 100) / 100,
        taught: Math.round(taught * 100) / 100,
        understood: by((s) => s === 'understood'),
        shaky: by((s) => s === 'shaky'),
        left: by((s) => s === 'queued'),
      },
      state,
      ...(sectionAdvance ? { sectionAdvance } : {}),
    };
  };
  const teach = (row: number, item: DerivedItem, opts: { stageIntro?: boolean } = {}): CoachResult => {
    const index = indexOf(stage, item.id);
    // A part the learner gives first: ask for it (its frame drawn), and teach nothing yet.
    const ask = askOf(item.id);
    if (ask && !brief && !state.asked?.[ask.key]) {
      state.asked = { ...state.asked, [ask.key]: { nudges: 0, open: true } };
      // A lesson may open on a part the learner gives: the opening sentence, then the question.
      const opening = !state.opened;
      state.opened = true;
      const lead = opening
        ? `Open the lesson in one sentence: what it covers, and that the learner can ask anything or say "move on" at any time. `
        : sectionAdvance
        ? `Open with one sentence summing up "${sectionTitle(plan, sectionAdvance.from)}" and saying you're moving to "${sectionTitle(plan, sectionAdvance.to)}". `
        : opts.stageIntro
          ? `Open with one sentence saying the next part, "${stage.title}", begins. `
          : '';
      const before = ask.before.filter((id) => !placed.has(id));
      return finish({
        row: 14,
        move: 'ask',
        item: item.id,
        index,
        draw: before.length > 0,
        place: before,
        ...(sectionAdvance ? { from: sectionAdvance.from, to: sectionAdvance.to } : {}),
        template: TEMPLATES.ask(ask.question, lead, before),
      });
    }
    // After the learner gave the list: only the item's lines they left out are taught and written.
    if (ask && state.asked?.[ask.key] && !state.asked[ask.key].open) {
      const missing = [...(ask.lines[item.id] ?? []), ...(ask.rest?.[item.id] ?? [])].filter((id) => !placed.has(id));
      const lines = ask.items.flatMap((i) => ask.lines[i] ?? []);
      // The first move after the list is closed credits what the learner named.
      const first = !ask.items.some((i) => statusOf(state, i) === 'explained');
      state.items[item.id] = 'explained';
      state.focus = item.id;
      if (!state.drawn.includes(item.id)) state.drawn.push(item.id);
      return finish({
        row,
        move: 'teach',
        item: item.id,
        index,
        draw: missing.length > 0,
        place: missing,
        template: (first ? TEMPLATES.given(lines.filter((id) => given.has(id)).length, lines.length, ask.list ? 'lines' : 'parts') : '') + TEMPLATES.fill(index),
      });
    }
    state.items[item.id] = 'explained';
    state.focus = item.id;
    // Every item goes on the board once: a part is drawn, anything else (a requirement, a target, a rule) written down.
    // A lesson's board is the pack's (docs/coaching.md): a beat with nothing planned for it is said, not written.
    const canDraw = !brief && !state.drawn.includes(item.id) && (item.source !== 'author' || !!item.drawable);
    if (canDraw) state.drawn.push(item.id);
    const onBoard = item.drawable ? TEMPLATES.teachDraw(index) : TEMPLATES.teachWrite(index);
    if (state.resume === item.id) {
      delete state.resume;
      return finish({
        row,
        move: 'teach',
        item: item.id,
        index,
        draw: canDraw,
        template: TEMPLATES.resume(index) + (canDraw ? onBoard : TEMPLATES.teach(index)),
      });
    }
    if (!state.opened) {
      state.opened = true;
      return finish({
        row,
        move: 'intro',
        item: item.id,
        index,
        draw: canDraw,
        template: TEMPLATES.intro(index) + (canDraw ? ` ${onBoard}` : ''),
      });
    }
    if (sectionAdvance) {
      const parked = state.parked.length > 0;
      state.parked = [];
      const from = sectionTitle(plan, sectionAdvance.from);
      const to = sectionTitle(plan, sectionAdvance.to);
      return finish({
        row,
        move: 'recap',
        item: item.id,
        index,
        draw: canDraw,
        from: sectionAdvance.from,
        to: sectionAdvance.to,
        template: (parked ? TEMPLATES.recapParked : TEMPLATES.recap)(from, to, index) + (canDraw ? ` ${onBoard}` : ''),
      });
    }
    if (opts.stageIntro)
      return finish({
        row,
        move: 'teach',
        item: item.id,
        index,
        draw: canDraw,
        template: TEMPLATES.stageIntro(stage.title, index) + (canDraw ? ` ${onBoard}` : ''),
      });
    return finish({
      row,
      move: 'teach',
      item: item.id,
      index,
      draw: canDraw,
      template: brief ? TEMPLATES.teachBrief(index) : canDraw ? onBoard : TEMPLATES.teach(index),
    });
  };
  const leave = (row: number, reason: CoachDecision['reason'], why: string): CoachResult => {
    // Whatever was being taught or checked is left as it stands: a check without an answer is shaky, an
    // explanation nobody answered stays explained (understanding takes an answer).
    if (focus && focusStatus === 'checked') state.items[focus.id] = verdict(focus.id) ?? 'shaky';
    state.focus = null;
    return last
      ? finish({ row, move: 'end', reason, template: TEMPLATES.end(why) })
      : finish({
          row,
          move: 'advance_stage',
          reason,
          template: TEMPLATES.advance(why),
        });
  };

  // 1. Closed by the service.
  if (closed) return leave(1, 'time', 'the session is closed');
  // 2. Hard time limit.
  if (t >= COACH_POLICY.hardTime) return leave(2, 'time', 'time is up');
  // 3. The learner asked to move on: the stage, when the section is its last; else the next section.
  if (intent?.kind === 'advance') {
    const at = stage.sections.indexOf(state.section);
    if (at < 0 || at >= stage.sections.length - 1) return leave(3, 'learner', 'the learner asked to move on');
    for (const i of lessonItems(stage)) if (i.section === state.section && statusOf(state, i.id) === 'queued') state.items[i.id] = 'skipped';
    if (focus && focusStatus === 'checked') state.items[focus.id] = verdict(focus.id) ?? 'shaky';
    sectionAdvance = { from: state.section, to: stage.sections[at + 1] };
    state.section = sectionAdvance.to;
    state.sectionStartedAt = new Date().toISOString();
    state.focus = null;
    const next = nextItem(stage, state, brief);
    if (!next) return leave(3, 'learner', 'the learner asked to move on');
    return teach(3, next);
  }

  // 14-16. A part the learner is giving: each point they make is written down (capture), a pause gets a hint
  // (nudge), and "that's all", or a pause past the hints, closes it: what they named counts as understood, and
  // the lines they left out are taught next.
  const giving = parts.find((a) => state.asked?.[a.key]?.open) ?? null;
  // "That's all" closes the list and the lesson goes on as on a continue.
  let finished = false;
  if (giving) {
    const entry = state.asked![giving.key];
    const done = input.text !== null && DONE.test(input.text.trim());
    if (text !== null && !done && !brief) {
      const open = giving.items.flatMap((i) => giving.lines[i] ?? []).filter((id) => !placed.has(id)).map((id) => `${id}: ${giving.labels[id] ?? id}`);
      return finish({ row: 15, move: 'capture', item: giving.items[0], draw: true, place: [], open, template: giving.list ? TEMPLATES.capture(open, giving.chars) : TEMPLATES.captureParts(open) });
    }
    if (text === null && !done && !brief && entry.nudges < giving.hints.length) {
      const hint = giving.hints[entry.nudges];
      entry.nudges += 1;
      return finish({ row: 16, move: 'nudge', item: giving.items[0], template: TEMPLATES.nudge(hint) });
    }
    entry.open = false;
    finished = true;
    for (const i of giving.items) {
      const lines = giving.lines[i] ?? [];
      const rest = giving.rest?.[i] ?? [];
      if (lines.length && lines.every((id) => given.has(id)) && rest.every((id) => placed.has(id))) state.items[i] = 'understood';
    }
    if (giving.items.every((i) => statusOf(state, i) === 'understood')) return finish({ row: 17, move: 'credit', template: TEMPLATES.credit() });
  }

  // 13. The learner drew what the stage asked (a continue, "Done drawing", or a remark; a question is still a
  // doubt): the matcher's reading of their board, and the live signal's, decide what to say.
  const task = stage.drawTasks[0];
  if (task && state.drawTasks?.[stage.key] === 'asked' && (text === null || !isQuestion(text))) {
    state.drawTasks[stage.key] = 'done';
    const onBoard = (id: string) => input.drawn?.includes(id) || ['covered', 'partial'].includes(signal?.items.find((i) => i.id === id)?.status ?? '');
    const hit = task.expects.filter((id) => items.some((i) => i.id === id) && onBoard(id));
    const missed = task.expects.filter((id) => items.some((i) => i.id === id) && !onBoard(id));
    for (const id of hit) if (statusOf(state, id) === 'shaky' || statusOf(state, id) === 'explained') state.items[id] = 'understood';
    const hitIndex = hit.map((id) => indexOf(stage, id)).sort((a, b) => a - b);
    const missedIndex = missed.map((id) => indexOf(stage, id)).sort((a, b) => a - b);
    const canDraw = !brief && missed.length > 0;
    return finish({ row: 13, move: 'draw_review', draw: canDraw, hit: hitIndex, missed: missedIndex, template: TEMPLATES.drawReview(hitIndex, missedIndex) });
  }

  if (text !== null && !finished) {
    // A cut-in with nothing in it yet ("okay so", "wait"): the coach gives them the floor.
    if (cutIn && (isNod(text) || (words(text).length < 2 && !isQuestion(text))))
      return finish({ row: 7, move: 'answer', item: focus?.id, index: focus ? indexOf(stage, focus.id) : undefined, template: TEMPLATES.cutIn(text.trim().slice(0, 60)) });
    // 4. An answer to the check on the focus item.
    if (focus && focusStatus === 'checked' && !isQuestion(text) && (intent?.kind === 'dont_know' || words(text).length >= COACH_POLICY.answerWords)) {
      const index = indexOf(stage, focus.id);
      if (intent?.kind === 'dont_know') {
        state.items[focus.id] = 'shaky';
        return finish({
          row: 4,
          move: 'confirm',
          item: focus.id,
          index,
          template: TEMPLATES.giveUp(index),
        });
      }
      // The evaluator has not seen this answer yet: the model judges it in words; the signal settles the status on the next continue.
      state.items[focus.id] = 'understood';
      return finish({
        row: 4,
        move: 'confirm',
        item: focus.id,
        index,
        template: TEMPLATES.confirm(index),
      });
    }
    // 5-6. A doubt: answered inside the syllabus, parked past the section's share of them.
    const at = focus ? indexOf(stage, focus.id) : null;
    if (isQuestion(text)) {
      if (state.doubts >= COACH_POLICY.doubtsPerSection) {
        state.parked.push(text.trim().slice(0, 200));
        return finish({
          row: 6,
          move: 'park',
          item: focus?.id,
          index: at ?? undefined,
          template: TEMPLATES.park(),
        });
      }
      state.doubts += 1;
      return finish({
        row: 5,
        move: 'answer',
        aside: true,
        item: focus?.id,
        index: at ?? undefined,
        template: TEMPLATES.answer(at, cutIn),
      });
    }
    // 7. A remark (or a short reply that is not an answer).
    return finish({
      row: 7,
      move: 'answer',
      item: focus?.id,
      index: at ?? undefined,
      template: TEMPLATES.remark(at, cutIn),
    });
  }

  // A continue. 8. The focus item was checked: the evaluator's verdict decides whether to teach it again.
  if (focus && focusStatus === 'checked') {
    const v = verdict(focus.id);
    const index = indexOf(stage, focus.id);
    if (v === 'shaky' && (state.checks[focus.id] ?? 0) < COACH_POLICY.maxChecks && !brief) {
      state.checks[focus.id] = (state.checks[focus.id] ?? 0) + 1;
      return finish({
        row: 8,
        move: 'reteach',
        item: focus.id,
        index,
        template: TEMPLATES.reteach(index),
      });
    }
    if (v) state.items[focus.id] = v;
    else {
      // No answer came: nothing shows the idea landed.
      state.items[focus.id] = 'shaky';
      unanswered = index;
    }
  } else if (focus && focusStatus === 'understood') {
    // The learner's answer was confirmed in words; a later verdict may still mark it shaky.
    const v = verdict(focus.id);
    if (v) state.items[focus.id] = v;
  }
  // 9. The focus item was explained: check it, unless time is short or it has no question.
  if (focus && focusStatus === 'explained') {
    const index = indexOf(stage, focus.id);
    if (asks && !brief && focus.probe && (state.checks[focus.id] ?? 0) < 1) {
      state.items[focus.id] = 'checked';
      state.checks[focus.id] = 1;
      return finish({
        row: 9,
        move: 'check',
        item: focus.id,
        index,
        template: TEMPLATES.check(index),
      });
    }
    // Not checked: it stays explained (understanding takes an answer).
  }
  // 10. The next item of the section; then the next section, with a recap; then the stage is done.
  let next = nextItem(stage, state, brief);
  if (!next && state.section) {
    const at = stage.sections.indexOf(state.section);
    if (at >= 0 && at < stage.sections.length - 1) {
      sectionAdvance = { from: state.section, to: stage.sections[at + 1] };
      state.section = sectionAdvance.to;
      state.sectionStartedAt = new Date().toISOString();
      state.doubts = 0;
      state.focus = null;
      next = nextItem(stage, state, brief);
    }
  }
  if (!next) {
    // 12. The stage's parts are taught and there is time: the learner draws them back before the stage ends.
    // Not when the coach has drawn all of it already: the learner would be asked to draw what is on the board.
    const drawnAlready = !!task && task.expects.every((id) => state.drawn.includes(id));
    if (asks && task && !brief && !state.drawTasks?.[stage.key] && !drawnAlready) {
      state.drawTasks = { ...(state.drawTasks ?? {}), [stage.key]: 'asked' };
      state.focus = null;
      return finish({ row: 12, move: 'draw_task', task: task.prompt, template: TEMPLATES.drawTask(task.prompt) });
    }
    const reason = brief ? 'time' : 'done';
    return leave(11, reason, brief ? 'time is up' : 'its ground is covered');
  }
  const first = !items.some((i) => statusOf(state, i.id) !== 'queued');
  return teach(10, next, { stageIntro: first && state.opened });
}

/** The compact record of a decision kept on the turn (Turn.meta.coach) and rendered into the prompt. */
export type CoachMeta = Pick<CoachDecision, 'row' | 'move' | 'index' | 'draw' | 'aside' | 'place' | 'from' | 'to' | 'reason' | 'task' | 'hit' | 'missed' | 'template' | 't' | 'taught' | 'understood' | 'shaky' | 'left'>;

export const toCoachMeta = (d: CoachDecision): CoachMeta => ({
  row: d.row,
  move: d.move,
  ...(d.index !== undefined ? { index: d.index } : {}),
  ...(d.draw ? { draw: true } : {}),
  ...(d.aside ? { aside: true } : {}),
  ...(d.place?.length ? { place: d.place } : {}),
  ...(d.from !== undefined ? { from: d.from, to: d.to } : {}),
  ...(d.reason !== undefined ? { reason: d.reason } : {}),
  ...(d.task !== undefined ? { task: d.task } : {}),
  ...(d.hit !== undefined ? { hit: d.hit, missed: d.missed ?? [] } : {}),
  template: d.template,
  t: d.t,
  taught: d.taught,
  understood: d.understood,
  shaky: d.shaky,
  left: d.left,
});

/** The lesson's progress as the room shows it: every stage's sections and items with their status. */
export type LessonView = {
  stages: {
    key: string;
    title: string;
    sections: {
      key: string;
      title: string;
      items: {
        id: string;
        text: string;
        status: CoachItemStatus;
        core: boolean;
      }[];
    }[];
  }[];
  understood: number;
  /** Taught, but no answer shows whether it landed (not checked, or a check still open). */
  explained: number;
  shaky: number;
  left: number;
  /** The item being taught or checked, if any. */
  focus: string | null;
  /** What the coach waits for: the learner's answer to a check, their drawing (a draw task), or a continue (the room's auto-continue). */
  waiting: 'answer' | 'draw' | 'continue';
  /** The draw task's words, while the coach waits for the drawing. */
  task: string | null;
};

export function lessonView(plan: DerivedPlan, state: CoachState | undefined, stageIndex: number): LessonView {
  const stages = plan.stages.map((s, n) => {
    const items = lessonItems(s);
    const keys = s.sections.length ? s.sections : [...new Set(items.map((i) => i.section))];
    return {
      key: s.key,
      title: s.title,
      sections: keys.map((key) => ({
        key,
        title: sectionTitle(plan, key),
        items: items
          .filter((i) => i.section === key)
          .map((i) => ({
            id: i.id,
            text: i.text,
            status: n < stageIndex && (state?.items[i.id] ?? 'queued') === 'queued' ? ('skipped' as const) : (state?.items[i.id] ?? 'queued'),
            core: i.weight === 'core',
          })),
      })),
    };
  });
  const all = stages.flatMap((s) => s.sections.flatMap((x) => x.items));
  const focus = state?.focus ?? null;
  const current = plan.stages[Math.min(stageIndex, plan.stages.length - 1)];
  const drawing = !!current && state?.drawTasks?.[current.key] === 'asked' && !!current.drawTasks[0];
  return {
    stages,
    understood: all.filter((i) => i.status === 'understood').length,
    explained: all.filter((i) => i.status === 'explained' || i.status === 'checked').length,
    shaky: all.filter((i) => i.status === 'shaky').length,
    left: all.filter((i) => i.status === 'queued' || i.status === 'skipped').length,
    focus,
    // A part the learner is giving waits for them as a check does.
    waiting: (focus && state?.items[focus] === 'checked') || Object.values(state?.asked ?? {}).some((a) => a.open) ? 'answer' : drawing ? 'draw' : 'continue',
    task: drawing ? current.drawTasks[0].prompt : null,
  };
}

export { POLICY as INTERVIEW_POLICY, sectionShareMs };
