import { interviewMinutes } from '@arrowbox/content-kit';
import type { Reader } from '../session';
import { planOf } from '../entitlements';
import { getStore } from '../store';
import { interviewConfig, VOICE_CONSENT_VERSION, type InterviewConfig } from './config';
import { createRoom, createToken, DailyError, deleteRoom } from './daily';
import { getPlan, type Plan, type PlanScope } from './plans';
import {
  advance,
  assertOpen,
  checkInterviewCalls,
  closedReason,
  endsAt,
  fail,
  idle,
  InterviewError,
  mine,
  nextMonth,
  nextUtcMidnight,
  reply,
  secondsUntil,
  meterIfDue,
  sessionPlan,
  speculate,
  startSession,
  toView,
  voiceLive,
  withLock,
  type SessionKind,
  type SessionView,
  type VoiceCall,
} from './service';
import { lessonView } from './coach';
import type { DrawAnchor, DrawOp } from './draw';
import { continueLesson } from './service';
import { dropPrefetch } from './prefetch';
import { addSpend, getSession, interviewSpendKey, updateSession, voiceMinutesKey, voiceMonthKey, VOICE_SWITCH_KEY, voiceSpendKey, voiceTopups, type Session, type Turn, type VoiceState } from './sessions';
import { startPipeline, stopPipeline, VoiceServiceError, pipelineRunning } from './voice-client';
import { mintVoiceToken, verifyVoiceToken } from './voice-token';

// The voice room's server side (design section 6, docs/README.md "Voice"). A voice
// session is a text session the interview-voice service speaks for: the web tier owns the
// session, the quota, the budget and every model call; the service owns the audio. The room
// joins a private Daily room; the service dials it out, transcribes the candidate, posts each
// utterance here as a turn (the reply streams back and is spoken), and reports its usage in
// heartbeats. The web tier is the only writer of the session; the service holds no state of its
// own beyond the running pipeline.
//
// Leases: every attach gets a new epoch and the session's lease; a call from an older epoch is
// 409 stale_epoch and that pipeline stops. The lease is renewed by every turn and heartbeat and
// stands VOICE_LEASE_MS; while it stands the room's own controls (typing, next stage, finish)
// are 409 voice_live. When the line drops the session is parked: the clock stops for up to
// PARK_MAX_MS, and a rejoin attaches a new pipeline that continues the transcript.
//
// Cost controls, inside the interview's: Pro only; INTERVIEW_VOICE_MONTHLY_SESSIONS and
// INTERVIEW_VOICE_MONTHLY_MINUTES per reader; INTERVIEW_VOICE_MAX_EXCHANGES and
// INTERVIEW_VOICE_SESSION_BUDGET_USD per session (speech charged at the vendors' list prices
// from the heartbeats); INTERVIEW_VOICE_DAILY_BUDGET_USD and the voice switch
// (interview:voice:enabled) over all of it.

/** A parked session is kept this long for a rejoin before the voice part ends. */
export const PARK_MAX_MS = 15 * 60_000;
/** Minutes the room has to join the Daily room after a start or a rejoin. */
const JOIN_WINDOW_MS = 5 * 60_000;
/** The Daily room outlives the session's end by the park limit (a rejoin near the end). */
const ROOM_MARGIN_MS = PARK_MAX_MS + 5 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LANGUAGE = 'en-IN';

// ---------------------------------------------------------------------------------------
// Switch, budget and status

const SWITCH_CACHE_MS = 5_000;
let switchCache: { at: number; on: boolean } | null = null;

/** The voice room's own switch: the store flag when set, otherwise INTERVIEW_VOICE_ENABLED. Cached 5 s. */
export async function voiceEnabled(): Promise<boolean> {
  if (switchCache && Date.now() - switchCache.at < SWITCH_CACHE_MS) return switchCache.on;
  const flag = await (await getStore()).get(VOICE_SWITCH_KEY);
  const on = flag === 'on' ? true : flag === 'off' ? false : interviewConfig().voice.enabledByEnv;
  switchCache = { at: Date.now(), on };
  return on;
}

/** Forgets the cached switch (tests only). */
export const resetVoiceSwitchCache = () => {
  switchCache = null;
};

/** The voice service and its vendors are configured for this deployment. */
export const voiceConfigured = (cfg = interviewConfig()) => !!(cfg.voice.url && cfg.voice.secret && cfg.voice.dailyApiKey);

