import type Anthropic from '@anthropic-ai/sdk';
import { derivePlans, deriveSectionPlan, deriveTopicPlan, type DerivedPlan } from '@arrowbox/content-kit';
import { loadContent } from '@arrowbox/content-kit/node';
import { fileURLToPath } from 'node:url';
import { decide, initialState, intentOf, stageItems, toMeta, type DirectorState, type LiveSignal } from '../../src/lib/server/interview/director';
import { aggregate, evaluatorRequest, evaluatorSchema, parseEvaluation, toEntry, type Ledger, type LedgerEntry } from '../../src/lib/server/interview/evaluator';
import { assembleFeedback, verifyVerdicts, type ItemVerdict } from '../../src/lib/server/interview/grading';
import { boardTags, matchBoard, sectionsUpTo } from '../../src/lib/server/interview/board-match';
import { compactElements, fingerprint, renderBoard, serialise } from '../../src/lib/board/serialise';
import type { Plan } from '../../src/lib/server/interview/plans';
import { feedbackRequest, feedbackSchema, parseFeedback, stageMarker } from '../../src/lib/server/interview/prompt';
import type { Session, Turn, TurnMeta } from '../../src/lib/server/interview/sessions';
import { costOf, MODELS } from '../../src/lib/server/llm-gateway';
import { GOLDENS, type Golden, type GoldenTag, type GoldenTurn } from './goldens';

// The interview eval (design section 8, "Eval harness"): the golden transcripts replayed through
// the director, the evaluator's rules and the grader. Offline (always, in `npm test`): the
// director lands on the labelled rows, the ledger built from the labelled tags aggregates to the
// labelled statuses, a tag that quotes the interviewer is never credited, and the ratings computed
// from the labelled verdicts match the reviewer's within the MAE gate. Live (`npm run
// eval:interview` with INTERVIEW_EVAL_MODE=live): the real evaluator tags each golden turn and the
// real grader rates each transcript, against the same labels, under a spend cap.

export type EvalOptions = {
  mode: 'stub' | 'live';
  evaluatorModel: string;
  /** 'none' runs the evaluator only (a cheap diagnostic run; the grader gates then pass vacuously). */
  graderModel: string;
  capUsd: number;
  /** Gates (design section 8). */
  minPrecision: number;
  minRecall: number;
  maxWrongFalsePositive: number;
  maxSectionMae: number;
  out: string;
};

export function evalOptions(env: Record<string, string | undefined>): EvalOptions {
  const model = (s: string | undefined, fallback: string) => {
    const m = s ?? fallback;
    if (m !== 'none' && !MODELS[m]) throw new Error(`unknown model ${m} (known: ${Object.keys(MODELS).join(', ')})`);
    return m;
  };
  return {
    mode: env.INTERVIEW_EVAL_MODE === 'live' ? 'live' : 'stub',
    evaluatorModel: model(env.INTERVIEW_EVAL_EVALUATOR, 'claude-haiku-5-5'),
    graderModel: model(env.INTERVIEW_EVAL_GRADER, 'claude-opus-5'),
    capUsd: Number(env.INTERVIEW_EVAL_MAX_USD ?? 3),
    minPrecision: 0.85,
    minRecall: 0.85,
    maxWrongFalsePositive: 0.05,
    maxSectionMae: 0.5,
    out: env.INTERVIEW_EVAL_OUT ?? new URL('../results/', import.meta.url).pathname,
  };
}

// ---------------------------------------------------------------------------------------
// Plans and sessions from the goldens

const contentDir = fileURLToPath(new URL('../../../content', import.meta.url));
let catalogCache: ReturnType<typeof loadContent>['catalog'] | null = null;
const catalog = () => (catalogCache ??= loadContent(contentDir).catalog);

