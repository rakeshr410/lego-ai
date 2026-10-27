import type Anthropic from '@anthropic-ai/sdk';
import { interviewMinutes } from '@arrowbox/content-kit';
import { AskError, checkGateway, createMessage, streamMessage, type Lane, type Reservation } from '../llm-gateway';
import { getStore } from '../store';
import { chargeMeter, LedgerError, ledgerOn, openMeter, productOf } from '../credits';
import { CONSENT_VERSION, interviewConfig, MAX_MESSAGE_CHARS, MAX_VOICE_MESSAGE_CHARS, VOICE_CONSENT_VERSION, type InterviewConfig } from './config';
import { getPlan, sameScope, type Plan, type PlanScope } from './plans';
import { decide, initialState, intentOf, toMeta, type DirectorResult, type LiveSignal } from './director';
import { asksLearner, decideCoach, dropQuestions, initialCoachState, lessonView, questionFilter, toCoachMeta, type CoachResult, type LessonView } from './coach';
import { aggregate, evaluatorRequest, evaluatorSchema, parseEvaluation, toEntry, type Ledger } from './evaluator';
import { assembleFeedback, verifyVerdicts } from './grading';
import { coachRequest, feedbackRequest, feedbackSchema, lessonMarker, parseFeedback, replyOf, replyRequest, stageMarker, type BoardImage } from './prompt';
import { recallFor, exportProgress, purgeProgress, recordProgress } from '../coaching/progress';
import { nextLesson } from '../coaching/lessons';
import { COACH_DRAW_MAX_OPS, PLACE_MAX_IDS, countWords, drawParser, fillPlanned, listRuns, onBoard, readBack, drawToolBody, drawToolResult, holdDraw, parseDraw, type DrawAnchor, type DrawOp, type DrawOptions } from './draw';
import type { CallResult } from '../llm-gateway';
import { claimPrefetch, normalizeSpoken, startPrefetch, type PrefetchKey } from './prefetch';
import { createHash } from 'node:crypto';
import { BoardConflict, BoardInvalid, boardTextFor, CURRENT_PNG, readBoard, readPng, saveBoard, savePng, withSnapshot, type BoardRecord } from './board';
import { boardMatchRequest, boardMatchSchema, boardTags, boardVisionRequest, matchBoard, parseBoardMatch, parseBoardVision, sectionsUpTo, type Coverage } from './board-match';
import type { BoardElement, BoardGraph } from '../../board/serialise';
import { plannedIds } from '../coaching/notes';
import { asideFor } from '../coaching/aside';
import {
  createSession,
  deleteReaderSessions,
  deleteSession,
  getSession,
  interviewSpendKey,
  INTERVIEW_SWITCH_KEY,
  listSessions,
  lockReaderStart,
  lockSession,
  monthKey,
  drillMonthKey,
  coachMonthKey,
  refundCoachMonth,
  newSessionId,
  refundDrillMonth,
  refundMonth,
  refundVoiceMonth,
  refundVoiceTopup,
  takeVoiceTopup,
  updateSession,
  voiceMinutesKey,
  voiceMonthKey,
  type VoiceState,
  signalKey,
  ledgerKey,
  evalLockKey,
  type Feedback,
  type Session,
  type Turn,
  type TurnMeta,
  addSpend,
} from './sessions';

// The mock interview (P3-11, docs/README.md): a text-only prototype of the interview
// service, behind PUBLIC_INTERVIEW_ENABLED. A reader starts a session on a system's plan, answers
// the interviewer stage by stage, moves on when ready, and ends with written feedback.
//
// Cost controls (docs/cost-model.md), in the order a call meets them:
//   - sign-in, and consent to the session's terms (CONSENT_VERSION), before anything starts;
//   - INTERVIEW_MONTHLY_SESSIONS per reader per calendar month, counted when a session starts;
//   - per session: INTERVIEW_MAX_TURNS candidate messages, INTERVIEW_SESSION_BUDGET_USD of
//     estimated spend, and the planned length plus INTERVIEW_OVERTIME_MINUTES, after which only
//     the feedback can run, at most MAX_FEEDBACK_ATTEMPTS times. The spend counts every call that
//     may have been billed, saved or not: a reply the candidate stops, or that times out or drops,
//     is charged to the session at the gateway's estimate (Lane.onSpend), so stopping replies
//     can't run up more than the session's budget;
//   - one paid call at a time per session (a lock across instances), and one session start at a
//     time per reader, so a reader has at most one running session;
//   - the interview's own switch (store flag, else INTERVIEW_ENABLED) and daily budget
//     (INTERVIEW_DAILY_BUDGET_USD), then the gateway's kill switch, global daily budget and
//     concurrency limit, which cover Ask and the interview together.
// Openers and stage changes are written in the plan, so starting and moving on cost nothing; the
// interviewer's replies use the cheaper INTERVIEW_MODEL, and only the feedback uses the premium one.

export type InterviewErrorCode =
  | 'not_found'
  // Early access: the reader is not on the allowlist (access.ts).
  | 'access'
  | 'disabled'
  | 'budget'
  | 'unavailable'
  | 'quota'
  | 'consent'
  | 'active'
  | 'finished'
  | 'time_up'
  | 'done'
  | 'turns'
  | 'session_budget'
  // Not enough credits to start (lego-ledger), or they ran out during the session.
  | 'credits'
  | 'busy'
  | 'last_stage'
  | 'invalid'
  | 'board_conflict'
  // The voice room (design section 6): a Pro plan is needed; the voice pipeline is speaking for
  // the session (the text controls wait); a pipeline with an old lease; the voice service is full
  // or unreachable; the voice room is over (only the text controls and the feedback remain).
  | 'plan'
  | 'voice_live'
  | 'stale_epoch'
  | 'capacity'
  | 'voice_ended';