/** Throws unless a voice session may run: configured, its switch, its daily budget, then the interview's own checks. */
export async function checkVoiceCalls(cfg: InterviewConfig) {
  if (!voiceConfigured(cfg)) throw fail('unavailable', 503, 'Voice interviews are not available here.', 300);
  let on: boolean;
  let spent: number;
  try {
    on = await voiceEnabled();
    spent = Number(await (await getStore()).get(voiceSpendKey())) || 0;
  } catch (err) {
    console.error('[interview] voice store unavailable:', (err as Error).message);
    throw fail('unavailable', 503, 'Voice interviews are unavailable right now. Try again later.', 60);
  }
  if (!on) throw fail('disabled', 503, 'Voice interviews are paused right now. The text interview still works.', 300);
  if (spent >= cfg.voice.dailyBudgetUsd * 1e6) {
    throw fail('budget', 503, 'Voice interviews have reached their limit for today. The text interview still works.', secondsUntil(nextUtcMidnight()));
  }
  await checkInterviewCalls(cfg);
}

export type VoiceStatus = {
  enabled: boolean;
  reason?: 'disabled' | 'budget' | 'unavailable' | 'plan';
  limit: number;
  remaining: number;
  minutesLeft: number;
  /** Purchased sessions not yet used: a whole voice session runs on one once the month's are gone. */
  topups: number;
  resetsAt: string;
  /** The voice consent text's version a start must carry. */
  consentVersion: string;
};

const PRO_PLANS = new Set(['pro', 'staff']);
export const hasVoicePlan = (reader: Pick<Reader, 'plan' | 'planExpiresAt'> | null) => !!reader && PRO_PLANS.has(planOf(reader));

/** The voice room's state for a reader (or anyone, with null): on or off and why, and the month's quota. */
export async function voiceStatus(reader: Reader | null): Promise<VoiceStatus> {
  const cfg = interviewConfig();
  const base = { limit: cfg.voice.monthlySessions, resetsAt: nextMonth(), consentVersion: VOICE_CONSENT_VERSION };
  try {
    const store = await getStore();
    const used = reader ? Number(await store.get(voiceMonthKey(reader.documentId))) || 0 : 0;
    const minutes = reader ? Number(await store.get(voiceMinutesKey(reader.documentId))) || 0 : 0;
    const topups = reader ? await voiceTopups(reader.documentId) : 0;
    const remaining = Math.max(0, cfg.voice.monthlySessions - used);
    const minutesLeft = Math.max(0, cfg.voice.monthlyMinutes - minutes);
    try {
      await checkVoiceCalls(cfg);
    } catch (err) {
      if (err instanceof InterviewError && (err.code === 'disabled' || err.code === 'budget' || err.code === 'unavailable')) {
        return { ...base, enabled: false, reason: err.code, remaining, minutesLeft, topups };
      }
      throw err;
    }
    if (reader && !hasVoicePlan(reader)) return { ...base, enabled: false, reason: 'plan', remaining, minutesLeft, topups };
    return { ...base, enabled: true, remaining, minutesLeft, topups };
  } catch (err) {
    console.error('[interview] voice status unavailable:', (err as Error).message);
    return { ...base, enabled: false, reason: 'unavailable', remaining: 0, minutesLeft: 0, topups: 0 };
  }
}

// ---------------------------------------------------------------------------------------
// The room's side: start, join, leave

export type VoiceJoin = { url: string; token: string; expiresAt: string };

const dailyOpts = (cfg: InterviewConfig) => ({ apiUrl: cfg.voice.dailyApiUrl, apiKey: cfg.voice.dailyApiKey ?? '', geo: cfg.voice.dailyGeo });

/**
 * Starts a voice session on the system's plan (Pro only, with the voice consent) and its pipeline,
 * or resumes the reader's running voice session there. Counts one of the month's voice sessions
 * and its planned minutes.
 */