const planCache = new Map<string, Plan>();
/** The system's plan, or a drill's (a topic's, or one section's), as the snapshot builds them. */
export function planFor(system: string, scope: { topic: string; section: string | null } | null = null): Plan {
  const key = `${system}|${scope?.topic ?? ''}|${scope?.section ?? ''}`;
  const hit = planCache.get(key);
  if (hit) return hit;
  const c = catalog();
  const sys = c.systems.find((s) => s.slug === system);
  if (!sys) throw new Error(`unknown system ${system}`);
  // The plan as the snapshot builds it: the hand-written override and the committed prose files included.
  const input = { system: sys, topics: c.topics.filter((t) => t.system === system).map((t) => ({ slug: t.slug, file: t.file, data: t.data })), override: c.interviews.find((i) => i.system === system)?.data ?? null, prose: c.prose.map((p) => p.data) };
  const derived: DerivedPlan | null = scope ? (scope.section ? deriveSectionPlan({ ...input, override: null }, scope.topic, scope.section) : deriveTopicPlan({ ...input, override: null }, scope.topic)) : derivePlans(input).system;
  if (!derived) throw new Error(scope ? `${system}/${scope.topic}${scope.section ? `#${scope.section}` : ''} has no drill` : `${system} has no system plan`);
  const plan: Plan = { system: { slug: sys.slug, name: sys.name }, plan: derived, version: 'eval', briefs: [], scope };
  planCache.set(key, plan);
  return plan;
}

const T0 = Date.parse('2026-10-23T09:00:00Z');
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();

/** The item id for a golden's item number (stage notes numbering). */
export const itemId = (plan: Plan, stage: number, n: number) => stageItems(plan.plan.stages[stage])[n - 1]?.id ?? `?${n}`;

/**
 * A golden tag's item number: given, or the first stage item whose text contains `match`
 * (case-insensitive). An optional tag whose item is not in the stage's list (the supporting cap
 * left it out) resolves to null: the evaluator could not have given it.
 */
export function tagNumber(plan: Plan, stage: number, tag: GoldenTag): number | null {
  if (tag.n !== undefined) return tag.n;
  const needle = tag.match.toLowerCase();
  const i = stageItems(plan.plan.stages[stage]).findIndex((it) => it.text.toLowerCase().includes(needle));
  if (i < 0 && !tag.optional) throw new Error(`no item in stage ${stage} matches "${tag.match}"`);
  return i < 0 ? null : i + 1;
}

/**
 * The ledger entry a turn's board adds (service.ts writeBoardEvidence): the matcher's partial
 * evidence for the stage's drawable items, keyed b<seq>, or null when the board shows none.
 */
export function boardEntry(plan: Plan, golden: Golden, g: GoldenTurn, turnIndex: number, seq: number, section: string): { entry: LedgerEntry | null; meta: Pick<TurnMeta, 'boardCoverage'>; text: string; print: string } | null {
  if (!g.board) return null;
  const stage = plan.plan.stages[golden.stage];
  const elements = compactElements(g.board);
  const graph = serialise(elements);
  const cov = matchBoard(graph, plan.plan.board, { expectedSections: sectionsUpTo(plan.plan.stages, golden.stage, section) });
  const tags = boardTags(stage, plan.plan.board, cov);
  const entry: LedgerEntry | null = tags.length ? { turn: turnIndex, seq, stage: stage.key, section, utterance: 'answer', tags, dropped: [], at: at(g.minute), source: 'board' } : null;
  return { entry, meta: { boardCoverage: cov }, text: renderBoard(graph, { version: seq, stage: stage.key }), print: fingerprint(elements) };
}

/** The (item id, status) labels of a golden turn, optional alternates marked, unresolvable ones left out. */
export function expectedTags(plan: Plan, stage: number, tags: readonly GoldenTag[]): Label[] {
  return tags.flatMap((t) => {
    const n = tagNumber(plan, stage, t);
    return n === null ? [] : [{ item: itemId(plan, stage, n), status: t.status, ...(t.optional ? { optional: true } : {}), ...(t.group ? { group: t.group } : {}) }];
  });
}

export type Replay = {
  golden: Golden;
  plan: Plan;
  /** The session's turns as the service would have saved them (opener, then interviewer/candidate pairs). */
  turns: Turn[];
  /** The ledger built from the labelled tags, one entry per candidate turn. */
  ledger: Ledger;
  /** Per turn: the director's row and move, and the rows the golden expects. */
  director: { seq: number; row: number; move: string; expectedRows: number[]; expectedMove?: string; ok: boolean }[];
  /** The final signal's statuses against the last turn's truth, by item number. */
  statuses: { n: number; expected: string; actual: string; ok: boolean }[];
  /** The ratings computed from the labelled verdicts against the reviewer's, per section of the stage. */
  ratings: { section: string; expected: number; actual: number }[];
  /** The interview ended on the last turn (last-stage goldens). */
  ended: boolean;
  /** The board as the grader gets it (board goldens): its text at the stage's end. */
  boardSnapshots: Session['boardSnapshots'];
};

/**
 * Replays a golden offline: the director on each turn with the signal aggregated from the labelled
 * tags of the turns before, the ledger from the labelled tags, the ratings from the labelled verdicts.
 */
export function replay(golden: Golden): Replay {
  const plan = planFor(golden.system, golden.topic ? { topic: golden.topic, section: golden.section ?? null } : null);
  const stage = plan.plan.stages[golden.stage];
  const turns: Turn[] = [
    { role: 'event', stage: stage.key, text: stageMarker(plan, golden.stage, golden.stage === 0), at: at(0), meta: { stage: golden.stage } },
    { role: 'interviewer', stage: stage.key, text: stage.opener, at: at(0), meta: { source: 'opener', section: stage.sections[0] } },
  ];
  const ledger: Ledger = { entries: {} };
  let state: DirectorState = initialState(plan.plan, golden.stage, at(0));
  const director: Replay['director'] = [];
  let ended = false;
  let boardPrint = '';
  let boardText = '';
  golden.turns.forEach((g, i) => {
    const seq = i + 1;
    if (g.interviewer) turns.push({ role: 'interviewer', stage: stage.key, text: g.interviewer, at: at(g.minute - 0.1), meta: { section: state.section } });
    const elapsedMs = g.minute * 60_000;
    // The section clock is relative to now (the director reads Date.now()): the stage started elapsedMs ago.
    const started = new Date(Date.now() - elapsedMs).toISOString();
    const signal: LiveSignal | null = Object.keys(ledger.entries).length ? aggregate(ledger, plan.plan, state.skipped) : null;
    const out = decide({ plan: plan.plan, stageIndex: golden.stage, elapsedMs, state: { ...state, sectionStartedAt: state.sectionStartedAt === at(0) ? started : state.sectionStartedAt }, text: g.text, intent: intentOf(g.text), signal, idleRung: null, closed: false });
    state = out.state;
    const expectedRows = Array.isArray(g.row) ? g.row : [g.row];
    director.push({ seq, row: out.decision.row, move: out.decision.move, expectedRows, expectedMove: g.move, ok: expectedRows.includes(out.decision.row) && (!g.move || g.move === out.decision.move) });
    if (out.sectionAdvance) turns.push({ role: 'event', stage: stage.key, text: `[Moving on within the stage: ${out.sectionAdvance.to}.]`, at: at(g.minute), meta: { sectionAdvance: out.sectionAdvance, section: out.sectionAdvance.to } });
    const turn: Turn = { role: 'candidate', stage: stage.key, text: g.text, at: at(g.minute), minute: Math.floor(g.minute), meta: { section: state.section, director: toMeta(out.decision, state) } };
    turns.push(turn);
    const index = turns.length - 1;
    // The board, as the service would carry it: its text with the first turn that shows a new version, the evidence in the ledger.
    const board = boardEntry(plan, golden, g, index, seq, state.section);
    const boardChanged = !!board && board.print !== boardPrint;
    if (board && boardChanged) {
      boardPrint = board.print;
      boardText = board.text;
      turn.meta = { ...turn.meta, boardDelta: board.text, boardSeen: seq, ...board.meta };
    }
    // Optional tags are alternates the evaluator may give, not labels the replay asserts.
    const entry: LedgerEntry = toEntry(plan, { turns }, index, seq, { utterance: g.utterance, tags: g.tags.filter((t) => !t.optional).map((t) => ({ item: tagNumber(plan, golden.stage, t)!, status: t.status, conf: t.conf, quote: t.quote })) }, 'labels');
    ledger.entries[seq] = entry;
    if (boardChanged && board?.entry) ledger.entries[`b${seq}`] = board.entry;
    if (out.decision.move === 'end_interview') ended = true;
    turns.push({ role: 'interviewer', stage: stage.key, text: `(reply ${seq})`, at: at(g.minute + 0.1), meta: { section: state.section } });
  });
  const signal = aggregate(ledger, plan.plan, state.skipped);
  const last = golden.turns[golden.turns.length - 1];
  const statuses = stageItems(stage).map((item, i) => {
    const n = i + 1;
    const byMatch = Object.entries(last.truthMatch ?? {}).find(([needle]) => item.text.toLowerCase().includes(needle.toLowerCase()))?.[1];
    const expected = last.truth[n] ?? byMatch ?? 'open';
    const actual = signal.items.find((s) => s.id === item.id)?.status ?? 'open';
    // A board golden's unlisted items may be partial from the drawing, never more.
    const ok = expected === actual || !!(golden.boardEvidence && expected === 'open' && actual === 'partial');
    return { n, expected, actual, ok };
  });
  const verdicts: ItemVerdict[] = Object.entries(golden.verdicts).map(([n, verdict]) => ({ id: itemId(plan, golden.stage, Number(n)), verdict, quote: '', note: '' }));
  const feedback = assembleFeedback(plan.plan, { summary: '', items: verdicts, stages: [], dimensions: [], nextSteps: [] }, turns, 'eval');
  const ratings = stage.sections.map((key, i) => ({ section: key, expected: golden.sectionRatings[i] ?? 0, actual: feedback.sections?.find((s) => s.key === key)?.rating ?? 0 }));
  const boardSnapshots = boardText ? [{ stage: stage.key, version: golden.turns.length, text: boardText, at: at(golden.turns[golden.turns.length - 1].minute) }] : undefined;
  return { golden, plan, turns, ledger, director, statuses, ratings, ended, boardSnapshots };
}

/** A tag that quotes the interviewer's words must never be credited, however the model labels it. */
export function hintedCredits(golden: Golden): number {
  const r = replay(golden);
  const turn = r.turns.findIndex((t) => t.role === 'candidate');
  const text = r.turns[turn].text;
  const entry = toEntry(r.plan, { turns: r.turns }, turn, 1, { utterance: 'answer', tags: [{ item: 3, status: 'covered', conf: 0.95, quote: text.slice(0, 120) }] });
  return entry.tags.length;
}

// ---------------------------------------------------------------------------------------
// Scores

export type Score = { precision: number; recall: number; wrongFalsePositive: number; predicted: number; expected: number };

/**
 * Precision and recall of (item, status) tags against the labels, and the share of predicted wrongs
 * the labels do not have. An optional label is an alternate the reviewer accepts: a hit when
 * predicted, never a miss when not.
 */
export type Label = { item: string; status: string; optional?: boolean; group?: string };

/**
 * For recall, a turn's labels are its required ungrouped tags plus one per group with a required
 * member; a group is recalled when the evaluator gave any of its members.
 */
export function score(pairs: { predicted: { item: string; status: string }[]; expected: Label[] }[]): Score {
  let hit = 0;
  let recalled = 0;
  let predicted = 0;
  let expected = 0;
  let wrongPredicted = 0;
  let wrongFalse = 0;
  for (const p of pairs) {
    predicted += p.predicted.length;
    const required = p.expected.filter((e) => !e.optional);
    const groups = new Set(required.map((e) => e.group).filter((g): g is string => !!g));
    expected += required.filter((e) => !e.group).length + groups.size;
    const groupsHit = new Set<string>();
    for (const t of p.predicted) {
      const label = p.expected.find((e) => e.item === t.item && e.status === t.status);
      if (label) hit++;
      if (label && label.group && groups.has(label.group)) groupsHit.add(label.group);
      else if (label && !label.optional) recalled++;
      if (t.status === 'wrong') {
        wrongPredicted++;
        if (!p.expected.some((e) => e.item === t.item && e.status === 'wrong')) wrongFalse++;
      }
    }
    recalled += groupsHit.size;
  }
  return { precision: predicted ? hit / predicted : 1, recall: expected ? recalled / expected : 1, wrongFalsePositive: wrongPredicted ? wrongFalse / wrongPredicted : 0, predicted, expected };
}

export const mae = (pairs: { expected: number; actual: number }[]) => (pairs.length ? pairs.reduce((n, p) => n + Math.abs(p.expected - p.actual), 0) / pairs.length : 0);

// ---------------------------------------------------------------------------------------
// Live mode: the real evaluator and grader on the goldens

/** One golden turn through the evaluator: what it tagged against the labels, for reading a failed run. */
export type TurnDetail = {
  golden: string;
  seq: number;
  utterance: string | null;
  predicted: { item: string; status: string; conf: number; quote: string }[];
  expected: Label[];
  /** Tags the ledger refused (confidence, quote not the candidate's, or a non-answer utterance). */
  dropped: { item: string; status: string; conf: number; quote: string }[];
  /** When the reply was not the promised JSON: why, and its first characters. */
  unparsed?: { stopReason: string | null; outputTokens: number; head: string };
};

export type LiveReport = {
  evaluator: Score & { model: string; turns: number; hintedCredits: number; dropped: number; details: TurnDetail[] };
  grader: { model: string; sessions: number; sectionMae: number; items: { golden: string; expected: number[]; actual: number[] }[]; unparsed: number; unparsedDetails: { golden: string; stopReason: string | null; head: string }[] };
  spentUsd: number;
};

export class SpendCap {
  spent = 0;
  constructor(private readonly cap: number) {}
  charge(model: string, usage: Anthropic.Beta.BetaUsage) {
    this.spent += costOf(model, usage);
    if (this.spent > this.cap) throw new Error(`spend cap of $${this.cap} reached ($${this.spent.toFixed(3)})`);
  }
}

/** Runs the real evaluator on every golden turn and the real grader on every golden transcript. */
export async function runLive(opts: EvalOptions, client: Anthropic, goldens: Golden[] = GOLDENS): Promise<LiveReport> {
  const cap = new SpendCap(opts.capUsd);
  const pairs: Parameters<typeof score>[0] = [];
  let turns = 0;
  let dropped = 0;
  let hinted = 0;
  const graded: LiveReport['grader']['items'] = [];
  let unparsed = 0;
  const details: TurnDetail[] = [];
  const unparsedDetails: LiveReport['grader']['unparsedDetails'] = [];
  for (const golden of goldens) {
    const r = replay(golden);
    // Each candidate turn, with the transcript before it, through the evaluator.
    const candidates = r.turns.map((t, i) => [t, i] as const).filter(([t]) => t.role === 'candidate');
    for (const [, index] of candidates) {
      const seq = candidates.findIndex(([, i]) => i === index) + 1;
      const g: GoldenTurn = golden.turns[seq - 1];
      const params = evaluatorRequest(r.plan, { turns: r.turns.slice(0, index + 1) }, index);
      const message = await client.beta.messages.create({ ...params, model: opts.evaluatorModel, max_tokens: 3000, output_config: { effort: 'low', format: evaluatorSchema() } });
      cap.charge(opts.evaluatorModel, message.usage);
      turns++;
      const out = parseEvaluation(message);
      const expected = expectedTags(r.plan, golden.stage, g.tags);
      if (!out) {
        pairs.push({ predicted: [], expected });
        const head = message.content.map((b) => (b.type === 'text' ? b.text : `<${b.type}>`)).join('').slice(0, 300);
        details.push({ golden: golden.id, seq, utterance: null, predicted: [], expected, dropped: [], unparsed: { stopReason: message.stop_reason, outputTokens: message.usage.output_tokens, head } });
        continue;
      }
      const entry = toEntry(r.plan, { turns: r.turns }, index, seq, out, opts.evaluatorModel);
      dropped += entry.dropped.length;
      if (golden.kind === 'hinted') hinted += entry.tags.filter((t) => t.status === 'covered').length;
      pairs.push({ predicted: entry.tags.map((t) => ({ item: t.item, status: t.status })), expected });
      details.push({ golden: golden.id, seq, utterance: out.utterance, predicted: entry.tags, expected, dropped: entry.dropped });
    }
    if (opts.graderModel === 'none') continue;
    // The whole transcript through the grader.
    const session: Pick<Session, 'turns' | 'boardSnapshots'> = { turns: r.turns, boardSnapshots: r.boardSnapshots };
    const params = feedbackRequest(r.plan, session);
    const message = await client.beta.messages.create({ ...params, model: opts.graderModel, max_tokens: 8000, output_config: { effort: 'high', format: feedbackSchema(r.plan) } });
    cap.charge(opts.graderModel, message.usage);
    const parsed = parseFeedback(r.plan, message);
    if (!parsed) {
      unparsed++;
      const head = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .slice(0, 400);
      unparsedDetails.push({ golden: golden.id, stopReason: message.stop_reason, head });
      continue;
    }
    const feedback = assembleFeedback(r.plan.plan, { ...parsed, items: verifyVerdicts(r.plan.plan, parsed.items, r.turns) }, r.turns, 'eval');
    const stage = r.plan.plan.stages[golden.stage];
    graded.push({ golden: golden.id, expected: golden.sectionRatings, actual: stage.sections.map((key) => feedback.sections?.find((s) => s.key === key)?.rating ?? 0) });
  }
  const s = score(pairs);
  const ratingPairs = graded.flatMap((g) => g.expected.map((e, i) => ({ expected: e, actual: g.actual[i] ?? 0 })));
  return {
    evaluator: { ...s, model: opts.evaluatorModel, turns, hintedCredits: hinted, dropped, details },
    grader: { model: opts.graderModel, sessions: graded.length, sectionMae: mae(ratingPairs), items: graded, unparsed, unparsedDetails },
    spentUsd: cap.spent,
  };
}

export function formatLive(r: LiveReport): string {
  const e = r.evaluator;
  return [
    `# Interview eval (live)`,
    ``,
    `Evaluator ${e.model}: ${e.turns} turns, precision ${e.precision.toFixed(2)}, recall ${e.recall.toFixed(2)}, wrong false-positive ${e.wrongFalsePositive.toFixed(2)}, hinted credits ${e.hintedCredits}, dropped tags ${e.dropped}`,
    `Grader ${r.grader.model}: ${r.grader.sessions} sessions, section MAE ${r.grader.sectionMae.toFixed(2)}, unparsed ${r.grader.unparsed}`,
    ...r.grader.items.map((g) => `- ${g.golden}: expected ${g.expected.join('/')} got ${g.actual.join('/')}`),
    ...r.grader.unparsedDetails.map((u) => `- ${u.golden}: unparsed (${u.stopReason ?? 'no stop reason'}): ${u.head.replace(/\s+/g, ' ').slice(0, 160)}`),
    ``,
    `## Evaluator misses`,
    ...e.details.flatMap((d) => {
      const short = (id: string) => id.split('/').slice(1).join('/');
      const given = (x: Label) => d.predicted.some((p) => p.item === x.item && p.status === x.status);
      const missed = d.expected.filter((x) => !x.optional && !given(x) && !(x.group && d.expected.some((y) => y.group === x.group && given(y))));
      const extra = d.predicted.filter((p) => !d.expected.some((x) => x.item === p.item && x.status === p.status));
      if (!missed.length && !extra.length && !d.dropped.length) return [];
      return [
        `- ${d.golden} turn ${d.seq} (${d.utterance ?? `unparsed: ${d.unparsed?.stopReason ?? '?'} after ${d.unparsed?.outputTokens ?? '?'} tokens, "${(d.unparsed?.head ?? '').replace(/\s+/g, ' ').slice(0, 120)}"`}):` +
          (missed.length ? ` missed ${missed.map((x) => `${short(x.item)}=${x.status}`).join(', ')}` : '') +
          (extra.length ? ` extra ${extra.map((p) => `${short(p.item)}=${p.status}@${p.conf} "${p.quote.slice(0, 60)}"`).join(', ')}` : '') +
          (d.dropped.length ? ` dropped ${d.dropped.map((p) => `${short(p.item)}=${p.status}@${p.conf} "${p.quote.slice(0, 60)}"`).join(', ')}` : ''),
      ];
    }),
    `Spent $${r.spentUsd.toFixed(3)}`,
  ].join('\n');
}