/** Why the interview couldn't do something; `status` and `retryAfter` go to the HTTP response. */
export class InterviewError extends Error {
  constructor(
    readonly code: InterviewErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const fail = (code: InterviewErrorCode, status: number, message: string, retryAfter?: number, detail?: Record<string, unknown>) =>
  new InterviewError(code, status, message, retryAfter, detail);

/** An AskError from the gateway, in the interview's words (the codes and statuses carry over). */
export function fromGateway(err: AskError): InterviewError {
  const words: Partial<Record<AskError['code'], string>> = {
    disabled: 'The interviewer is paused right now. Your session is saved; try again later.',
    budget: 'The interviewer has reached its limit for today. Your session is saved; come back tomorrow.',
    busy: 'The interviewer is busy right now. Send your message again in a moment.',
    timeout: 'That took too long. Send your message again.',
    unavailable: 'The interviewer is unavailable right now. Your session is saved; try again later.',
    upstream: 'The interviewer couldn’t answer just now. Send your message again.',
    aborted: 'Cancelled.',
  };
  const code: InterviewErrorCode = err.code === 'disabled' || err.code === 'budget' || err.code === 'unavailable' ? err.code : 'busy';
  return new InterviewError(code, err.status, words[err.code] ?? err.message, err.retryAfter);
}

// ---------------------------------------------------------------------------------------
// Switch, budget and status

const SWITCH_CACHE_MS = 5_000;
let switchCache: { at: number; on: boolean } | null = null;

/** The interview's own switch: the store flag when set, otherwise INTERVIEW_ENABLED. Cached 5 s. */
export async function interviewEnabled(): Promise<boolean> {
  if (switchCache && Date.now() - switchCache.at < SWITCH_CACHE_MS) return switchCache.on;
  const flag = await (await getStore()).get(INTERVIEW_SWITCH_KEY);
  const on = flag === 'on' ? true : flag === 'off' ? false : interviewConfig().enabledByEnv;
  switchCache = { at: Date.now(), on };
  return on;
}

/** Forgets the cached switch (tests only). */
export const resetInterviewSwitchCache = () => {
  switchCache = null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const nextUtcMidnight = (now = Date.now()) => new Date(Math.floor(now / DAY_MS + 1) * DAY_MS).toISOString();
export const nextMonth = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
export const secondsUntil = (iso: string) => Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 1000));

/** Throws unless a paid interview call may go out: its switch, its daily budget, then the gateway's. */
export async function checkInterviewCalls(cfg: InterviewConfig) {
  let on: boolean;
  let spent: number;
  try {
    on = await interviewEnabled();
    spent = Number(await (await getStore()).get(interviewSpendKey())) || 0;
  } catch (err) {
    console.error('[interview] store unavailable:', (err as Error).message);
    throw fail('unavailable', 503, 'The interviewer is unavailable right now. Try again later.', 60);
  }
  if (!on) throw fail('disabled', 503, 'Mock interviews are paused right now. Try again later.', 300);
  if (spent >= cfg.dailyBudgetUsd * 1e6) {
    throw fail('budget', 503, 'Mock interviews have reached their limit for today. Come back tomorrow.', secondsUntil(nextUtcMidnight()));
  }
  try {
    await checkGateway();
  } catch (err) {
    if (err instanceof AskError) throw fromGateway(err);
    throw err;
  }
}

/**
 * Feedback calls that may have been billed before finishing gives up and ends the session
 * without feedback (the grader timing out or being stopped each time). Each is charged too.
 */
export const MAX_FEEDBACK_ATTEMPTS = 3;

/** Adds a call's cost to its session, whatever became of the call (and counts a feedback attempt). */
type CallKind = 'reply' | 'feedback' | 'evaluator' | 'board' | 'vision' | 'speech';

export async function chargeSession(id: string, cfg: InterviewConfig, kind: CallKind, usd: number) {
  await updateSession(id, cfg.retentionDays, (s) => ({
    ...s,
    costUsd: s.costUsd + usd,
    spend: addSpend(s.spend, { [`claude ${kind}`]: usd }),
    ...(kind === 'feedback' ? { feedbackAttempts: (s.feedbackAttempts ?? 0) + 1 } : {}),
  }));
}

/** The lane a session's calls take through the gateway (llm-gateway.ts). */
// ---------------------------------------------------------------------------------------
// Credits (lego-ledger, lib/server/credits.ts): a session opens a meter when it starts and is charged by
// the minute for its time as it runs: after each action on it (withLock) and each voice heartbeat, at most
// every METER_EVERY_MS, and once more, closing it, when it ends.

const METER_EVERY_MS = 15_000;
/** The session learns when the credits run out once they would within this long: its countdown and its close. */
const CREDITS_NEAR_S = 15 * 60;
const meteredAt = new Map<string, number>();

/** The session's last sign of use: its last turn, either side's, or the voice pipeline's last heartbeat. */
const lastActive = (s: Session): number => Math.max(Date.parse(s.startedAt), ...s.turns.map((t) => Date.parse(t.at) || 0), s.voice?.lease ? Date.parse(s.voice.lease.at) || 0 : 0);

/**
 * The session's time used, in seconds: from its start to its last sign of use (a session left open, or
 * left for a while before it is ended, is not charged for the wait), less the time the voice line was
 * parked, and never past the session's end.
 */
export function usedSeconds(s: Session, plan: Plan, cfg: InterviewConfig, now = Date.now()): number {
  const end = Math.min(now, lastActive(s), Date.parse(endsAt(s, plan, cfg)));
  return Math.max(0, (end - Date.parse(s.startedAt) - (s.voice?.pausedMs ?? 0)) / 1000);
}

/**
 * Charges the session's meter for its time so far (with `close`, closes it: the minimum applies unless
 * `waive`), and notes on the session when its credits run out once that is near. A ledger that fails is
 * logged, never the session's failure: the next charge carries the time.
 */
export async function meterSession(s: Session, plan: Plan, cfg: InterviewConfig, opts: { close?: boolean; waive?: boolean; now?: number } = {}): Promise<void> {
  if (!s.metered || !ledgerOn()) return;
  const now = opts.now ?? Date.now();
  if (opts.close) meteredAt.delete(s.id);
  else {
    if (meteredAt.size > 10_000) meteredAt.clear();
    meteredAt.set(s.id, now);
  }
  try {
    const r = await chargeMeter(s.id, { seconds: usedSeconds(s, plan, cfg, now), close: opts.close, waive: opts.waive });
    if (opts.close || s.status !== 'active') return;
    const endAt = r.secondsLeft <= CREDITS_NEAR_S ? new Date(now + r.secondsLeft * 1000).toISOString() : undefined;
    const same = endAt && s.creditsEndAt ? Math.abs(Date.parse(endAt) - Date.parse(s.creditsEndAt)) < 5_000 : endAt === s.creditsEndAt;
    if (!same) await updateSession(s.id, cfg.retentionDays, (x) => ({ ...x, creditsEndAt: endAt }));
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', event: 'credits_charge_failed', session: s.id, close: !!opts.close, err: (err as Error).message }));
  }
}

/** The session's meter charged now if it is due (the voice heartbeat, which runs outside withLock). */
export async function meterIfDue(s: Session, plan: Plan, cfg: InterviewConfig): Promise<void> {
  if (s.metered && Date.now() - (meteredAt.get(s.id) ?? 0) >= METER_EVERY_MS) await meterSession(s, plan, cfg);
}

/** After an action on the session: its meter charged in the background, at most every METER_EVERY_MS. */
function meterLater(id: string) {
  if (!ledgerOn() || Date.now() - (meteredAt.get(id) ?? 0) < METER_EVERY_MS) return;
  meteredAt.set(id, Date.now());
  void (async () => {
    const s = await getSession(id);
    const plan = s ? sessionPlan(s) : null;
    if (s?.metered && s.status === 'active' && plan) await meterSession(s, plan, interviewConfig());
  })().catch(() => {});
}

function lane(cfg: InterviewConfig, kind: CallKind, plan: Plan, sessionId: string, voice = false, coach = false): Lane {
  const reserve = async (): Promise<Reservation> => {
    // The gateway has just checked its own switch and budget; these are the interview's. The
    // session's allowances were checked before the call, under its lock, and its cost is charged
    // by onSpend. The gateway passes AskErrors through (anything else would be reported as an
    // upstream failure).
    try {
      await checkInterviewCalls(cfg);
    } catch (err) {
      if (err instanceof InterviewError && (err.code === 'disabled' || err.code === 'budget' || err.code === 'unavailable')) {
        throw new AskError(err.code, err.status, err.message, err.retryAfter);
      }
      throw err;
    }
    return { refund: async () => {} };
  };
  // Every call that may have been billed is charged to the session as the gateway records it,
  // before the call returns or throws (and so before the session's lock is released).
  const onSpend = (usd: number) => chargeSession(sessionId, cfg, kind, usd);
  // A spoken reply waits on the model's first token, so the voice turns may run on a faster model.
  if (kind === 'reply') return { name: coach ? 'interview-coach' : 'interview', model: coach ? cfg.coach.model : voice ? cfg.voiceModel : cfg.model, maxTokens: coach ? cfg.coach.maxTokens : cfg.maxTokens, effort: cfg.effort, reserve, spendKey: interviewSpendKey(), onSpend };
  if (kind === 'evaluator') {
    return { name: 'interview-evaluator', model: cfg.evaluatorModel, maxTokens: cfg.evaluatorMaxTokens, effort: 'low', timeoutMs: 30_000, format: evaluatorSchema(), reserve, spendKey: interviewSpendKey(), onSpend };
  }
  // The board's fallbacks (design section 7) run inside the reply, so they are short and cheap.
  if (kind === 'board') return { name: 'interview-board', model: cfg.evaluatorModel, maxTokens: 1500, effort: 'low', timeoutMs: 15_000, format: boardMatchSchema(), reserve, spendKey: interviewSpendKey(), onSpend };
  if (kind === 'vision') return { name: 'interview-board-vision', model: cfg.evaluatorModel, maxTokens: 1500, effort: 'low', timeoutMs: 20_000, reserve, spendKey: interviewSpendKey(), onSpend };
  return {
        name: 'interview-feedback',
        model: cfg.feedbackModel,
        maxTokens: cfg.feedbackMaxTokens,
        effort: cfg.feedbackEffort,
        timeoutMs: cfg.feedbackTimeoutMs,
        format: feedbackSchema(plan),
        reserve,
        spendKey: interviewSpendKey(),
        onSpend,
      };
}

// ---------------------------------------------------------------------------------------
// The evaluator (design section 8): after each reply, one small call tags the candidate's turn
// against the stage's items; the ledger and the live signal live beside the session and die with
// it. It runs after the reply has been sent, outside the session lock; nothing waits on it, and a
// failed or skipped evaluation leaves the turn untagged (the director falls back to the clock).

const inflight = new Set<Promise<void>>();

/** Waits for every evaluation in flight (tests, shutdown). */
export const settleEvaluations = () => Promise.all([...inflight]).then(() => undefined);

const LEDGER_TTL_DAYS = (cfg: InterviewConfig) => cfg.retentionDays * 24 * 60 * 60 * 1000;

/** Reads the session's ledger (empty when none). */
export async function readLedger(id: string): Promise<Ledger> {
  try {
    const raw = await (await getStore()).get(ledgerKey(id));
    return raw ? (JSON.parse(raw) as Ledger) : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function scheduleEvaluation(readerId: string, id: string, plan: Plan, cfg: InterviewConfig, turnIndex: number, seq: number) {
  if (!cfg.evaluator) return;
  const run = evaluateTurn(readerId, id, plan, cfg, turnIndex, seq)
    .catch((err) => console.error('[interview] evaluator:', err instanceof Error ? err.message : String(err)))
    .finally(() => inflight.delete(run));
  inflight.add(run);
}

/**
 * Tags one candidate turn. Idempotent per turn (a lock, then the ledger entry); the ledger is
 * written with compare-and-set, the signal only when it is newer than what is there.
 */
async function evaluateTurn(readerId: string, id: string, plan: Plan, cfg: InterviewConfig, turnIndex: number, seq: number): Promise<void> {
  const ttl = LEDGER_TTL_DAYS(cfg);
  if (!(await claimEvaluation(id, seq, ttl))) return;
  const session = await getSession(id);
  if (!session || session.readerId !== readerId) return;
  const turn = session.turns[turnIndex];
  if (!turn || turn.role !== 'candidate') return;
  const ledger = await readLedger(id);
  if (ledger.entries[seq]) return;
  const skip = async (why: string) => {
    await writeLedger(id, ttl, { turn: turnIndex, seq, stage: turn.stage, section: turn.meta?.section ?? '', utterance: 'empty', tags: [], dropped: [], at: new Date().toISOString(), skipped: why });
    await updateSession(id, cfg.retentionDays, (s) => {
      const t = s.turns[turnIndex];
      if (!t || t.role !== 'candidate') return s;
      const turns = s.turns.slice();
      turns[turnIndex] = { ...t, meta: { ...t.meta, evalSkipped: true } };
      return { ...s, turns };
    }).catch(() => null);
  };
  let result;
  try {
    result = await createMessage(evaluatorRequest(plan, session, turnIndex), {
      readerId,
      topic: `${session.system}/interview`,
      lane: lane(cfg, 'evaluator', plan, id),
      log: { session: id, stage: turn.stage, evaluator: seq },
    });
  } catch (err) {
    return skip(err instanceof AskError ? err.code : 'error');
  }
  const out = parseEvaluation(result.message);
  if (!out) return skip('unparsed');
  const entry = toEntry(plan, session, turnIndex, seq, out, result.model);
  const saved = await writeLedger(id, ttl, entry);
  const signal = aggregate(saved, plan.plan, session.director?.skipped ?? []);
  await writeSignal(id, ttl, signal);
}

/** Claims a turn for evaluation, once: the session's claim list (one key, deleted with it). */
async function claimEvaluation(id: string, seq: number, ttl: number): Promise<boolean> {
  const store = await getStore();
  for (let i = 0; i < 5; i++) {
    const raw = await store.get(evalLockKey(id));
    const claimed = raw ? raw.split(',') : [];
    if (claimed.includes(String(seq))) return false;
    const next = [...claimed, String(seq)].join(',');
    const ok = raw ? await store.cas(evalLockKey(id), raw, next, ttl) : await store.setNx(evalLockKey(id), next, ttl);
    if (ok) return true;
  }
  return false;
}

/** Adds an entry to the ledger (compare-and-set; a few retries), returning the ledger as saved. */
async function writeLedger(id: string, ttl: number, entry: Ledger['entries'][string]): Promise<Ledger> {
  const store = await getStore();
  for (let i = 0; i < 5; i++) {
    const raw = await store.get(ledgerKey(id));
    const current: Ledger = raw ? JSON.parse(raw) : { entries: {} };
    const next: Ledger = { entries: { ...current.entries, [entry.seq]: entry } };
    const ok = raw ? await store.cas(ledgerKey(id), raw, JSON.stringify(next), ttl) : await store.setNx(ledgerKey(id), JSON.stringify(next), ttl);
    if (ok) return next;
  }
  throw new Error('ledger write contended');
}

/** Writes the live signal unless a newer one is there (basedOnTurn is monotonic). */
async function writeSignal(id: string, ttl: number, signal: LiveSignal): Promise<void> {
  const store = await getStore();
  for (let i = 0; i < 5; i++) {
    const raw = await store.get(signalKey(id));
    if (raw && (JSON.parse(raw) as LiveSignal).basedOnTurn >= signal.basedOnTurn) return;
    const ok = raw ? await store.cas(signalKey(id), raw, JSON.stringify(signal), ttl) : await store.setNx(signalKey(id), JSON.stringify(signal), ttl);
    if (ok) return;
  }
}

// ---------------------------------------------------------------------------------------
// What the room is given

export type SessionView = {
  id: string;
  system: string;
  /** The drill the session runs (a topic's, or one section's), or null for the system's whole interview. */
  scope: { topic: string; section: string | null } | null;
  status: Session['status'];
  startedAt: string;
  /** The planned length, and when the session stops taking messages (planned plus overtime). */
  plannedMinutes: number;
  endsAt: string;
  stageIndex: number;
  stageStartedAt: string;
  turns: { role: Turn['role']; stage: string; text: string; at: string; draw?: DrawOp[] }[];
  turnsLeft: number;
  /** Text (the default) or voice. */
  mode: 'text' | 'voice';
  /** A mock interview (the default) or a coach lesson (docs/coach-mode.md). */
  kind: 'interview' | 'coach';
  /** A coach lesson's progress: every part's sections and items with their status (null on an interview). */
  lesson: LessonView | null;
  /** The playlist's lesson the session teaches (docs/coaching.md), or null. */
  course: { playlist: string; playlistTitle: string; lesson: string; title: string; next: { slug: string; title: string } | null } | null;
  /** The voice room's state (voice sessions only). */
  voice: VoiceView | null;
  /** Time the stage's clock was paused (a voice session parked), to take off the stage timer. */
  stagePausedMs: number;
  /** No more messages: time, turns, credits or the session budget ran out, or the interviewer wrapped up (done); only the feedback can run. */
  closed: 'time' | 'turns' | 'budget' | 'credits' | 'done' | null;
  /** When the reader's credits run out at this session's rate, once that is near (null: not near, or not metered). */
  creditsEndAt: string | null;
  feedback: Feedback | null;
  feedbackNote: string | null;
  /**
   * The plan changed since the session started. Only the current plan is kept, so the rest of the
   * session (its stages, the interviewer's brief and the feedback's rubric) follows the new
   * version; a session past the new plan's last stage stays on that stage.
   */
  planChanged: boolean;
};

/** When the session stops taking messages: the planned length plus overtime, plus the time a voice session spent parked. */
export const endsAt = (s: Pick<Session, 'startedAt' | 'voice'>, plan: Plan, cfg: InterviewConfig) =>
  new Date(Date.parse(s.startedAt) + (interviewMinutes(plan.plan) + cfg.overtimeMinutes) * 60_000 + (s.voice?.pausedMs ?? 0)).toISOString();

/** A session's message and spend caps: a voice session's are its own (exchanges, and a budget that includes speech). */
export const limitsOf = (s: Pick<Session, 'mode' | 'kind'>, cfg: InterviewConfig) =>
  s.mode === 'voice'
    ? { maxTurns: cfg.voice.maxExchanges, sessionBudgetUsd: cfg.voice.sessionBudgetUsd }
    : s.kind === 'coach'
      ? { maxTurns: cfg.maxTurns, sessionBudgetUsd: cfg.coach.sessionBudgetUsd }
      : { maxTurns: cfg.maxTurns, sessionBudgetUsd: cfg.sessionBudgetUsd };

/** How long a voice pipeline's lease stands without a heartbeat before the text controls work again. */
export const VOICE_LEASE_MS = 60_000;

/** A voice pipeline holds the session: its lease is fresh and the voice room is not over. */
export function voiceLive(s: Session, now = Date.now()): boolean {
  const v = s.voice;
  return !!v && !v.ended && !!v.lease && now - Date.parse(v.lease.at) < VOICE_LEASE_MS;
}

/**
 * A voice part no pipeline has taken yet (started, never attached, not parked): the voice speaks
 * first, so the text controls wait for it too, or a lesson's first move would be drawn in silence.
 */
export function voiceAwaited(s: Session): boolean {
  const v = s.voice;
  return !!v && !v.ended && !v.lease && !v.parked;
}

export function closedReason(s: Session, plan: Plan, cfg: InterviewConfig): SessionView['closed'] {
  const limits = limitsOf(s, cfg);
  if (s.closedBy === 'director') return 'done';
  if (Date.now() >= Date.parse(endsAt(s, plan, cfg))) return 'time';
  if (s.candidateTurns >= limits.maxTurns) return 'turns';
  if (s.costUsd >= limits.sessionBudgetUsd) return 'budget';
  if (s.creditsEndAt && Date.now() >= Date.parse(s.creditsEndAt)) return 'credits';
  return null;
}

/** The voice room as the room sees it (never the lease's task, epoch or the Daily room). */
export type VoiceView = {
  /** A pipeline is speaking for the session: the text controls wait. */
  live: boolean;
  /** The line dropped; the clock is paused until the room rejoins (or the park runs out). */
  parked: boolean;
  /** The voice part is over: the text controls and the feedback remain. */
  ended: boolean;
  degraded: string[];
  exchangesLeft: number;
  audioOptIn: boolean;
  /** Time the clock stood still while the line was down (credited: the session's end moves by it). */
  pausedMs: number;
};

/** A turn as the room sees it: its words, and the interviewer's drawing when it made one; never the private meta. */
const viewTurn = ({ role, stage, text, at, meta }: Turn): SessionView['turns'][number] => ({ role, stage, text, at, ...(meta?.draw ? { draw: meta.draw } : {}) });

export function toView(s: Session, plan: Plan, cfg = interviewConfig()): SessionView {
  return {
    id: s.id,
    system: s.system,
    scope: s.scope ?? null,
    status: s.status,
    startedAt: s.startedAt,
    plannedMinutes: interviewMinutes(plan.plan),
    endsAt: endsAt(s, plan, cfg),
    stageIndex: s.stageIndex,
    stageStartedAt: s.stageStartedAt,
    turns: s.turns.map(viewTurn),
    turnsLeft: Math.max(0, limitsOf(s, cfg).maxTurns - s.candidateTurns),
    mode: s.mode ?? 'text',
    kind: s.kind ?? 'interview',
    lesson: s.kind === 'coach' ? lessonView(plan.plan, s.coach, s.stageIndex, !s.coachQuiet) : null,
    course: plan.lesson ? { playlist: plan.lesson.playlist.slug, playlistTitle: plan.lesson.playlist.title, lesson: plan.lesson.slug, title: plan.lesson.title, next: nextOf(plan) } : null,
    voice: s.voice
      ? {
          live: voiceLive(s),
          parked: !!s.voice.parked && !s.voice.ended,
          ended: s.voice.ended,
          degraded: s.voice.degraded,
          exchangesLeft: Math.max(0, cfg.voice.maxExchanges - s.candidateTurns),
          audioOptIn: s.voice.audioOptIn,
          pausedMs: s.voice.pausedMs,
        }
      : null,
    stagePausedMs: s.voice?.stagePausedMs ?? 0,
    closed: s.status === 'active' ? closedReason(s, plan, cfg) : null,
    creditsEndAt: s.creditsEndAt ?? null,
    feedback: s.feedback,
    feedbackNote: s.feedbackNote ?? null,
    planChanged: s.planVersion !== plan.version,
  };
}

export type InterviewStatus = {
  enabled: boolean;
  /** Off for everyone (disabled, budget, unavailable) or for this reader (access: early access, not on the allowlist). */
  reason?: 'disabled' | 'budget' | 'unavailable' | 'access';
  /** Sessions a reader may start per month, and how many are left this month. */
  limit: number;
  remaining: number;
  /** Drills (topic and section sessions) a reader may start per month, and how many are left. */
  drillLimit: number;
  drillsRemaining: number;
  /** Coach lessons (docs/coach-mode.md) a reader may start per month, and how many are left. */
  coachLimit: number;
  coachRemaining: number;
  resetsAt: string;
  consentVersion: string;
  /** Days transcripts are kept (the consent step says so). */
  retentionDays: number;
};

/** The interview's state for a reader (or anyone, with null), counting nothing. */
export async function interviewStatus(readerId: string | null): Promise<InterviewStatus> {
  const cfg = interviewConfig();
  const base = { limit: cfg.monthlySessions, drillLimit: cfg.monthlyDrills, coachLimit: cfg.coach.monthlySessions, resetsAt: nextMonth(), consentVersion: CONSENT_VERSION, retentionDays: cfg.retentionDays };
  try {
    const store = readerId ? await getStore() : null;
    const used = store && readerId ? Number(await store.get(monthKey(readerId))) || 0 : 0;
    const drillsUsed = store && readerId ? Number(await store.get(drillMonthKey(readerId))) || 0 : 0;
    const coachUsed = store && readerId ? Number(await store.get(coachMonthKey(readerId))) || 0 : 0;
    const remaining = Math.max(0, cfg.monthlySessions - used);
    const drillsRemaining = Math.max(0, cfg.monthlyDrills - drillsUsed);
    const coachRemaining = Math.max(0, cfg.coach.monthlySessions - coachUsed);
    try {
      await checkInterviewCalls(cfg);
    } catch (err) {
      if (err instanceof InterviewError && (err.code === 'disabled' || err.code === 'budget' || err.code === 'unavailable')) {
        return { ...base, enabled: false, reason: err.code, remaining, drillsRemaining, coachRemaining };
      }
      throw err;
    }
    return { ...base, enabled: true, remaining, drillsRemaining, coachRemaining };
  } catch (err) {
    console.error('[interview] status unavailable:', (err as Error).message);
    return { ...base, enabled: false, reason: 'unavailable', remaining: 0, drillsRemaining: 0, coachRemaining: 0 };
  }
}

function planFor(system: string, scope: PlanScope = null, lesson?: string | null): Plan {
  const plan = getPlan(system, scope, lesson);
  if (!plan) throw fail('not_found', 404, lesson ? 'There is no such lesson.' : scope ? 'There is no drill on that topic or section.' : 'There is no mock interview for this system.');
  return plan;
}

/**
 * The brief a lesson opens with when its board goes on from earlier lessons: the board is there at once (drawn
 * before), so the coach first says what it shows and where this lesson picks up, then draws.
 */
export function openingBrief(plan: Plan, then = 'then teach the item, drawing as you go.'): string {
  const info = plan.lesson;
  const parts = (info?.start ?? []).flatMap((id) => {
    const e = info!.layout.get(id);
    return e?.type === 'element' && e.kind === 'region' && !e.in ? [e.label] : [];
  });
  if (!parts.length) return '';
  return (
    ` The board already shows what earlier lessons drew: ${parts.map((l) => `"${l}"`).join(', ')}. Open with a short brief ` +
    `instead of the one sentence: two or three sentences saying what we are designing, what those parts on the board ` +
    `show, and what this lesson adds. Draw nothing during the brief; ${then}`
  );
}

/** The lesson after a playlist lesson's, for the room's "next lesson". */
function nextOf(plan: Plan): { slug: string; title: string } | null {
  const n = plan.lesson ? nextLesson(plan.lesson.playlist.slug, plan.lesson.slug) : null;
  return n ? { slug: n.slug, title: n.title } : null;
}

/**
 * How the coach draws on a session: the wider vocabulary, and on a playlist's lesson its board plan;
 * the lesson's first move also draws the board it opens with (what it keeps from earlier lessons),
 * before the coach's own drawing, as <place> elements of at most PLACE_MAX_IDS ids each.
 */
/** A doubt's answer may draw: what it adds to the move's instruction. */
const ASIDE_ANSWER =
  ' If a small sketch or a few written lines would make the answer clearer, draw them as you speak: your own boxes, arrows and notes (a heading note naming the question first), up to eight operations. They go in the side notes, to the right of the lesson, never among its parts; to point at a part already on the board, highlight it. Place no lesson ids. Without a need for it, draw nothing.';

function coachDrawOptions(plan: Plan, opening: boolean): DrawOptions {
  const info = plan.lesson;
  if (!info) return { maxOps: COACH_DRAW_MAX_OPS, edit: true };
  const start = opening ? info.start : [];
  const chunks: string[][] = [];
  for (let i = 0; i < start.length; i += PLACE_MAX_IDS) chunks.push(start.slice(i, i + PLACE_MAX_IDS));
  return { maxOps: COACH_DRAW_MAX_OPS + chunks.length, edit: true, layout: info.layout, ...(chunks.length ? { prelude: chunks.map((c) => `<place ids="${c.join(',')}"/>`).join('') } : {}) };
}

/** A session's plan: a playlist's lesson carries what earlier lessons left with the learner, recorded when it started. */
export function sessionPlan(s: Session): Plan | null {
  const plan = getPlan(s.system, s.scope ?? null, s.course?.lesson);
  return plan?.lesson && s.course ? { ...plan, lesson: { ...plan.lesson, recall: s.course.recall } } : plan;
}

/** The same lesson, or both not a lesson. */
const sameLesson = (s: Pick<Session, 'course'>, lesson: string | null | undefined) => (s.course?.lesson ?? null) === (lesson ?? null);

/** A session of this reader's, with its plan, or not_found (someone else's looks the same as none). */
export async function mine(readerId: string, id: string): Promise<{ session: Session; plan: Plan }> {
  const session = await getSession(id);
  if (!session || session.readerId !== readerId) throw fail('not_found', 404, 'That interview session doesn’t exist, or it has expired.');
  const plan = sessionPlan(session);
  if (!plan) throw fail('not_found', 404, session.course ? 'There is no such lesson.' : session.scope ? 'There is no drill on that topic or section.' : 'There is no mock interview for this system.');
  return { session, plan };
}

/** The reader's session that still takes messages, if any. */
async function activeSession(readerId: string, cfg: InterviewConfig): Promise<{ session: Session; plan: Plan } | null> {
  for (const s of (await listSessions(readerId)).reverse()) {
    if (s.status !== 'active') continue;
    const plan = sessionPlan(s);
    if (plan && Date.now() < Date.parse(endsAt(s, plan, cfg))) return { session: s, plan };
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Actions

/** The status plus the reader's current session on this system and scope (to resume) and past ones. */
export async function overview(readerId: string, system: string, scope: PlanScope = null, kind: SessionKind = 'interview', lesson?: string | null) {
  const plan = planFor(system, scope, lesson);
  const cfg = interviewConfig();
  const sessions = (await listSessions(readerId)).filter((s) => s.system === system && sameScope(s.scope, scope) && sameLesson(s, lesson) && (s.kind ?? 'interview') === kind);
  const views = sessions.map((s) => toView(s, plan, cfg));
  const current = [...views].reverse().find((v) => v.status === 'active' && v.closed !== 'time') ?? null;
  return {
    status: await interviewStatus(readerId),
    current,
    past: views.filter((v) => v !== current).map((v) => ({ id: v.id, startedAt: v.startedAt, status: v.status, rated: !!v.feedback })),
  };
}

/**
 * Starts a session on the system's plan, or returns the reader's session there that is still
 * running. Starting costs nothing: the problem statement and the first stage's opener are written
 * in the plan. Counts one of the reader's monthly sessions.
 */
export type StartOptions = {
  /** A voice session (design section 6): its own consent version, quota (sessions and minutes) and caps. */
  mode?: 'text' | 'voice';
  /** The candidate keeps the raw audio seven days for QA (voice only). */
  audioOptIn?: boolean;
  /** A drill: the topic's, or one section's, plan instead of the system's whole interview. */
  scope?: PlanScope;
  /** A coach lesson (docs/coach-mode.md) on the plan instead of a mock interview: its own quota; text only. */
  kind?: SessionKind;
  /** A playlist's lesson (docs/coaching.md): `system` is the playlist; a coach session only. */
  lesson?: string | null;
  /** What the coach calls the learner (`learnerName`); a coach session only. */
  name?: string | null;
  /** False: the lesson starts with the coach's questions off (the learner's last choice, `coachQuiet`); a coach session only. */
  questions?: boolean;
  /** The reader's plan (entitlements.ts), for the month's credits (lego-ledger). */
  plan?: string;
};

/**
 * The name a learner gave the coach, or null: a first name or two, letters only (with spaces, hyphens and
 * apostrophes), at most 30 characters. It goes into the coach's prompt, so anything else is dropped, not cleaned.
 */
export function learnerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  return name.length > 0 && name.length <= 30 && /^\p{L}[\p{L}\p{M}' -]*$/u.test(name) ? name : null;
}

export type SessionKind = NonNullable<Session['kind']>;

export async function startSession(readerId: string, system: string, consentVersion: unknown, opts: StartOptions = {}): Promise<{ session: SessionView; resumed: boolean }> {
  if (opts.lesson && opts.kind !== 'coach') throw fail('invalid', 400, 'A lesson is taught by the coach.');
  const plan = planFor(system, opts.scope ?? null, opts.lesson);
  const cfg = interviewConfig();
  const voice = opts.mode === 'voice';

  const expected = voice ? VOICE_CONSENT_VERSION : CONSENT_VERSION;
  if (consentVersion !== expected) throw fail('consent', 400, 'Agree to how the session works before you start.', undefined, { consentVersion: expected });
  // One start at a time per reader: a second start waits for the first, then resumes its session.
  const release = await waitFor(() => lockReaderStart(readerId, START_LOCK_MS), START_WAIT_MS);
  if (!release) throw fail('busy', 409, 'Your interview is still starting. Try again in a moment.', 2);
  try {
    return await startLocked(readerId, system, plan, cfg, expected, opts);
  } finally {
    await release().catch(() => {});
  }
}

/** A voice session's state as it starts: no room, no lease, nothing used. */
export const initialVoice = (audioOptIn: boolean): VoiceState => ({
  room: null,
  lease: null,
  epochs: 0,
  usage: { sttSeconds: 0, ttsChars: 0, exchanges: 0 },
  parked: null,
  pausedMs: 0,
  stagePausedMs: 0,
  ended: false,
  audioOptIn,
  degraded: [],
  usedTokens: [],
});

/** How long a start holds the reader's start lock at most, and how long another start waits for it. */
const START_LOCK_MS = 15_000;
const START_WAIT_MS = 5_000;

/** Tries to take a lock until it is free or `waitMs` has passed. */
async function waitFor(take: () => Promise<(() => Promise<void>) | null>, waitMs: number) {
  const until = Date.now() + waitMs;
  for (;;) {
    const release = await take();
    if (release || Date.now() >= until) return release;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function startLocked(
  readerId: string,
  system: string,
  plan: Plan,
  cfg: InterviewConfig,
  consentVersion: string,
  opts: StartOptions,
): Promise<{ session: SessionView; resumed: boolean }> {
  const voice = opts.mode === 'voice';
  const coach = opts.kind === 'coach';
  const scope = plan.scope;
  const active = await activeSession(readerId, cfg);
  if (active?.session.system === system && sameScope(active.session.scope, scope) && sameLesson(active.session, plan.lesson?.slug) && (active.session.kind ?? 'interview') === (opts.kind ?? 'interview')) {
    // A lesson resumed under another name: the coach calls the learner what they gave this time.
    const name = coach ? learnerName(opts.name) : null;
    if (name && name !== active.session.learnerName) await updateSession(active.session.id, cfg.retentionDays, (s) => ({ ...s, learnerName: name })).catch(() => null);
    return { session: toView(active.session, active.plan, cfg), resumed: true };
  }
  if (active) {
    const what = active.session.kind === 'coach' ? 'a lesson' : 'an interview';
    throw fail('active', 409, active.session.system === system ? `You have ${what} in progress on this system. Finish it first.` : `You have ${what} in progress on another system. Finish it first.`, undefined, { system: active.session.system, scope: active.session.scope ?? null, id: active.session.id, kind: active.session.kind ?? 'interview' });
  }
  await checkInterviewCalls(cfg);

  // A drill counts against the drill quota (text or voice; a voice drill against the voice minutes too);
  // a whole voice session against the voice quota (sessions and minutes), a whole text one against the text quota.
  const store = await getStore();
  const id = newSessionId();
  // With the ledger, the session spends credits as it runs: it starts once the reader holds the minimum.
  if (ledgerOn()) return startMetered(readerId, system, plan, cfg, consentVersion, opts, id);
  // A coach lesson, whole or on a drill's plan, counts against the coach quota.
  const key = coach ? coachMonthKey(readerId) : scope ? drillMonthKey(readerId) : voice ? voiceMonthKey(readerId) : monthKey(readerId);
  const limit = coach ? cfg.coach.monthlySessions : scope ? cfg.monthlyDrills : voice ? cfg.voice.monthlySessions : cfg.monthlySessions;
  const refund = () => (coach ? refundCoachMonth(readerId) : scope ? refundDrillMonth(readerId) : voice ? refundVoiceMonth(readerId) : refundMonth(readerId)).catch(() => {});
  const used = await store.incr(key, 40 * DAY_MS);
  // A whole voice session past the month's quota may run on a purchased top-up (design section 9),
  // which reserves no monthly minutes: the session's own caps bound it.
  let topup = false;
  if (used > limit) {
    await refund();
    topup = voice && !scope && (await takeVoiceTopup(readerId).catch(() => false));
    if (!topup) {
      const resetsAt = nextMonth();
      throw fail('quota', 429, coach ? `You’ve used this month’s ${limit} coach lessons.` : scope ? `You’ve used this month’s ${limit} drills.` : `You’ve used this month’s ${limit} ${voice ? 'voice ' : ''}mock interviews.`, secondsUntil(resetsAt), { resetsAt });
    }
  }
  const giveBack = () => (topup ? refundVoiceTopup(readerId).catch(() => {}) : refund());
  if (voice && !topup) {
    const minutes = Number(await store.get(voiceMinutesKey(readerId))) || 0;
    if (minutes + interviewMinutes(plan.plan) > cfg.voice.monthlyMinutes) {
      await refund();
      const resetsAt = nextMonth();
      throw fail('quota', 429, `You’ve used this month’s ${cfg.voice.monthlyMinutes} voice minutes.`, secondsUntil(resetsAt), { resetsAt });
    }
  }

  return createStarted(readerId, system, plan, cfg, consentVersion, opts, id, { topup, giveBack });
}

/** Opens the session's meter at the ledger, then creates the session (the meter closes without a charge if that fails). */
async function startMetered(readerId: string, system: string, plan: Plan, cfg: InterviewConfig, consentVersion: string, opts: StartOptions, id: string) {
  const product = productOf({ kind: opts.kind, scope: plan.scope });
  const mode = opts.mode === 'voice' ? 'voice' : 'text';
  try {
    await openMeter({ sessionId: id, readerId, plan: opts.plan ?? 'free', product, mode, label: (plan.lesson?.title ?? plan.system.name).slice(0, 120) });
  } catch (err) {
    if (err instanceof LedgerError && err.code === 'credits') {
      const needed = Number(err.body.needed) || 0;
      const what = opts.kind === 'coach' ? 'lesson' : product === 'drill' ? 'drill' : 'mock interview';
      throw fail('credits', 402, `You need at least ${needed} credits to start a ${mode === 'voice' ? 'voice ' : ''}${what}.`, undefined, { balance: err.body.balance, needed, rate: err.body.rate });
    }
    console.error(JSON.stringify({ level: 'error', event: 'credits_open_failed', session: id, err: (err as Error).message }));
    throw fail('unavailable', 503, 'Your credits can’t be checked right now. Try again in a moment.', 5);
  }
  const giveBack = () => chargeMeter(id, { seconds: 0, close: true, waive: true }).then(() => {}, () => {});
  return createStarted(readerId, system, plan, cfg, consentVersion, opts, id, { topup: false, giveBack, metered: true });
}

async function createStarted(
  readerId: string,
  system: string,
  plan: Plan,
  cfg: InterviewConfig,
  consentVersion: string,
  opts: StartOptions,
  id: string,
  { topup, giveBack, metered }: { topup: boolean; giveBack: () => Promise<void>; metered?: boolean },
): Promise<{ session: SessionView; resumed: boolean }> {
  const voice = opts.mode === 'voice';
  const coach = opts.kind === 'coach';
  const scope = plan.scope;
  const now = new Date().toISOString();
  const first = plan.plan.stages[0];
  // A playlist's lesson starts from what the learner's earlier lessons left (read once: the prompt stays the same all lesson).
  const recall = plan.lesson ? await recallFor(readerId, plan).catch(() => []) : [];
  const session: Session = {
    id,
    readerId,
    system,
    ...(scope ? { scope } : {}),
    ...(plan.lesson ? { course: { lesson: plan.lesson.slug, recall } } : {}),
    ...(voice ? { mode: 'voice' as const, voice: initialVoice(!!opts.audioOptIn) } : {}),
    ...(coach ? { kind: 'coach' as const, coach: initialCoachState(plan.plan, 0, now) } : {}),
    ...(coach && learnerName(opts.name) ? { learnerName: learnerName(opts.name)! } : {}),
    ...(coach && opts.questions === false ? { coachQuiet: true as const } : {}),
    ...(topup ? { topup: true as const } : {}),
    ...(metered ? { metered: true as const } : {}),
    planVersion: plan.version,
    consent: { version: consentVersion, at: now },
    status: 'active',
    startedAt: now,
    stageIndex: 0,
    stageStartedAt: now,
    director: initialState(plan.plan, 0, now),
    rubricVersion: plan.version,
    // A lesson opens with the coach's first move (continueLesson), not a scripted opener.
    turns: coach ? [] : [{ role: 'interviewer', stage: first.key, text: `${plan.plan.prompt}\n\n${first.opener}`, at: now, meta: { source: 'opener', section: plan.plan.stages[0].sections[0] } }],
    candidateTurns: 0,
    costUsd: 0,
    feedback: null,
    updatedAt: now,
  };
  try {
    await createSession(session, cfg.retentionDays);
  } catch (err) {
    await giveBack();
    throw err;
  }
  console.log(JSON.stringify({ event: 'interview_started', system, scope, ...(plan.lesson ? { lesson: plan.lesson.slug } : {}), session: session.id, plan: plan.version, mode: voice ? 'voice' : 'text', kind: coach ? 'coach' : 'interview', topup, metered: !!metered }));
  return { session: toView(session, plan.lesson ? { ...plan, lesson: { ...plan.lesson, recall } } : plan, cfg), resumed: false };
}

const openSession = async (readerId: string, id: string): Promise<[Session, Plan]> => {
  const { session, plan } = await mine(readerId, id);
  return [session, plan];
};

/** The session's stage in the plan; a plan edited to fewer stages mid-session leaves it on the last one. */
const stageAt = (plan: Plan, session: Pick<Session, 'stageIndex'>) => plan.plan.stages[Math.min(session.stageIndex, plan.plan.stages.length - 1)];

export function assertOpen(session: Session, plan: Plan, cfg: InterviewConfig) {
  if (session.status !== 'active') throw fail('finished', 409, 'This interview has ended.');
  const closed = closedReason(session, plan, cfg);
  if (closed === 'time') throw fail('time_up', 409, 'Time is up. End the interview to get your feedback.');
  if (closed === 'done') throw fail('done', 409, 'The interviewer has wrapped up. End the interview to get your feedback.');
  if (closed === 'turns') throw fail('turns', 409, `That was the last of this session’s ${limitsOf(session, cfg).maxTurns} messages. End the interview to get your feedback.`);
  if (closed === 'budget') throw fail('session_budget', 409, 'This session has reached its limit. End the interview to get your feedback.');
  if (closed === 'credits') throw fail('credits', 409, session.kind === 'coach' ? 'You’ve run out of credits. End the lesson to see what you covered.' : 'You’ve run out of credits. End the interview to get your feedback.');
}

/**
 * A call from the voice pipeline (design section 6): its lease must be the session's current one.
 * A pipeline from before a reconnect (an older epoch) is told so (409 stale_epoch) and stops.
 * Without `voice`, the call is the room's: refused while a pipeline is speaking for the session.
 */
export type VoiceCall = { epoch: number };

function assertVoiceTurn(session: Session, voice: VoiceCall | undefined) {
  if (!voice) {
    if (voiceLive(session)) throw fail('voice_live', 409, 'The voice interview is running. Speak, or end the voice part first.');
    if (voiceAwaited(session)) throw fail('voice_live', 409, 'The voice is still connecting. Wait for it, or switch to typing.');
    return;
  }
  const v = session.voice;
  if (!v || v.ended) throw fail('voice_ended', 409, 'The voice part of this interview is over.');
  if (!v.lease || v.lease.epoch !== voice.epoch) throw fail('stale_epoch', 409, 'Another pipeline has taken over this session.', undefined, { epoch: v.lease?.epoch ?? null });
}

/** The stage's clock, with a voice session's parked time taken off. */
const stageElapsedMs = (session: Session, at: string) => Date.parse(at) - Date.parse(session.stageStartedAt) - (session.voice?.stagePausedMs ?? 0);

/** Runs one call on the session at a time, across instances; the lock outlives the slowest call. */
export async function withLock<T>(id: string, cfg: InterviewConfig, run: () => Promise<T>, ttlMs?: number): Promise<T> {
  const release = await lockSession(id, ttlMs ?? Math.max(cfg.feedbackTimeoutMs, 120_000) + 30_000);
  if (!release) throw fail('busy', 409, 'The interviewer is still answering your last message.', 2);
  try {
    return await run();
  } finally {
    await release().catch(() => {});
    meterLater(id);
  }
}

/**
 * Sends the candidate's message and gets the interviewer's reply (streamed to onText when given).
 * Both are saved only once the whole reply has arrived; a reply that fails or is stopped saves no
 * turns, and the candidate can send the message again. Its cost, when it may have been billed, is
 * still charged to the session's budget (Lane.onSpend).
 */
export type ReplyOptions = {
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  /**
   * The voice pipeline's turn (design section 6): its lease, and the turn's sequence number, which
   * must be the next one (a turn sent twice after a dropped response is answered once; an older
   * one is refused). The spoken message may run to MAX_VOICE_MESSAGE_CHARS.
   */
  voice?: VoiceCall & { seq: number };
  /** The reply's drawing, as soon as it is parsed (the voice pipeline forwards it to the room's board while the words are spoken). */
  onDraw?: (ops: DrawOp[], anchor: DrawAnchor) => void;
};

export async function reply(readerId: string, id: string, text: string, opts: ReplyOptions = {}): Promise<{ turn: SessionView['turns'][number]; session: SessionView }> {
  const arrived = Date.now();
  const message = text.trim();
  const maxChars = opts.voice ? MAX_VOICE_MESSAGE_CHARS : MAX_MESSAGE_CHARS;
  if (!message || message.length > maxChars) throw fail('invalid', 400, `Write a message of up to ${maxChars} characters.`);
  const cfg = interviewConfig();
  const [first, firstPlan] = await openSession(readerId, id);
  assertOpen(first, firstPlan, cfg);
  if (first.kind === 'coach') return coachTurn(readerId, id, message, cfg, opts);
  assertVoiceTurn(first, opts.voice);
  return withLock(id, cfg, async () => {
    // Read again under the lock: the last reply or a stage change may have just been saved.
    const { session, plan } = await mine(readerId, id);
    assertOpen(session, plan, cfg);
    assertVoiceTurn(session, opts.voice);
    if (opts.voice) {
      const last = session.voice?.lease?.seq ?? 0;
      if (opts.voice.seq !== last + 1) throw fail('stale_epoch', 409, opts.voice.seq <= last ? 'That turn was already answered.' : 'A turn is missing before this one.', undefined, { seq: last });
    }
    const prep = (await prepareReply(readerId, session, plan, cfg, message, !!opts.voice))!;
    const { stage, directed, before, record, board, candidate, params } = prep;
    // A guess started on these words before the turn was confirmed (prefetch.ts) is the reply so far.
    const prefetched = opts.voice ? claimPrefetch(id, prep.key) : null;
    const meta = {
      readerId,
      topic: `${session.system}/interview`,
      signal: opts.signal,
      lane: lane(cfg, 'reply', plan, session.id, !!opts.voice),
      // prepMs: the work before the model call (the lock, the store, the board), for the voice latency line.
      log: { session: session.id, stage: stage.key, turn: session.candidateTurns + 1, streamed: !!opts.onText, director: directed.decision.row, move: directed.decision.move, prepMs: Date.now() - arrived },
    };
    let result: CallResult | null = null;
    // A trailing <draw> element (draw.ts) never reaches the room's stream or the voice.
    const live = liveDraw(opts, record?.graph ?? null, !(session.drawn ?? []).includes(stage.key));
    const sink = opts.onText ? holdDraw(opts.onText, live.onElement) : null;
    let streamed = '';
    const onText = (delta: string) => {
      streamed += delta;
      sink?.onText(delta);
    };
    // A spoken turn the candidate cuts into: the voice service drops the stream, and the exchange
    // is kept as far as it got (their words, and the start of the reply; `played` trims it to the
    // words heard), so the next turn follows at once instead of waiting for the reply's end.
    let cut = false;
    if (prefetched && opts.signal) opts.signal.addEventListener('abort', () => prefetched.abort(), { once: true });
    try {
      if (prefetched) result = await prefetched.feed(onText);
      else result = sink ? await streamMessage(params, meta, onText) : await createMessage(params, meta);
    } catch (err) {
      if (!(opts.voice && err instanceof AskError && err.code === 'aborted')) {
        if (err instanceof AskError) throw fromGateway(err);
        throw err;
      }
      cut = true;
    }
    sink?.flush();
    // The interviewer may draw once a stage, on the board it was shown (the record's graph).
    const drawn = parseDraw(result ? replyOf(result.message) : streamed.trim(), record?.graph ?? null, !(session.drawn ?? []).includes(stage.key));
    live.finish(drawn.ops);
    const interviewer: Turn | null =
      cut && !drawn.text
        ? null // nothing of the reply reached them: their words stand alone, and the next turn answers both
        : { role: 'interviewer', stage: stage.key, text: cut ? `${drawn.text} —` : drawn.text, at: new Date().toISOString(), meta: { section: directed.state.section, ...(drawn.ops.length ? { draw: drawn.ops } : {}), ...(cut ? { interrupted: true } : {}) } };
    // The cost is already on the session (onSpend). A session that ended meanwhile takes no turns.
    let ended = false;
    const saved = await updateSession(id, cfg.retentionDays, (s) => {
      if (s.status !== 'active') {
        ended = true;
        return null;
      }
      const next: Session = { ...s, turns: [...s.turns, ...before, candidate, ...(interviewer ? [interviewer] : [])], candidateTurns: s.candidateTurns + 1, director: directed.state, ...board?.session, ...(drawn.ops.length ? { drawn: [...(s.drawn ?? []), stage.key] } : {}) };
      // The pipeline's lease records the turn it has been answered (and stays fresh).
      if (opts.voice && next.voice?.lease) {
        next.voice = { ...next.voice, lease: { ...next.voice.lease, seq: opts.voice.seq, at: new Date().toISOString() }, usage: { ...next.voice.usage, exchanges: next.voice.usage.exchanges + 1 } };
      }
      return applyMove(next, plan, directed, record);
    });
    if (ended) throw fail('finished', 409, 'This interview has ended.');
    if (!saved) throw fail('not_found', 404, 'That interview session has expired.');
    // What the board shows goes into the ledger as partial evidence (never covered: words do that).
    if (board?.tags.length) await writeBoardEvidence(id, cfg, plan, saved, board.tags).catch((err) => console.error('[interview] board evidence:', (err as Error).message));
    // The evaluator tags this turn after the reply is out (one turn behind, by design).
    scheduleEvaluation(readerId, id, plan, cfg, saved.turns.map((t) => t.role).lastIndexOf('candidate'), saved.candidateTurns);
    return { turn: viewTurn(interviewer ?? { role: 'interviewer', stage: stage.key, text: '', at: new Date().toISOString(), meta: { interrupted: true } }), session: toView(saved, plan, cfg) };
  });
}

type Prepared = {
  stage: ReturnType<typeof stageAt>;
  directed: DirectorResult;
  before: Turn[];
  record: BoardRecord | null;
  board: BoardTurn | null;
  candidate: Turn;
  params: ReturnType<typeof replyRequest>;
  /** The request's fingerprint: its context and the spoken words, normalized (prefetch.ts). */
  key: PrefetchKey;
};

/**
 * Everything a reply needs before the model is called, from the session as it stands: the
 * director's decision, the board's delta and the request. `speculative` skips a turn whose board
 * changed (its matcher calls are counted per stage and would run twice) and returns null for it.
 */
async function prepareReply(readerId: string, session: Session, plan: Plan, cfg: InterviewConfig, message: string, voice: boolean, speculative = false): Promise<Prepared | null> {
  const stage = stageAt(plan, session);
  const at = new Date().toISOString();
  const elapsedMs = stageElapsedMs(session, at);
  const minute = Math.floor(elapsedMs / 60_000);
  const directed = direct(session, plan, { text: message, idleRung: null, elapsedMs, closed: false }, await readSignal(session.id));
  const before: Turn[] = directed.sectionAdvance ? [sectionEvent(stage.key, directed.sectionAdvance, at)] : [];
  // The board as it stands, if it changed since the interviewer last saw it (design section 7).
  const record = await readBoard(session.id).catch(() => null);
  if (speculative && record && boardTextFor(record, session.board, stage.key)) return null;
  const board = record ? await boardForTurn(readerId, session, plan, cfg, record, stage.key, directed.state.section) : null;
  const candidate: Turn = {
    role: 'candidate',
    stage: stage.key,
    text: message,
    at,
    minute,
    meta: { section: directed.state.section, director: toMeta(directed.decision, directed.state), ...(voice ? { source: 'voice' as const } : {}), ...board?.meta },
  };
  const params = replyRequest(plan, [...session.turns, ...before, candidate], { voice });
  const blank: Turn = { ...candidate, text: '\u0000', at: '', minute: 0 };
  const context = createHash('sha256').update(JSON.stringify(replyRequest(plan, [...session.turns, ...before, blank], { voice }))).digest('base64url');
  const key: PrefetchKey = { context, spoken: normalizeSpoken(message) };
  return { stage, directed, before, record, board, candidate, params, key };
}

/**
 * Starts the interviewer's reply on what the voice service has heard so far, before the turn is
 * confirmed (prefetch.ts): the words arrive a few hundred milliseconds before the turn's end is
 * decided, and the model spends them. The session is read without its lock: a guess made while a
 * reply is being saved is simply on the wrong transcript, and is dropped when the real turn
 * arrives. Returns whether a guess was started.
 */
export async function speculate(readerId: string, id: string, text: string, voice: VoiceCall): Promise<boolean> {
  const message = text.trim();
  const cfg = interviewConfig();
  if (!cfg.voice.speculate || !message || message.length > MAX_VOICE_MESSAGE_CHARS) return false;
  const { session, plan } = await mine(readerId, id);
  assertOpen(session, plan, cfg);
  assertVoiceTurn(session, voice);
  const prep = await prepareReply(readerId, session, plan, cfg, message, true, true);
  if (!prep) return false;
  const meta = {
    readerId,
    topic: `${session.system}/interview`,
    lane: lane(cfg, 'reply', plan, session.id, true),
    log: { session: session.id, stage: prep.stage.key, turn: session.candidateTurns + 1, streamed: true, speculative: true, director: prep.directed.decision.row, move: prep.directed.decision.move },
  };
  startPrefetch(id, prep.key, (onText, signal) => streamMessage(prep.params, { ...meta, signal }, onText));
  return true; // started, or a guess on nearly these words was already running
}

/**
 * Moves to the next stage: its opener is written in the plan, so this costs nothing. Waits for no
 * reply: while the interviewer is answering it is refused as busy.
 */
export async function advance(readerId: string, id: string, from: unknown, opts: { voice?: VoiceCall } = {}): Promise<SessionView> {
  const cfg = interviewConfig();
  return withLock(id, cfg, () => advanceLocked(readerId, id, from, cfg, opts), 10_000);
}

async function advanceLocked(readerId: string, id: string, from: unknown, cfg: InterviewConfig, opts: { voice?: VoiceCall } = {}): Promise<SessionView> {
  const { session, plan } = await mine(readerId, id);
  assertOpen(session, plan, cfg);
  assertVoiceTurn(session, opts.voice);
  // The stage the room thinks it is leaving: a double click must not skip one.
  if (typeof from === 'number' && from !== session.stageIndex) return toView(session, plan, cfg);
  if (session.stageIndex >= plan.plan.stages.length - 1) throw fail('last_stage', 409, 'This is the last stage. End the interview when you’re ready.');
  const record = await readBoard(id).catch(() => null);
  const saved = await updateSession(id, cfg.retentionDays, (s) => {
    if (s.stageIndex !== session.stageIndex) return s;
    return openStage(s, plan, s.stageIndex + 1, record);
  });
  if (!saved) throw fail('not_found', 404, 'That interview session has expired.');
  return toView(saved, plan, cfg);
}

/** The session on a new stage: its marker and opener (written in the plan, no call), a fresh director, and the board as the stage left it. */
function openStage(s: Session, plan: Plan, next: number, board: BoardRecord | null = null): Session {
  const stage = plan.plan.stages[next];
  const at = new Date().toISOString();
  return {
    ...withSnapshot(s, board, stageAt(plan, s).key),
    ...(s.voice ? { voice: { ...s.voice, stagePausedMs: 0 } } : {}),
    stageIndex: next,
    stageStartedAt: at,
    director: initialState(plan.plan, next, at),
    ...(s.kind === 'coach' ? { coach: initialCoachState(plan.plan, next, at, s.coach) } : {}),
    turns:
      s.kind === 'coach'
        ? [...s.turns, { role: 'event', stage: stage.key, text: lessonMarker(plan, next, false), at, meta: { stage: next } }]
        : [
            ...s.turns,
            { role: 'event', stage: stage.key, text: stageMarker(plan, next, false), at, meta: { stage: next } },
            { role: 'interviewer', stage: stage.key, text: stage.opener, at, meta: { source: 'opener', section: stage.sections[0] } },
          ],
  };
}

/** The event turn that records a move to the next section inside the stage. */
function sectionEvent(stage: string, move: { from: string; to: string }, at: string): Turn {
  return { role: 'event', stage, text: `[Moving on within the stage: ${move.to.split('/').pop()}.]`, at, meta: { sectionAdvance: move, section: move.to } };
}

/**
 * Runs the director on the session's current stage (ADR 0003): what the interviewer does next,
 * from the clock, the candidate's message or the idle rung, and the evaluator's live signal.
 */
function direct(session: Session, plan: Plan, input: { text: string | null; idleRung: number | null; elapsedMs: number; closed: boolean }, signal: LiveSignal | null = null): DirectorResult {
  const stageIndex = Math.min(session.stageIndex, plan.plan.stages.length - 1);
  const state = session.director ?? initialState(plan.plan, stageIndex, session.stageStartedAt);
  return decide({ plan: plan.plan, stageIndex, elapsedMs: input.elapsedMs, state, text: input.text, intent: intentOf(input.text), signal, idleRung: input.idleRung, closed: input.closed });
}

/** The evaluator's live signal for the session (one turn behind), or null before it has run. */
async function readSignal(id: string): Promise<LiveSignal | null> {
  try {
    const raw = await (await getStore()).get(signalKey(id));
    return raw ? (JSON.parse(raw) as LiveSignal) : null;
  } catch {
    return null;
  }
}

/**
 * Performs the director's move after the interviewer has spoken: the next stage's marker and
 * opener (the model was told to bridge and ask nothing), or closing the session after the last
 * stage so only the feedback can run.
 */
function applyMove(s: Session, plan: Plan, directed: Pick<DirectorResult | CoachResult, 'decision'>, board: BoardRecord | null = null): Session {
  const { move } = directed.decision;
  if (move === 'advance_stage' && s.stageIndex < plan.plan.stages.length - 1) return openStage(s, plan, s.stageIndex + 1, board);
  if (move === 'end_interview' || move === 'end') return { ...s, closedBy: 'director' };
  return s;
}

/** The idle rungs the room may report (seconds without typing after the interviewer's last word). */
export const IDLE_RUNGS = [20, 35, 60, 120] as const;
const CANNED_NUDGE = 'Take your time.';

/**
 * The candidate has been quiet (the room's inactivity timer, design section 5). Nothing is ever
 * advanced on silence. 20 s: noted. 35 s: a canned "Take your time." (no call), once per stage.
 * 60 s: the interviewer rephrases the question (a call). 120 s: offers a hint or moving on (a
 * call). Each rung fires once per stage; a lower rung after a higher one does nothing.
 */
export async function idle(readerId: string, id: string, rung: unknown, opts: { voice?: VoiceCall } = {}): Promise<SessionView> {
  const cfg = interviewConfig();
  if (typeof rung !== 'number' || !(IDLE_RUNGS as readonly number[]).includes(rung)) throw fail('invalid', 400, 'Unknown idle rung.');
  return withLock(id, cfg, async () => {
    const { session, plan } = await mine(readerId, id);
    assertOpen(session, plan, cfg);
    if (session.kind === 'coach') return toView(session, plan, cfg);
    assertVoiceTurn(session, opts.voice);
    const stage = stageAt(plan, session);
    const state = session.director ?? initialState(plan.plan, session.stageIndex, session.stageStartedAt);
    if ((state.idle ?? 0) >= rung) return toView(session, plan, cfg);
    const at = new Date().toISOString();
    const mark = (s: Session, turns: Turn[], director = s.director ?? state): Session => ({ ...s, turns: [...s.turns, ...turns], director: { ...director, idle: rung } });
    if (rung < 60) {
      const turns: Turn[] = rung === 35 ? [{ role: 'interviewer', stage: stage.key, text: CANNED_NUDGE, at, meta: { source: 'canned', idle: rung, section: state.section } }] : [];
      const saved = await updateSession(id, cfg.retentionDays, (s) => (s.status !== 'active' ? s : mark(s, turns)));
      if (!saved) throw fail('not_found', 404, 'That interview session has expired.');
      return toView(saved, plan, cfg);
    }
    const elapsedMs = stageElapsedMs(session, at);
    const directed = direct(session, plan, { text: null, idleRung: rung, elapsedMs, closed: false }, await readSignal(id));
    const event: Turn = { role: 'event', stage: stage.key, text: `[The candidate has been quiet for ${rung === 60 ? 'a minute' : 'two minutes'}.]`, at, meta: { idle: rung, section: directed.state.section, director: toMeta(directed.decision, directed.state) } };
    const params = replyRequest(plan, [...session.turns, event], { voice: true });
    let result;
    try {
      result = await createMessage(params, { readerId, topic: `${session.system}/interview`, lane: lane(cfg, 'reply', plan, session.id, true), log: { session: session.id, stage: stage.key, idle: rung, director: directed.decision.row } });
    } catch (err) {
      if (err instanceof AskError) throw fromGateway(err);
      throw err;
    }
    const interviewer: Turn = { role: 'interviewer', stage: stage.key, text: replyOf(result.message), at: new Date().toISOString(), meta: { idle: rung, section: directed.state.section } };
    const saved = await updateSession(id, cfg.retentionDays, (s) => (s.status !== 'active' ? s : mark(s, [event, interviewer], directed.state)));
    if (!saved) throw fail('not_found', 404, 'That interview session has expired.');
    return toView(saved, plan, cfg);
  });
}

/**
 * A lesson's questions, on (a discussion: the coach asks for lists, checks, drawings) or off (it teaches straight
 * through): the learner's toggle in the room, kept on the session. The next move follows it; one still waiting for
 * the learner's answer stops waiting, and the room's (or the voice's) continue takes the lesson on.
 */
export async function setCoachQuestions(readerId: string, id: string, on: unknown): Promise<SessionView> {
  const cfg = interviewConfig();
  if (typeof on !== 'boolean') throw fail('invalid', 400, 'Say whether the coach asks questions (true or false).');
  return withLock(id, cfg, async () => {
    const { session, plan } = await mine(readerId, id);
    if (session.kind !== 'coach') throw fail('invalid', 400, 'Only a lesson has questions to turn off.');
    if (session.status !== 'active' || !!session.coachQuiet === !on) return toView(session, plan, cfg);
    const saved = await updateSession(id, cfg.retentionDays, (s) => {
      const { coachQuiet: _, ...rest } = s;
      return on ? rest : { ...rest, coachQuiet: true };
    });
    if (!saved) throw fail('not_found', 404, 'That lesson has expired.');
    return toView(saved, plan, cfg);
  });
}

/**
 * Ends the session and writes the feedback (one call on the feedback model, with structured
 * output). Runs whatever closed the session (time, turns, budget), once: a finished session
 * returns its feedback. With nothing said, it ends without a call; after MAX_FEEDBACK_ATTEMPTS
 * feedback calls that may have been billed and failed, it ends without feedback.
 */
export async function finish(readerId: string, id: string, opts: { signal?: AbortSignal } = {}): Promise<SessionView> {
  // Charged to the session's last use before the reader ended it, never for the feedback's writing.
  const at = Date.now();
  const view = await finishSession(readerId, id, opts);
  const s = await getSession(id).catch(() => null);
  const plan = s?.metered ? sessionPlan(s) : null;
  if (s && plan) await meterSession(s, plan, interviewConfig(), { close: true, now: at });
  return view;
}

async function finishSession(readerId: string, id: string, opts: { signal?: AbortSignal } = {}): Promise<SessionView> {
  const cfg = interviewConfig();
  const { session, plan } = await mine(readerId, id);
  if (session.status === 'finished') return toView(session, plan, cfg);
  if (voiceLive(session)) throw fail('voice_live', 409, 'The voice interview is running. End the voice part first, then get your feedback.');
  const end = async (feedbackNote: string) => {
    const saved = await updateSession(id, cfg.retentionDays, (s) =>
      s.status === 'finished' ? s : { ...s, status: 'finished', feedback: null, ...(feedbackNote ? { feedbackNote } : {}) },
    );
    if (!saved) throw fail('not_found', 404, 'That interview session has expired.');
    return toView(saved, plan, cfg);
  };

  // Under the session's lock, like a reply: a reply in flight makes this busy rather than ending
  // the session under it.
  return withLock(id, cfg, async () => {
    const { session: current } = await mine(readerId, id);
    if (current.status === 'finished') return toView(current, plan, cfg);
    if (current.voice && !current.voice.ended) await updateSession(id, cfg.retentionDays, (s) => (s.voice ? { ...s, voice: { ...s.voice, ended: true, lease: null, parked: null } } : s));
    // A lesson ends without a grader: what the learner understood is the coach's ledger (the lesson view).
    if (current.kind === 'coach') return end('');
    if (current.candidateTurns === 0) return end('You ended the interview before answering, so there is nothing to give feedback on.');
    if ((current.feedbackAttempts ?? 0) >= MAX_FEEDBACK_ATTEMPTS) return end(FEEDBACK_FAILED);
    // The board as it stands at the end, and the stages' PNGs, go to the grader (design section 7).
    const record = await readBoard(id).catch(() => null);
    const graded = withSnapshot(current, record, stageAt(plan, current).key);
    const images: BoardImage[] = [];
    for (const stage of (record?.pngs ?? []).filter((k) => k !== CURRENT_PNG)) {
      const png = await readPng(id, stage).catch(() => null);
      if (png) images.push({ stage, data: png.data });
    }
    const meta = {
      readerId,
      topic: `${session.system}/interview`,
      signal: opts.signal,
      lane: lane(cfg, 'feedback', plan, session.id),
      log: { session: session.id, turns: current.candidateTurns, attempt: (current.feedbackAttempts ?? 0) + 1 },
    };
    let result;
    try {
      result = await createMessage(feedbackRequest(plan, graded, images), meta);
    } catch (err) {
      if (err instanceof AskError) throw fromGateway(err);
      throw err;
    }
    const parsed = parseFeedback(plan, result.message);
    if (!parsed) console.error(JSON.stringify({ level: 'error', event: 'interview_feedback_unparsed', session: session.id, stopReason: result.message.stop_reason }));
    // Verdicts without the candidate's words behind them are downgraded; ratings follow the rules (grading.ts).
    const feedback = parsed ? assembleFeedback(plan.plan, { ...parsed, items: verifyVerdicts(plan.plan, parsed.items, current.turns) }, current.turns, current.rubricVersion ?? plan.version) : null;
    // The cost is already on the session (onSpend).
    const saved = await updateSession(id, cfg.retentionDays, (s) =>
      s.status === 'finished'
        ? s
        : {
            ...s,
            boardSnapshots: graded.boardSnapshots,
            status: 'finished',
            feedback: feedback ? { ...feedback, at: new Date().toISOString() } : null,
            ...(feedback ? {} : { feedbackNote: FEEDBACK_FAILED }),
          },
    );
    if (!saved) throw fail('not_found', 404, 'That interview session has expired.');
    return toView(saved, plan, cfg);
  });
}

const FEEDBACK_FAILED = 'The feedback couldn’t be written this time. Your transcript is saved.';

/** One of the reader's sessions, for the room to resume, with its board. */
export async function readSession(readerId: string, id: string): Promise<SessionView & { board: BoardState | null }> {
  const { session, plan } = await mine(readerId, id);
  const record = await readBoard(id).catch(() => null);
  return { ...toView(session, plan), board: record ? { version: record.version, fingerprint: record.fingerprint, elements: record.elements } : null };
}

// ---------------------------------------------------------------------------------------
// The whiteboard (design section 7)

/** The board as the room holds it: the scene and the version to build the next save on. */
export type BoardState = { version: number; fingerprint: string; elements: BoardElement[] };

/**
 * Saves the room's scene as the board's next version: {version, fingerprint}. A stale baseVersion
 * is a 409 (board_conflict) carrying the server's scene; a finished session takes no more.
 */
export async function saveSessionBoard(readerId: string, id: string, body: unknown): Promise<{ version: number; fingerprint: string }> {
  const cfg = interviewConfig();
  const { session } = await mine(readerId, id);
  if (session.status !== 'active') throw fail('finished', 409, 'This interview has ended.');
  try {
    return await saveBoard(session, cfg.retentionDays, body);
  } catch (err) {
    if (err instanceof BoardConflict) throw fail('board_conflict', 409, 'The board changed in another tab.', undefined, { board: err.current });
    if (err instanceof BoardInvalid) throw fail('invalid', 400, err.message);
    throw err;
  }
}

/** Stores a PNG the room rendered of the board: the stage's (once, for the grader) or the current one (for the vision fallback). */
export async function saveSessionBoardPng(readerId: string, id: string, stage: string, png: Buffer, version: number): Promise<{ stored: boolean }> {
  const cfg = interviewConfig();
  const { session, plan } = await mine(readerId, id);
  if (session.status !== 'active') throw fail('finished', 409, 'This interview has ended.');
  if (stage !== CURRENT_PNG && !plan.plan.stages.some((s) => s.key === stage)) throw fail('invalid', 400, 'Unknown stage.');
  try {
    return await savePng(session, cfg.retentionDays, stage, png, version);
  } catch (err) {
    if (err instanceof BoardInvalid) throw fail('invalid', 400, err.message);
    throw err;
  }
}

type BoardTurn = { meta: Partial<TurnMeta>; session: Partial<Session>; tags: ReturnType<typeof boardTags> };

/**
 * What a candidate turn carries about the board: the board or its delta since the interviewer last
 * saw it, the matcher's coverage (with the model fallbacks, capped per stage, when the labels or
 * the drawing need them), and the ledger's partial evidence. Null when the board has not changed.
 */
async function boardForTurn(readerId: string, session: Session, plan: Plan, cfg: InterviewConfig, record: BoardRecord, stage: string, section: string): Promise<BoardTurn | null> {
  const text = boardTextFor(record, session.board, stage);
  if (!text) return null;
  const ref = plan.plan.board;
  const stageIndex = Math.min(session.stageIndex, plan.plan.stages.length - 1);
  const expectedSections = sectionsUpTo(plan.plan.stages, stageIndex, section);
  const calls = { ...(session.boardCalls ?? {}) };
  const matchKey = `${stage}:match`;
  const visionKey = `${stage}:vision`;
  const callMeta = (kind: CallKind, log: Record<string, unknown>) => ({ readerId, topic: `${session.system}/interview`, lane: lane(cfg, kind, plan, session.id), log: { session: session.id, stage, ...log } });

  let cov: Coverage = matchBoard(record.graph, ref, { expectedSections });
  // Leftover labels: one batched call, only while the stage has calls left and the labels are worth it.
  if (cov.extra.length && ref.components.length && (calls[matchKey] ?? 0) < cfg.boardMatchCalls) {
    calls[matchKey] = (calls[matchKey] ?? 0) + 1;
    try {
      const result = await createMessage(boardMatchRequest(cov.extra, ref), callMeta('board', { board: record.version, labels: cov.extra.length }));
      const modelMatches = parseBoardMatch(result.message, cov.extra, ref);
      if (modelMatches && Object.keys(modelMatches).length) cov = matchBoard(record.graph, ref, { expectedSections, modelMatches });
    } catch (err) {
      console.error('[interview] board match:', err instanceof Error ? err.message : String(err));
    }
  }
  // A freehand or unlabelled board: a plain description from the current PNG, once per board version.
  let boardVision: string | undefined;
  const visionVersions = session.boardVisionVersions ?? [];
  if ((cov.freehandHeavy || cov.unlabelledRatio > 0.5) && !visionVersions.includes(record.version) && (calls[visionKey] ?? 0) < cfg.boardVisionCalls) {
    const png = await readPng(session.id, CURRENT_PNG).catch(() => null);
    if (png && png.version === record.version) {
      calls[visionKey] = (calls[visionKey] ?? 0) + 1;
      try {
        const result = await createMessage(boardVisionRequest(png.data, ref), callMeta('vision', { board: record.version }));
        boardVision = parseBoardVision(result.message) ?? undefined;
      } catch (err) {
        console.error('[interview] board vision:', err instanceof Error ? err.message : String(err));
      }
    }
  }
  // The evidence counts the candidate's own boxes only: what the interviewer or the coach drew (the author
  // mark, serialise.ts) is on the board for the model to read, never for the candidate's credit.
  const own = new Set(record.graph.nodes.filter((n) => !n.author).map((n) => n.id));
  const ownGraph: BoardGraph = own.size === record.graph.nodes.length ? record.graph : { ...record.graph, nodes: record.graph.nodes.filter((n) => own.has(n.id)), edges: record.graph.edges.filter((e) => (!e.from || own.has(e.from)) && (!e.to || own.has(e.to))) };
  const ownCov = ownGraph === record.graph ? cov : matchBoard(ownGraph, ref, { expectedSections });
  return {
    meta: { boardDelta: text.text, boardSeen: text.version, boardCoverage: cov, ...(boardVision ? { boardVision } : {}) },
    session: {
      board: { seen: record.version, graph: record.graph },
      boardCalls: calls,
      ...(boardVision ? { boardVisionVersions: [...visionVersions, record.version].slice(-20) } : {}),
    },
    tags: boardTags(plan.plan.stages[stageIndex], ref, ownCov),
  };
}

/** The board's partial evidence into the ledger (entry b<seq>, beside the evaluator's) and the live signal. */
async function writeBoardEvidence(id: string, cfg: InterviewConfig, plan: Plan, saved: Session, tags: ReturnType<typeof boardTags>): Promise<void> {
  const ttl = LEDGER_TTL_DAYS(cfg);
  const turnIndex = saved.turns.map((t) => t.role).lastIndexOf('candidate');
  const turn = saved.turns[turnIndex];
  const seq = saved.candidateTurns;
  const store = await getStore();
  let ledger: Ledger | null = null;
  for (let i = 0; i < 5 && !ledger; i++) {
    const raw = await store.get(ledgerKey(id));
    const current: Ledger = raw ? JSON.parse(raw) : { entries: {} };
    if (current.entries[`b${seq}`]) return;
    const entry = { turn: turnIndex, seq, stage: turn.stage, section: turn.meta?.section ?? '', utterance: 'answer' as const, tags, dropped: [], at: new Date().toISOString(), source: 'board' as const };
    const next: Ledger = { entries: { ...current.entries, [`b${seq}`]: entry } };
    const ok = raw ? await store.cas(ledgerKey(id), raw, JSON.stringify(next), ttl) : await store.setNx(ledgerKey(id), JSON.stringify(next), ttl);
    if (ok) ledger = next;
  }
  if (!ledger) return;
  await writeSignal(id, ttl, aggregate(ledger, plan.plan, saved.director?.skipped ?? []));
}

/** Deletes one of the reader's sessions now (transcript and feedback). */
export async function removeSession(readerId: string, id: string): Promise<void> {
  const session = await getSession(id);
  if (!session || session.readerId !== readerId) throw fail('not_found', 404, 'That interview session doesn’t exist, or it has expired.');
  await deleteSession(session, interviewConfig().retentionDays);
}

/** Everything the interview keeps about a reader, for the account export. */
export async function exportReaderSessions(readerId: string) {
  return (await listSessions(readerId)).map(({ readerId: _r, planVersion: _p, ...s }) => s);
}

/** A reader's progress through the coaching playlists (docs/coaching.md), for the account export. */
export const exportReaderProgress = (readerId: string) => exportProgress(readerId);

/** Deletes every session of a reader, and their playlist progress (account deletion). */
export async function purgeReaderSessions(readerId: string) {
  await purgeProgress(readerId);
  return deleteReaderSessions(readerId);
}

// ---------------------------------------------------------------------------------------
// Coach mode (docs/coach-mode.md): the coach drives. A learner message and a "continue"
// (the learner is ready for the next move) run the same turn: the coach director decides
// (coach.ts), the model writes the move, its drawing comes off the reply, and the move's effect
// (the next part, the end) is applied like the interviewer's.

/** The coach's next move without a learner message (the room's Continue, and its auto-continue). */
/** A coach's turn, as the pipeline or the room asks for it: a spoken learner turn carries its sequence number; a continue has none. */
export type CoachTurnOptions = Pick<ReplyOptions, 'signal' | 'onText' | 'onDraw'> & { voice?: VoiceCall & { seq?: number } };

/** Model calls a coach turn may make on the tool path: the move, and one more after its drawing is answered. */
export const COACH_TOOL_ROUNDS = 2;

/** The words of a message: its text blocks, as the stream handed them out. */
const textOf = (message: Anthropic.Beta.BetaMessage) =>
  message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

/**
 * The drawing as it streams: each <draw> element the sink closes is parsed at once, against the board
 * and what this reply drew before it, and sent to the room (`onDraw`), so a box lands as its sentence
 * is read. The whole reply is parsed again at the end for the saved turn (the same operations); a
 * reply that did not stream sends them then.
 */
function liveDraw(opts: Pick<ReplyOptions, 'onText' | 'onDraw'>, graph: BoardGraph | null, allowed: boolean, drawOpts?: DrawOptions): { onElement: (body: string, anchor: DrawAnchor) => void; finish: (ops: DrawOp[]) => void } {
  const parser = allowed ? drawParser(graph, drawOpts) : null;
  // The board a lesson opens with goes first, before a word.
  const prelude = parser?.ops.length ?? 0;
  if (prelude) opts.onDraw?.([...parser!.ops], { words: 0, prelude: true });
  let sent = false;
  return {
    onElement: (body, anchor) => {
      const ops = parser?.element(body) ?? [];
      if (!ops.length) return;
      sent = true;
      opts.onDraw?.(ops, anchor);
    },
    // Not streamed: the whole drawing, at once.
    finish: (ops) => {
      const rest = ops.slice(prelude);
      if (!sent && rest.length) opts.onDraw?.(rest, { words: 0 });
    },
  };
}

export async function continueLesson(readerId: string, id: string, opts: CoachTurnOptions = {}): Promise<{ turn: SessionView['turns'][number]; session: SessionView }> {
  const cfg = interviewConfig();
  const [first, firstPlan] = await openSession(readerId, id);
  if (first.kind !== 'coach') throw fail('invalid', 400, 'Only a coach lesson continues on its own.');
  assertOpen(first, firstPlan, cfg);
  return coachTurn(readerId, id, null, cfg, opts);
}

const CONTINUE_TEXT = '[Continue.]';

async function coachTurn(readerId: string, id: string, message: string | null, cfg: InterviewConfig, opts: CoachTurnOptions): Promise<{ turn: SessionView['turns'][number]; session: SessionView }> {
  const arrived = Date.now();
  const voice = opts.voice;
  return withLock(id, cfg, async () => {
    const { session, plan } = await mine(readerId, id);
    assertOpen(session, plan, cfg);
    // A voice lesson's turns come from its pipeline (a spoken answer in sequence; a continue out of it); the room waits.
    assertVoiceTurn(session, voice);
    if (voice && message !== null) {
      const last = session.voice?.lease?.seq ?? 0;
      if (voice.seq !== last + 1) throw fail('stale_epoch', 409, (voice.seq ?? 0) <= last ? 'That turn was already answered.' : 'A turn is missing before this one.', undefined, { seq: last });
    }
    const stage = stageAt(plan, session);
    const stageIndex = Math.min(session.stageIndex, plan.plan.stages.length - 1);
    const at = new Date().toISOString();
    const elapsedMs = stageElapsedMs(session, at);
    const state = session.coach ?? initialCoachState(plan.plan, stageIndex, session.stageStartedAt);
    // The board as it stands, if it changed since the coach last saw it (the learner draws too); what the
    // learner's own boxes show of the items decides a draw task's review.
    const record = await readBoard(id).catch(() => null);
    const board = record ? await boardForTurn(readerId, session, plan, cfg, record, stage.key, state.section) : null;
    // The learner cut the last move short: its reply was cut (the voice reports what was heard), or no reply
    // was kept at all (they spoke over its first words).
    const lastTurn = session.turns.at(-1);
    const cutIn = !!lastTurn && (lastTurn.role === 'interviewer' ? !!lastTurn.meta?.interrupted : lastTurn.role === 'candidate' && !!lastTurn.meta?.coach);
    // What the lesson's earlier moves drew (not the ones cut before the learner heard them).
    const earlier = session.turns.flatMap((t) => (t.meta?.interrupted ? [] : (t.meta?.draw ?? [])));
    // The lines its lists have (a part the learner gives first is written there in their words).
    const asks = plan.lesson && cfg.coach.asks ? plan.lesson.asks : undefined;
    // What of the asked parts is on the board, and what the learner gave of it.
    const runs = plan.lesson ? [...listRuns(plan.lesson.lists, earlier).values()] : [];
    const askIds = (asks ?? []).flatMap((a) => [...a.before, ...Object.values(a.lines).flat(), ...Object.values(a.rest).flat()]);
    const placedIds = new Set([...runs.flatMap((r) => [...r.covered]), ...(plan.lesson ? onBoard(plan.lesson.layout, askIds, earlier) : [])]);
    const lines = { placed: [...placedIds], given: earlier.flatMap((o) => ((o.op === 'note' || o.op === 'box' || o.op === 'region') && o.learner && o.covers ? [o.covers] : [])) };
    const directed = decideCoach({ plan: plan.plan, stageIndex, elapsedMs, state, text: message, signal: await readSignal(id), closed: false, drawn: board?.tags.map((t) => t.item) ?? [], cutIn, questions: cfg.coach.questions, quiet: !!session.coachQuiet, asks, lines });
    // A move that draws a lesson item names the item's planned ids in its instruction, so the model has them in hand
    // (an ask's frame, or the lines the learner left out, when the move names its own).
    const planned = plan.lesson && directed.decision.draw ? (directed.decision.place ?? (directed.decision.item ? plannedIds(plan.lesson, directed.decision.item) : [])) : [];
    // An ask names its frame itself, before its question.
    if (planned.length && directed.decision.move !== 'ask')
      directed.decision.template += ` Draw it as you speak: its board plan is <draw><place ids="${planned.join(',')}"/></draw>, split into one <draw><place ids="..."/></draw> per part, each at the point in your sentence where that part comes in and each followed by a sentence on what that part does or holds.`;
    // A doubt may be sketched: the coach's own drawing, in the side notes, clear of the lesson's parts.
    if (directed.decision.aside) directed.decision.template += ASIDE_ANSWER;
    // A lesson that goes on from an earlier lesson's board opens on it with a brief before the first drawing.
    if (directed.decision.move === 'intro') directed.decision.template += openingBrief(plan);
    else if (directed.decision.move === 'ask' && !state.opened) directed.decision.template += openingBrief(plan, 'then ask.');
    // A question turns to the learner by name, the wording alternating from one question to the next.
    if (session.learnerName && (directed.decision.move === 'check' || directed.decision.move === 'reteach')) {
      const asked = session.turns.filter((t) => t.meta?.coach?.move === 'check' || t.meta?.coach?.move === 'reteach').length;
      const name = session.learnerName;
      directed.decision.template += ` Open the question with "${asked % 2 ? `So tell me, ${name},` : `So ${name}, tell me,`}".`;
    }
    const before: Turn[] = directed.sectionAdvance ? [sectionEvent(stage.key, directed.sectionAdvance, at)] : [];
    const meta = { section: directed.state.section, coach: toCoachMeta(directed.decision), ...board?.meta };
    const learner: Turn =
      message === null
        ? { role: 'event', stage: stage.key, text: CONTINUE_TEXT, at, meta: { ...meta, continued: true } }
        : { role: 'candidate', stage: stage.key, text: message, at, minute: Math.floor(elapsedMs / 60_000), meta: { ...meta, ...(voice ? { source: 'voice' as const } : {}) } };
    const tools = cfg.coach.drawTools;
    const params = coachRequest(plan, [...session.turns, ...before, learner], { voice: !!voice, tools, name: session.learnerName, questions: cfg.coach.questions && !session.coachQuiet });
    const callMeta = {
      readerId,
      topic: `${session.system}/interview`,
      signal: opts.signal,
      lane: lane(cfg, 'reply', plan, id, !!voice, true),
      log: { session: id, stage: stage.key, turn: session.candidateTurns + (message === null ? 0 : 1), streamed: !!opts.onText, coach: directed.decision.row, move: directed.decision.move, continued: message === null, prepMs: Date.now() - arrived },
    };
    // A lesson's first move opens its board; that drawing is the service's, so it lands whatever the move.
    // The learner's points go on the list they are giving, and nothing of the plan is placed meanwhile.
    const giving = directed.decision.move === 'capture' ? asks?.find((a) => a.items.includes(directed.decision.item ?? '')) : undefined;
    const capture = giving?.list;
    const parts = giving && !giving.list ? Object.values(giving.lines).flat().filter((id) => !placedIds.has(id)) : undefined;
    const drawOpts = {
      ...coachDrawOptions(plan, !state.opened),
      ...(plan.lesson ? { aside: asideFor(plan.lesson.layout, earlier), lists: { plans: plan.lesson.lists, earlier, capture } } : {}),
      ...(parts ? { parts } : {}),
      ...(directed.decision.aside || giving ? { noPlace: true } : {}),
    };
    const mayDraw = !!directed.decision.draw || !!directed.decision.aside || !!drawOpts.prelude;
    const live = liveDraw(opts, record?.graph ?? null, mayDraw, tools ? { ...drawOpts, prelude: undefined } : drawOpts);
    const sink = opts.onText ? holdDraw(opts.onText, live.onElement) : null;
    // Only a check (or a reteach, a draw task) asks the learner anything: another move's question is not said.
    const asking = asksLearner(directed.decision.move);
    const quiet = sink && !asking ? questionFilter((delta) => sink.onText(delta)) : null;
    const said = (text: string) => (asking ? text : dropQuestions(text));
    let streamed = '';
    const onText = (delta: string) => {
      streamed += delta;
      (quiet ?? sink)?.onText(delta);
    };
    // A spoken move the learner cuts into (a question in the middle of an explanation): the pipeline
    // drops the stream, the move is kept as far as it got (`played` trims it to the words heard), and
    // the next continue picks up from there (the prompt sees the cut).
    let result: CallResult | null = null;
    let cut = false;
    // The tool path (phase 4): the coach's `draw` calls are run inside the turn and answered, up to a cap of
    // rounds, each round one more model call on the cached prefix; its words are the text blocks of every round.
    const toolParser = tools ? drawParser(record?.graph ?? null, drawOpts) : null;
    if (toolParser?.ops.length) opts.onDraw?.([...toolParser.ops], { words: 0 });
    let toolText = '';
    try {
      let messages = params.messages;
      for (let round = 0; ; round++) {
        const req = { ...params, messages };
        result = sink ? await streamMessage(req, callMeta, onText) : await createMessage(req, callMeta);
        if (!toolParser) break;
        toolText += textOf(result.message);
        const calls = result.message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use' && b.name === 'draw');
        if (result.message.stop_reason !== 'tool_use' || !calls.length) break;
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = calls.map((call) => {
          const allowed = !!directed.decision.draw || !!directed.decision.aside;
          const seen = toolParser.dropped.length;
          const ops = allowed ? toolParser.element(drawToolBody(call.input)) : [];
          if (ops.length) opts.onDraw?.(ops, { words: countWords(toolText) });
          return { type: 'tool_result', tool_use_id: call.id, content: drawToolResult(ops, toolParser.dropped.slice(seen), allowed) };
        });
        if (round >= COACH_TOOL_ROUNDS - 1) break;
        messages = [...messages, { role: 'assistant', content: result.message.content }, { role: 'user', content: results }];
      }
    } catch (err) {
      if (!(voice && err instanceof AskError && err.code === 'aborted')) {
        if (err instanceof AskError) throw fromGateway(err);
        throw err;
      }
      cut = true;
    }
    quiet?.flush();
    sink?.flush();
    // The coach draws when its decision says so, with the wider vocabulary, on the board it was shown.
    const drawn = toolParser
      ? { ...parseDraw(said(result && !cut ? toolText.trim() || 'Go on.' : streamed.trim()), null, false), ops: toolParser.ops, dropped: toolParser.dropped }
      : parseDraw(said(result ? replyOf(result.message) : streamed.trim()), record?.graph ?? null, mayDraw, drawOpts);
    if (!toolParser) live.finish(drawn.ops);
    // What the plan has for this item and the reply left off the board: the service places it after the words,
    // so a move that teaches an item never leaves it without its picture.
    const filled = !toolParser && !cut && planned.length ? fillPlanned(planned, drawn.ops, record?.graph ?? null, drawOpts, earlier) : { ops: [], ids: [] };
    if (filled.ops.length) {
      drawn.ops.push(...filled.ops);
      opts.onDraw?.(filled.ops, { words: countWords(drawn.text) });
    }
    // What the move was asked to put on the board and what landed: a lesson whose board stops growing shows here.
    const raw = toolParser ? '' : said(result ? replyOf(result.message) : streamed);
    console.log(
      JSON.stringify({
        event: 'coach_draw',
        session: id,
        stage: stage.key,
        move: directed.decision.move,
        item: directed.decision.item,
        draw: !!directed.decision.draw,
        elements: (raw.match(/<draw>/gi) ?? []).length,
        ops: drawn.ops.map((o) => (o.op === 'box' || o.op === 'region' ? `${o.op}:${o.label}${o.at ? '@' : ''}` : o.op === 'arrow' ? `arrow:${o.from}>${o.to}` : o.op === 'note' ? `note${o.at ? '@' : ''}` : o.op)),
        dropped: drawn.dropped,
        filled: filled.ops.length,
      }),
    );
    const now = new Date().toISOString();
    // A continue cut before a word of it was heard did not happen: the lesson stands where it was.
    if (cut && !drawn.text && message === null) return { turn: viewTurn({ role: 'interviewer', stage: stage.key, text: '', at: now, meta: { interrupted: true } }), session: toView(session, plan, cfg) };
    const coach: Turn | null =
      cut && !drawn.text
        ? null // the learner spoke over the start of the answer: their words stand, and the next move answers both
        : {
            role: 'interviewer',
            stage: stage.key,
            text: cut ? `${drawn.text} —` : drawn.text,
            at: now,
            meta: {
              section: directed.state.section,
              ...(drawn.ops.length ? { draw: drawn.ops } : {}),
              ...(drawn.dropped.length ? { drawDropped: drawn.dropped } : {}),
              ...(cut ? { interrupted: true } : {}),
              // What the model reads back of this move: its words with the drawing in them.
              ...(!cut && drawn.ops.length && raw ? { said: readBack(raw.trim(), filled.ids, drawOpts.layout) } : {}),
            },
          };
    let ended = false;
    const saved = await updateSession(id, cfg.retentionDays, (s) => {
      if (s.status !== 'active') {
        ended = true;
        return null;
      }
      const next: Session = { ...s, turns: [...s.turns, ...before, learner, ...(coach ? [coach] : [])], candidateTurns: s.candidateTurns + (message === null ? 0 : 1), coach: directed.state, ...board?.session };
      // The pipeline's lease records the spoken turn it has answered (and stays fresh).
      if (voice && next.voice?.lease) {
        const spoken = message !== null;
        next.voice = { ...next.voice, lease: { ...next.voice.lease, seq: spoken ? (voice.seq ?? next.voice.lease.seq) : next.voice.lease.seq, at: now }, usage: { ...next.voice.usage, exchanges: next.voice.usage.exchanges + (spoken ? 1 : 0) } };
      }
      return applyMove(next, plan, directed, record);
    });
    if (ended) throw fail('finished', 409, 'This lesson has ended.');
    if (!saved) throw fail('not_found', 404, 'That lesson has expired.');
    // A playlist's lesson: what this move left with the learner, for their next lesson.
    if (plan.lesson) await recordProgress(readerId, plan, saved.coach, directed.state.parked, directed.decision.move === 'end', cfg.retentionDays).catch((err) => console.error('[coach] progress:', (err as Error).message));
    if (board?.tags.length) await writeBoardEvidence(id, cfg, plan, saved, board.tags).catch((err) => console.error('[interview] board evidence:', (err as Error).message));
    // The evaluator tags the learner's words (never a continue) after the reply is out.
    if (message !== null) scheduleEvaluation(readerId, id, plan, cfg, saved.turns.map((t) => t.role).lastIndexOf('candidate'), saved.candidateTurns);
    return { turn: viewTurn(coach ?? { role: 'interviewer', stage: stage.key, text: '', at: now, meta: { interrupted: true } }), session: toView(saved, plan, cfg) };
  });
}