export async function startVoiceSession(reader: Reader, system: string, consentVersion: unknown, audioOptIn: unknown, scope: PlanScope = null, kind: SessionKind = 'interview', lesson: string | null = null, name: string | null = null): Promise<{ session: SessionView; join: VoiceJoin; resumed: boolean }> {
  const cfg = interviewConfig();
  if (!hasVoicePlan(reader)) throw fail('plan', 403, kind === 'coach' ? 'Voice lessons are part of Pro.' : 'Voice interviews are part of Pro.', undefined, { plan: planOf(reader) });
  await checkVoiceCalls(cfg);
  const { session, resumed } = await startSession(reader.documentId, system, consentVersion, { mode: 'voice', plan: planOf(reader), audioOptIn: audioOptIn === true, scope, ...(kind === 'coach' ? { kind } : {}), ...(lesson ? { lesson } : {}), ...(name ? { name } : {}) });
  if (session.mode !== 'voice') throw fail('active', 409, `You have a typed ${kind === 'coach' ? 'lesson' : 'interview'} in progress on this system. Finish it first.`, undefined, { id: session.id });
  if (!resumed) {
    // A top-up session reserves no monthly minutes (its own caps bound it).
    const saved = await getSession(session.id);
    // A session on credits reserves no minutes: it pays for the ones it uses.
    const minutes = saved?.system === system && !saved.topup && !saved.metered ? interviewMinutes(getPlan(system, saved.scope ?? null, saved.course?.lesson)!.plan) : 0;
    if (minutes) await (await getStore()).incrByFloat(voiceMinutesKey(reader.documentId), minutes, 40 * DAY_MS).catch(() => 0);
  }
  const join = await joinVoice(reader.documentId, session.id);
  return { session: join.session, join: join.join, resumed };
}

/**
 * The room joins (or rejoins) the voice part: a Daily room for the session if it has none, a
 * pipeline if none holds the session, and the candidate's meeting token. A pipeline that still
 * holds the session (the room reloaded) is left running: the token lets the room back in.
 */
export async function joinVoice(readerId: string, id: string): Promise<{ session: SessionView; join: VoiceJoin }> {
  const cfg = interviewConfig();
  await checkVoiceCalls(cfg);
  return withLock(
    id,
    cfg,
    async () => {
      const { session, plan } = await mine(readerId, id);
      const v = session.voice;
      if (session.mode !== 'voice' || !v) throw fail('invalid', 400, 'This is a text interview.');
      if (v.ended) throw fail('voice_ended', 409, 'The voice part of this interview is over. You can keep typing, or end it for your feedback.');
      assertOpen(session, plan, cfg);
      const now = Date.now();
      const roomUntil = new Date(Date.parse(endsAt(session, plan, cfg)) + PARK_MAX_MS + ROOM_MARGIN_MS);
      let room = v.room && Date.parse(v.room.expiresAt) > now + JOIN_WINDOW_MS ? v.room : null;
      if (!room) {
        try {
          room = await createRoom(dailyOpts(cfg), `iv-${session.id}`, roomUntil);
        } catch (err) {
          console.error('[interview] daily room:', err instanceof Error ? err.message : String(err));
          throw fail('unavailable', 503, 'The voice room couldn’t be opened. Try again, or use the text interview.', 30);
        }
        await updateSession(id, cfg.retentionDays, (s) => (s.voice ? { ...s, voice: { ...s.voice, room } } : s));
      }
      let live = voiceLive(session, now);
      if (live && !(await pipelineRunning(cfg.voice, session.id))) {
        // The lease is fresh but no pipeline is behind it (the service crashed or restarted without
        // detaching): park the session from its last heartbeat, as a detach would, and start anew.
        const lease = v.lease!;
        await updateSession(id, cfg.retentionDays, (s) => {
          if (!s.voice?.lease || s.voice.lease.epoch !== lease.epoch) return s;
          return { ...s, voice: { ...s.voice, lease: null, parked: { at: lease.at, stage: s.stageIndex } } };
        });
        console.log(JSON.stringify({ event: 'interview_voice_parked', session: session.id, epoch: lease.epoch, reason: 'pipeline_gone' }));
        live = false;
      }
      if (!live) {
        // No pipeline holds the session: start one. It attaches with the token within a minute.
        let botToken: string;
        try {
          botToken = await createToken(dailyOpts(cfg), room.name, { userId: 'bot', userName: 'Interviewer', owner: true }, roomUntil);
        } catch (err) {
          console.error('[interview] daily bot token:', err instanceof Error ? err.message : String(err));
          throw fail('unavailable', 503, 'The voice room couldn’t be opened. Try again, or use the text interview.', 30);
        }
        const attach = mintVoiceToken(cfg.voice.secret!, { uid: readerId, sid: session.id, planHash: plan.version, consentVersion: session.consent.version });
        try {
          const coach = session.kind === 'coach';
          const { task } = await startPipeline(cfg.voice, { sid: session.id, attach, room: { url: room.url, token: botToken }, language: LANGUAGE, audioOptIn: v.audioOptIn, plannedMinutes: interviewMinutes(plan.plan), kind: coach ? 'coach' : 'interview', ...(coach ? { turnStopSecs: COACH_TURN_STOP_SECS } : {}) });
          console.log(JSON.stringify({ event: 'interview_voice_pipeline', session: session.id, task, epoch: v.epochs + 1 }));
        } catch (err) {
          if (err instanceof VoiceServiceError && err.status === 503) throw fail('capacity', 503, 'Every voice interviewer is busy right now. Try again in a few minutes, or use the text interview.', 120);
          console.error('[interview] voice service:', err instanceof Error ? err.message : String(err));
          throw fail('unavailable', 503, 'The voice interviewer is unavailable right now. Try again, or use the text interview.', 30);
        }
      }
      let token: string;
      try {
        token = await createToken(dailyOpts(cfg), room.name, { userId: session.id, userName: 'Candidate', owner: false }, new Date(now + JOIN_WINDOW_MS));
      } catch (err) {
        console.error('[interview] daily token:', err instanceof Error ? err.message : String(err));
        throw fail('unavailable', 503, 'The voice room couldn’t be opened. Try again, or use the text interview.', 30);
      }
      const current = (await getSession(id)) ?? session;
      return { session: toView(current, plan, cfg), join: { url: room.url, token, expiresAt: new Date(now + JOIN_WINDOW_MS).toISOString() } };
    },
    30_000,
  );
}

/**
 * The candidate ends the voice part (the room's "End voice" or leaving for good): the pipeline is
 * stopped, the Daily room deleted, and the session goes on in text until the feedback.
 */
export async function leaveVoice(readerId: string, id: string): Promise<SessionView> {
  const cfg = interviewConfig();
  const { session, plan } = await mine(readerId, id);
  if (session.mode !== 'voice' || !session.voice) throw fail('invalid', 400, 'This is a text interview.');
  const saved = await endVoice(session, cfg, 'left');
  return toView(saved ?? session, plan, cfg);
}

/** Ends the voice part: lease, park and room cleared, the pipeline told to stop, the room deleted (both best effort). */
async function endVoice(session: Session, cfg: InterviewConfig, reason: string): Promise<Session | null> {
  dropPrefetch(session.id, 'ended');
  const saved = await updateSession(session.id, cfg.retentionDays, (s) => {
    if (!s.voice || s.voice.ended) return s;
    const parkedMs = s.voice.parked ? Math.min(PARK_MAX_MS, Date.now() - Date.parse(s.voice.parked.at)) : 0;
    return { ...s, voice: { ...s.voice, ended: true, lease: null, parked: null, pausedMs: s.voice.pausedMs + parkedMs, stagePausedMs: s.voice.stagePausedMs + parkedMs } };
  });
  console.log(JSON.stringify({ event: 'interview_voice_ended', session: session.id, reason, exchanges: session.voice?.usage.exchanges ?? 0, sttSeconds: session.voice?.usage.sttSeconds ?? 0, ttsChars: session.voice?.usage.ttsChars ?? 0 }));
  if (voiceConfigured(cfg)) {
    await stopPipeline(cfg.voice, session.id).catch((err) => console.error('[interview] voice stop:', (err as Error).message));
    if (session.voice?.room) await deleteRoom(dailyOpts(cfg), session.voice.room.name).catch((err) => console.error('[interview] daily delete:', (err as Error).message));
  }
  return saved;
}

/** The voice room's data goes with the session (deletion): the Daily room, and the pipeline if any. */
export async function releaseVoice(session: Session): Promise<void> {
  if (!session.voice || session.voice.ended) return;
  await endVoice(session, interviewConfig(), 'deleted').catch(() => null);
}

// ---------------------------------------------------------------------------------------
// The pipeline's side (the internal routes): attach, turns, played, advance, idle, heartbeat, detach, finish

/** What the pipeline needs to run the session; never the reader, the plan's brief, or the coverage. */
export type PipelineView = {
  epoch: number;
  /** The last candidate turn answered; the next turn is seq + 1. */
  seq: number;
  stageIndex: number;
  stage: { key: string; title: string; minutes: number; index: number; of: number };
  /** Spoken on attach: the opener the first time, a bridge after a reconnect. */
  say: string;
  resumed: boolean;
  closed: SessionView['closed'];
  endsAt: string;
  exchangesLeft: number;
  audioOptIn: boolean;
  /** The idle rungs (seconds of silence after the interviewer's last word) the pipeline reports. */
  idleRungs: readonly number[];
  /** A mock interview, or a coach lesson (docs/coach-mode.md): the pipeline speaks for the coach. */
  kind: SessionKind;
  /**
   * A coach lesson drives itself: this many seconds after the coach's last word with nothing from the
   * learner, the pipeline asks for the next move (`/turns` with kind `continue`). A short beat after a
   * move that waits for no answer; a long one after a question, so the coach settles an item nobody
   * answered. Null for an interview, and once the session is closed.
   */
  selfDrive: number | null;
};

/** The beat after a coach's move that waits for nothing, and the wait after a question the learner leaves unanswered. */
export const COACH_CONTINUE_AFTER_SECS = 1.5;
export const COACH_ANSWER_WAIT_SECS = 45;
/** A learner thinking aloud pauses longer than a candidate answering: the pipeline's turn-stop for a lesson. */
export const COACH_TURN_STOP_SECS = 3;

const stageOf = (session: Session, plan: Plan) => {
  const i = Math.min(session.stageIndex, plan.plan.stages.length - 1);
  const s = plan.plan.stages[i];
  return { key: s.key, title: s.title, minutes: s.minutes, index: i, of: plan.plan.stages.length };
};

const lastInterviewer = (turns: readonly Turn[]) => [...turns].reverse().find((t) => t.role === 'interviewer')?.text ?? '';

export function pipelineView(session: Session, plan: Plan, cfg: InterviewConfig, say: string, resumed: boolean): PipelineView {
  const v = session.voice!;
  const coach = session.kind === 'coach';
  const closed = closedReason(session, plan, cfg);
  const waiting = coach ? lessonView(plan.plan, session.coach, session.stageIndex).waiting : null;
  return {
    epoch: v.lease?.epoch ?? 0,
    seq: v.lease?.seq ?? session.candidateTurns,
    stageIndex: session.stageIndex,
    stage: stageOf(session, plan),
    say,
    resumed,
    closed,
    endsAt: endsAt(session, plan, cfg),
    exchangesLeft: Math.max(0, cfg.voice.maxExchanges - session.candidateTurns),
    audioOptIn: v.audioOptIn,
    // The coach's silence is its own to fill (selfDrive); the interviewer's rungs would only talk over it.
    idleRungs: coach ? [] : [20, 35, 60, 120],
    kind: coach ? 'coach' : 'interview',
    selfDrive: !coach || closed ? null : waiting === 'answer' || waiting === 'draw' ? COACH_ANSWER_WAIT_SECS : COACH_CONTINUE_AFTER_SECS,
  };
}

const RECONNECT_BRIDGE = 'Sorry, we lost the line for a moment. Where were we:';

/**
 * A pipeline takes the session with its attach token (one use, a minute): a new epoch and lease.
 * A parked session is unparked, its clock credited with the time it waited. Returns what to say
 * first and the state the pipeline runs on.
 */
export async function attachPipeline(sid: string, token: unknown, task: unknown): Promise<PipelineView> {
  const cfg = interviewConfig();
  const claims = cfg.voice.secret ? verifyVoiceToken(cfg.voice.secret, token) : null;
  if (!claims || claims.sid !== sid) throw fail('not_found', 404, 'Unknown session or token.');
  return withLock(
    sid,
    cfg,
    async () => {
      const { session, plan } = await mine(claims.uid, sid);
      const v = session.voice;
      if (session.mode !== 'voice' || !v) throw fail('invalid', 400, 'Not a voice session.');
      if (v.usedTokens.includes(claims.jti)) throw fail('stale_epoch', 409, 'That token was used.');
      if (v.ended) throw fail('voice_ended', 409, 'The voice part is over.');
      if (claims.planHash !== plan.version) throw fail('invalid', 409, 'The plan changed since the token was minted.', undefined, { planHash: plan.version });
      assertOpen(session, plan, cfg);
      const now = new Date();
      const resumed = v.epochs > 0;
      const saved = await updateSession(sid, cfg.retentionDays, (s) => {
        if (!s.voice) return s;
        const parkedMs = s.voice.parked ? Math.min(PARK_MAX_MS, now.getTime() - Date.parse(s.voice.parked.at)) : 0;
        const epoch = s.voice.epochs + 1;
        return {
          ...s,
          voice: {
            ...s.voice,
            epochs: epoch,
            lease: { epoch, seq: s.candidateTurns, at: now.toISOString(), task: typeof task === 'string' ? task.slice(0, 64) : 'unknown' },
            parked: null,
            pausedMs: s.voice.pausedMs + parkedMs,
            stagePausedMs: s.voice.stagePausedMs + parkedMs,
            usedTokens: [...s.voice.usedTokens, claims.jti].slice(-10),
            degraded: [],
          },
        };
      });
      if (!saved) throw fail('not_found', 404, 'That interview session has expired.');
      console.log(JSON.stringify({ event: 'interview_voice_attached', session: sid, epoch: saved.voice!.lease!.epoch, resumed }));
      const say = resumed ? `${RECONNECT_BRIDGE} ${lastInterviewer(saved.turns)}` : lastInterviewer(saved.turns);
      return pipelineView(saved, plan, cfg, say, resumed);
    },
    15_000,
  );
}

/** The session behind a pipeline's call: the reader is the session's (the bearer vouched for the call). */
async function pipelineSession(sid: string): Promise<{ session: Session; plan: Plan }> {
  const session = await getSession(sid);
  if (!session || session.mode !== 'voice' || !session.voice) throw fail('not_found', 404, 'Unknown session.');
  const plan = sessionPlan(session);
  if (!plan) throw fail('not_found', 404, 'Unknown session.');
  return { session, plan };
}

/** One spoken candidate turn: the reply streams to onText and both turns are saved (service.reply). */
/**
 * The voice service's guess at the candidate's turn before the turn is confirmed: the reply is
 * started on it (service.speculate, prefetch.ts), to be handed to the confirmed turn if the words match.
 */
export async function pipelineSpeculate(sid: string, call: VoiceCall, text: string): Promise<{ started: boolean }> {
  const { session } = await pipelineSession(sid);
  return { started: await speculate(session.readerId, sid, text, call) };
}

export type PipelineTurnOptions = {
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  /** The reply's drawing, for the room's board (the pipeline sends it over the call while the words are spoken). */
  onDraw?: (ops: DrawOp[], anchor: DrawAnchor) => void;
  /** `speech` (the default): the candidate's words. `continue`: a coach lesson's next move, with no words from the learner. */
  kind?: 'speech' | 'continue';
};

export async function pipelineTurn(sid: string, call: VoiceCall & { seq: number }, text: string, opts: PipelineTurnOptions) {
  const { session, plan } = await pipelineSession(sid);
  const cfg = interviewConfig();
  const { kind, ...rest } = opts;
  const out = kind === 'continue' ? await continueLesson(session.readerId, sid, { ...rest, voice: { epoch: call.epoch } }) : await reply(session.readerId, sid, text, { ...rest, voice: call });
  const current = (await getSession(sid)) ?? session;
  return { turn: out.turn, state: pipelineView(current, plan, cfg, '', false) };
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The start of `full` the learner heard, or null when they heard all of it (or the words do not match). The voice
 * reports the words it played without the reply's own punctuation and spacing, so the match is word by word: `full`
 * is cut after as many words as were heard, when most of them are the same words.
 */
export function heardPart(full: string, heard: string): string | null {
  const said = heard.split(/\s+/).map(norm).filter(Boolean);
  const words = [...full.matchAll(/\S+/g)].filter((m) => norm(m[0]));
  if (!said.length || said.length >= words.length) return null;
  const same = said.filter((w, k) => norm(words[k][0]) === w).length;
  if (same / said.length < 0.7) return null;
  const last = words[said.length - 1];
  return full.slice(0, last.index! + last[0].length);
}

/**
 * The candidate cut the interviewer off: the reply's text is trimmed to the words that played, so
 * the transcript and the next prompt say what was heard (design section 6, "interruptions").
 */
export async function pipelinePlayed(sid: string, call: VoiceCall, spoken: unknown): Promise<void> {
  const cfg = interviewConfig();
  const heard = typeof spoken === 'string' ? spoken.trim() : '';
  await updateSession(sid, cfg.retentionDays, (s) => {
    if (!s.voice?.lease || s.voice.lease.epoch !== call.epoch) return s;
    const i = s.turns.map((t) => t.role).lastIndexOf('interviewer');
    const t = s.turns[i];
    if (!t || !heard) return s;
    // A reply already cut (the stream dropped at the cut-in, reply()) is trimmed further to the words heard.
    const full = t.meta?.interrupted && t.text.endsWith(' —') ? t.text.slice(0, -2) : t.text;
    const kept = heardPart(full, heard);
    if (kept === null) return s;
    const turns = s.turns.slice();
    // What it drew past the cut never reached the board: the coach reads back only what was heard.
    const { said: _said, ...meta } = t.meta ?? {};
    turns[i] = { ...t, text: `${kept} —`, meta: { ...meta, interrupted: true } };
    return { ...s, turns };
  });
}

/** The pipeline moves the session to the next stage (the candidate asked, or the director did): the opener to speak. */
export async function pipelineAdvance(sid: string, call: VoiceCall, from: unknown): Promise<PipelineView> {
  const { session, plan } = await pipelineSession(sid);
  const cfg = interviewConfig();
  await advance(session.readerId, sid, from, { voice: call });
  const current = (await getSession(sid)) ?? session;
  return pipelineView(current, plan, cfg, current.stageIndex !== session.stageIndex ? lastInterviewer(current.turns) : '', false);
}

/** The candidate has been quiet (the pipeline's silence timer): what the interviewer says, if anything new. */
export async function pipelineIdle(sid: string, call: VoiceCall, rung: unknown): Promise<PipelineView> {
  const { session, plan } = await pipelineSession(sid);
  const cfg = interviewConfig();
  const before = session.turns.length;
  await idle(session.readerId, sid, rung, { voice: call });
  const current = (await getSession(sid)) ?? session;
  const added = current.turns.slice(before).filter((t) => t.role === 'interviewer');
  return pipelineView(current, plan, cfg, added.map((t) => t.text).join(' '), false);
}

export type Heartbeat = {
  /** Cumulative for the pipeline's epoch. */
  sttSeconds: number;
  ttsChars: number;
  /** The pipeline's time in the call's room, cumulative for the epoch (absent from older voice services). */
  roomSeconds?: number;
  /** The speech services the pipeline uses ("flux", "smallest"), for their prices and the session's spend by service. */
  stt?: string;
  tts?: string;
  degraded: string[];
};

const vendor = (v: unknown) => (typeof v === 'string' && /^[a-z0-9_-]{1,20}$/i.test(v) ? v.toLowerCase() : null);

/**
 * Every 15 s from the pipeline: renews the lease, charges the speech since the last one at the
 * vendors' list prices (to the session, the voice day and the interview day), and answers whether
 * the session still takes turns, so the pipeline can wrap up when it doesn't.
 */
export async function pipelineHeartbeat(sid: string, call: VoiceCall, beat: Heartbeat): Promise<{ ok: true; closed: SessionView['closed'] | 'voice_budget' | 'disabled'; endsAt: string }> {
  const { session, plan } = await pipelineSession(sid);
  const cfg = interviewConfig();
  const v = session.voice!;
  if (v.ended || !v.lease || v.lease.epoch !== call.epoch) throw fail('stale_epoch', 409, 'Another pipeline has taken over this session.');
  const stt = Math.max(0, Number(beat.sttSeconds) || 0);
  const tts = Math.max(0, Number(beat.ttsChars) || 0);
  // Usage is cumulative per epoch; the session keeps a running total across epochs.
  const room = Math.max(0, Number(beat.roomSeconds) || 0);
  const seen = v.lease.epochUsage ?? { sttSeconds: 0, ttsChars: 0 };
  const dStt = Math.max(0, stt - seen.sttSeconds);
  const dTts = Math.max(0, tts - seen.ttsChars);
  const dRoom = Math.max(0, room - (seen.roomSeconds ?? 0));
  // Each service at its own price where one is set; the room is billed for both participants, the learner and the pipeline.
  const sttVendor = vendor(beat.stt);
  const ttsVendor = vendor(beat.tts);
  const lines = {
    [sttVendor ? `stt ${sttVendor}` : 'stt']: (dStt / 60) * (cfg.voice.rates[`stt:${sttVendor}`] ?? cfg.voice.sttUsdPerMin),
    [ttsVendor ? `tts ${ttsVendor}` : 'tts']: (dTts / 1000) * (cfg.voice.rates[`tts:${ttsVendor}`] ?? cfg.voice.ttsUsdPer1kChars),
    'daily room': (dRoom / 60) * 2 * cfg.voice.roomUsdPerParticipantMin,
  };
  const usd = Object.values(lines).reduce((a, b) => a + b, 0);
  const degraded = Array.isArray(beat.degraded) ? beat.degraded.filter((d): d is string => typeof d === 'string').slice(0, 4) : [];
  const saved = await updateSession(sid, cfg.retentionDays, (s) => {
    if (!s.voice?.lease || s.voice.lease.epoch !== call.epoch) return s;
    return {
      ...s,
      costUsd: s.costUsd + usd,
      spend: addSpend(s.spend, lines),
      voice: {
        ...s.voice,
        lease: { ...s.voice.lease, at: new Date().toISOString(), epochUsage: { sttSeconds: stt, ttsChars: tts, roomSeconds: room } },
        usage: { ...s.voice.usage, sttSeconds: s.voice.usage.sttSeconds + dStt, ttsChars: s.voice.usage.ttsChars + dTts },
        degraded,
      },
    };
  });
  if (usd > 0) {
    const store = await getStore();
    await Promise.all([store.incrByFloat(voiceSpendKey(), usd * 1e6, 3 * DAY_MS), store.incrByFloat(interviewSpendKey(), usd * 1e6, 3 * DAY_MS)]).catch((err) => console.error('[interview] voice spend:', (err as Error).message));
  }
  const current = saved ?? session;
  // The session's credits, charged for the time so far: a reader out of them is closed on a later beat.
  await meterIfDue(current, plan, cfg);
  let closed: SessionView['closed'] | 'voice_budget' | 'disabled' = closedReason(current, plan, cfg);
  if (!closed) {
    try {
      await checkVoiceCalls(cfg);
    } catch (err) {
      if (err instanceof InterviewError) closed = err.code === 'budget' ? 'voice_budget' : 'disabled';
      else throw err;
    }
  }
  return { ok: true, closed, endsAt: endsAt(current, plan, cfg) };
}

/**
 * The pipeline lets go of the session. `transport`: the candidate's line dropped or the task is
 * stopping (a deploy): parked, the clock stopped, for a rejoin within PARK_MAX_MS. `left`,
 * `ended`, `error`: the voice part is over.
 */
export async function pipelineDetach(sid: string, call: VoiceCall, reason: unknown): Promise<void> {
  const { session } = await pipelineSession(sid);
  const cfg = interviewConfig();
  const v = session.voice!;
  if (v.ended || !v.lease || v.lease.epoch !== call.epoch) return;
  if (reason === 'transport') {
    await updateSession(sid, cfg.retentionDays, (s) => {
      if (!s.voice?.lease || s.voice.lease.epoch !== call.epoch) return s;
      return { ...s, voice: { ...s.voice, lease: null, parked: { at: new Date().toISOString(), stage: s.stageIndex } } };
    });
    console.log(JSON.stringify({ event: 'interview_voice_parked', session: sid, epoch: call.epoch }));
    return;
  }
  await endVoice(session, cfg, typeof reason === 'string' ? reason : 'ended');
}

/** A parked session nobody rejoined within PARK_MAX_MS: the voice part ends (checked when the room reads the session). */
export async function settleVoice(readerId: string, id: string): Promise<void> {
  const session = await getSession(id).catch(() => null);
  const v = session?.voice;
  if (!session || session.readerId !== readerId || !v || v.ended || !v.parked || Date.now() - Date.parse(v.parked.at) < PARK_MAX_MS) return;
  await endVoice(session, interviewConfig(), 'park_expired').catch((err) => console.error('[interview] voice park:', (err as Error).message));
}

/** Before a session is deleted: its pipeline stopped and its Daily room gone (best effort). */
export async function releaseVoiceFor(readerId: string, id: string): Promise<void> {
  const session = await getSession(id).catch(() => null);
  if (!session || session.readerId !== readerId) return;
  await releaseVoice(session);
}

export type { VoiceState };
export { DailyError };
