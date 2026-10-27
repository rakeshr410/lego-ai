import { randomBytes } from 'node:crypto';
import { getStore, type Store } from '../store';

// Interview sessions in the shared store (Redis in production), with the reader's index of them
// and the monthly session counter. A session is one JSON value, changed only by compare-and-set,
// so two web instances (or a double-clicked button) can't overwrite each other's turns. It expires
// INTERVIEW_RETENTION_DAYS after it started (docs/privacy.md): nothing is kept longer.
//
// This is the prototype's store. The design (docs/README.md) moves sessions to the
// interview service's own database; everything goes through this module so that move is local.

import type { DirectorMeta, DirectorState } from './director';

export type TurnRole = 'interviewer' | 'candidate' | 'event';

/**
 * What a turn carries besides its words (ADR 0003): the section it was in, the director's decision
 * on a candidate turn (rendered into the prompt as <director>, so a rebuild reproduces the bytes),
 * idle rungs, and where a scripted line came from. Private: the room gets none of it.
 */
export type TurnMeta = {
  /** The section (`<topic>/<sectionKey>`) the turn belongs to. */
  section?: string;
  director?: DirectorMeta;
  /** The idle rung (seconds) this turn answers. */
  idle?: number;
  /** A scripted interviewer line (an opener, a canned nudge): never a model reply. `voice`: a candidate turn transcribed by the voice service. */
  source?: 'canned' | 'opener' | 'voice';
  /** The candidate interrupted this reply: `text` is cut to the words that played (the voice room). */
  interrupted?: boolean;
  /** Event turns: the stage index a stage marker opens, or the section move it records. */
  stage?: number;
  sectionAdvance?: { from: string; to: string };
  /** The evaluator did not run on this turn (over budget, busy, shut down). */
  evalSkipped?: boolean;
  /** The board as the interviewer saw it with this turn (the whole board or a delta, rendered text), and its version. */
  boardDelta?: string;
  boardSeen?: number;
  /** The matcher's coverage for that board version (design section 7). Private: rendered as questions, never sent to the room. */
  boardCoverage?: import('./board-match').Coverage;
  /** The interviewer's (or the coach's) drawing with this reply (draw.ts), for the room to apply to the board. */
  draw?: import('./draw').DrawOp[];
  /** Why operations of this reply's drawing were dropped (draw.ts); the next turn shows them to the model. */
  drawDropped?: string[];
  /**
   * A coach's reply as the model reads it back: its drawing elements where it wrote them, and the plan's ids the
   * service placed for it where their names come up (draw.ts `readBack`). Without them the model sees its own
   * turns as plain words and stops drawing after the first.
   */
  said?: string;
  /** The coach's decision on a learner turn or a continue (coach.ts), rendered into the prompt as <coach>. */
  coach?: import('./coach').CoachMeta;
  /** A continue: the coach's next move without a learner message (an event turn). */
  continued?: boolean;
  /** The vision fallback's description of a freehand or unlabelled board. */
  boardVision?: string;
};

export type Turn = {
  role: TurnRole;
  /** The stage's key when the turn was sent. */
  stage: string;
  text: string;
  at: string;
  /** Candidate turns: whole minutes into the stage when sent (rendered into the prompt, so kept). */
  minute?: number;
  meta?: TurnMeta;
};

/** 0: not reached or no evidence; 1-4: needs work, developing, solid, strong. */
export type Rating = 0 | 1 | 2 | 3 | 4;

export type Feedback = {
  summary: string;
  stages: { key: string; rating: Rating; strengths: string[]; improvements: string[] }[];
  dimensions: { key: string; rating: Rating; note: string }[];
  nextSteps: string[];
  at: string;
  /** By section (ADR 0003): what to read next. Absent on feedback from before it. */
  sections?: { key: string; rating: Rating }[];
  /** Sections rated 1 or 2 that the candidate reached, and sections never reached. */
  weakAreas?: string[];
  notCovered?: string[];
  /** The grader's verdict per coverage item, quotes verified against the candidate's words. */
  items?: { id: string; section: string; text: string; verdict: 'covered' | 'partial' | 'wrong' | 'missing'; note: string; quote: string }[];
  /** The plan hash the ratings were computed against. */
  rubricVersion?: string;
};

/**
 * The voice room's state on a session (design section 6): the Daily room, the pipeline's fenced
 * lease (a stale epoch is refused with 409), the usage its heartbeats report, and the parks that
 * pause the clock. The web tier is the only writer; the voice service holds none of it.
 */
export type VoiceState = {
  room: { name: string; url: string; expiresAt: string } | null;
  /** The pipeline attached to the session: its epoch (one per attach), the last candidate seq it wrote, and when it last wrote. */
  lease: { epoch: number; seq: number; at: string; task: string; epochUsage?: { sttSeconds: number; ttsChars: number; roomSeconds?: number } } | null;
  /** Attaches so far (the next lease's epoch). */
  epochs: number;
  /** Usage the heartbeats reported, in total; `exchanges` counts interviewer replies (the voice turn cap). */
  usage: { sttSeconds: number; ttsChars: number; exchanges: number };
  /** The transport dropped or the candidate left: the clock is paused until a new pipeline attaches (15 minutes at most). */
  parked: { at: string; stage: number } | null;
  /** Park time so far, added to the session's end and the stage clock. */
  pausedMs: number;
  stagePausedMs: number;
  /** The voice part is over (the candidate ended it, or the session closed): no pipeline may attach again. */
  ended: boolean;
  /** Raw audio kept 7 days for QA (candidate opt-in, design section 9). */
  audioOptIn: boolean;
  /** Degraded vendors the last heartbeat reported ('stt', 'tts'). */
  degraded: string[];
  /** Attach tokens already used (their jti), so a token works once. */
  usedTokens: string[];
};

export type Session = {
  id: string;
  readerId: string;
  system: string;
  /** A drill (docs/README.md, "Drills"): the topic's, or one section's, short plan; absent for the system's whole interview. */
  scope?: { topic: string; section: string | null };
  /** Text (the default) or voice (design section 6): a voice session is spoken through the voice service and graded like a text one. */
  mode?: 'text' | 'voice';
  voice?: VoiceState;
  /** A mock interview (the default) or a coach lesson (docs/coach-mode.md): the coach drives, teaches and checks. */
  kind?: 'interview' | 'coach';
  /** What the coach calls the learner ("So Rakesh, tell me…"), as they gave it at the start (learnerName). */
  learnerName?: string;
  /** A playlist's lesson (docs/coaching.md; `system` is the playlist), and what the learner's earlier lessons left, as the coach is told it. */
  course?: { lesson: string; recall: string[] };
  /** The coach's state (coach sessions). */
  coach?: import('./coach').CoachState;
  /** The learner turned the coach's questions off (the room's toggle): it teaches straight through until they turn them on. */
  coachQuiet?: true;
  /** A whole voice session past the month's quota, paid for by a purchased top-up (no monthly minutes reserved). */
  topup?: true;
  /** The session spends credits (lego-ledger, lib/server/credits.ts): its meter is open there under the session's id. */
  metered?: true;
  /** When the reader's credits run out at the session's rate, once that is near (the ledger's word): the session closes then. */
  creditsEndAt?: string;
  /** The plan's hash when the session started. */
  planVersion: string;
  consent: { version: string; at: string };
  status: 'active' | 'finished';
  startedAt: string;
  stageIndex: number;
  stageStartedAt: string;
  /** The director's memory for the current stage (ADR 0003); absent on sessions from before it. */
  director?: DirectorState;
  /** The director closed the session (the last stage ended): only the feedback can run. */
  closedBy?: 'director';
  /** The derived plan's hash the rubric was pinned to (the plan's version). */
  rubricVersion?: string;
  turns: Turn[];
  candidateTurns: number;
  /**
   * Estimated spend on this session's paid calls so far, in USD: every call that may have been
   * billed, including replies that were stopped, timed out or dropped and so never saved.
   */
  costUsd: number;
  /**
   * The same spend by service, in USD: "claude reply", "claude feedback", ... for the model's calls by kind, "stt flux"
   * and "tts smallest" for the speech services, "daily room" for the call's room. Absent on sessions from before it.
   */
  spend?: Record<string, number>;
  /** Feedback calls that may have been billed (the feedback is retried at most MAX_FEEDBACK_ATTEMPTS times). */
  feedbackAttempts?: number;
  feedback: Feedback | null;
  /** Why finishing produced no feedback (nothing said, or the grader failed), for the room to show. */
  feedbackNote?: string;
  /** The board version the interviewer last read, and its graph (the next delta's base). */
  board?: { seen: number; graph: import('../../board/serialise').BoardGraph | null };
  /** Stages the interviewer has drawn on the board in (one drawing a stage, draw.ts). */
  drawn?: string[];
  /** Text snapshots of the board at stage changes and the finish, for the grader (capped). */
  boardSnapshots?: { stage: string; version: number; text: string; at: string }[];
  /** Board matcher model calls made per stage (capped), and board versions the vision fallback described. */
  boardCalls?: Record<string, number>;
  boardVisionVersions?: number[];
  updatedAt: string;
};

export type SessionIndexEntry = { id: string; system: string; startedAt: string };

const DAY_MS = 24 * 60 * 60 * 1000;
export const ID_PATTERN = /^[a-f0-9]{24}$/;

const sessionKey = (id: string) => `interview:session:${id}`;
/** The evaluator's ledger and live signal (design section 8), deleted and exported with the session. */
export const ledgerKey = (id: string) => `interview:ledger:${id}`;
export const signalKey = (id: string) => `interview:signal:${id}`;
export const evalLockKey = (id: string) => `interview:eval-lock:${id}`;
export const boardKey = (id: string) => `interview:board:${id}`;
export const boardPngKey = (id: string, stage: string) => `interview:board-png:${id}:${stage}`;
/** Every key a session owns besides its own: nothing outlives the session (privacy.md). The board's PNG keys are found through the board record (deleteSessionKeys). */
export const sessionKeys = (id: string) => [ledgerKey(id), signalKey(id), evalLockKey(id), boardKey(id)];

/** Deletes every key a session owns besides its own, the board's PNGs included. */
async function deleteSessionKeys(store: Store, id: string): Promise<void> {
  try {
    const raw = await store.get(boardKey(id));
    const pngs: string[] = raw ? ((JSON.parse(raw) as { pngs?: string[] }).pngs ?? []) : [];
    for (const stage of pngs) await store.del(boardPngKey(id, stage));
  } catch {
    // an unreadable board record still goes with the key below
  }
  for (const key of sessionKeys(id)) await store.del(key);
}
const indexKey = (readerId: string) => `interview:reader:${readerId}`;
const lockKey = (id: string) => `interview:lock:${id}`;
const startLockKey = (readerId: string) => `interview:starting:${readerId}`;
/** Sessions started this calendar month (UTC), per reader. */
export const monthKey = (readerId: string, now = new Date()) => `interview:month:${readerId}:${now.toISOString().slice(0, 7)}`;
/** Drills (topic and section sessions, text or voice) started this calendar month (UTC), per reader: their own, larger quota. */
export const drillMonthKey = (readerId: string, now = new Date()) => `interview:drills:${readerId}:${now.toISOString().slice(0, 7)}`;
/** Coach lessons started this calendar month (UTC), per reader: their own quota. */
export const coachMonthKey = (readerId: string, now = new Date()) => `interview:coach:${readerId}:${now.toISOString().slice(0, 7)}`;
/** Voice sessions started, and voice minutes used, this calendar month (UTC), per reader (Pro only; design section 9). */
export const voiceMonthKey = (readerId: string, now = new Date()) => `interview:voice:month:${readerId}:${now.toISOString().slice(0, 7)}`;
export const voiceMinutesKey = (readerId: string, now = new Date()) => `interview:voice:minutes:${readerId}:${now.toISOString().slice(0, 7)}`;
/**
 * Purchased voice sessions a reader has not used (design section 9): consumed by a whole voice
 * session after the month's quota, never by a drill. Granted by the operator command
 * (`scripts/interview-switch.mjs topups`) until a purchase flow exists; kept for a year from the
 * last change.
 */
export const voiceTopupsKey = (readerId: string) => `interview:voice:topups:${readerId}`;
const TOPUPS_TTL_MS = 366 * 24 * 60 * 60 * 1000;
export const voiceTopups = async (readerId: string): Promise<number> => Math.max(0, Math.floor(Number(await (await getStore()).get(voiceTopupsKey(readerId))) || 0));
/** Adds (or, negative, removes) top-ups; the balance never goes below zero. Returns the balance. */
export async function grantVoiceTopups(readerId: string, count: number): Promise<number> {
  const store = await getStore();
  const next = await store.incrByFloat(voiceTopupsKey(readerId), count, TOPUPS_TTL_MS);
  if (next >= 0) return next;
  await store.incrByFloat(voiceTopupsKey(readerId), -next, TOPUPS_TTL_MS);
  return 0;
}
/** Spends one top-up; false when the reader has none (the balance is left at zero). */
export async function takeVoiceTopup(readerId: string): Promise<boolean> {
  const store = await getStore();
  const left = await store.incrByFloat(voiceTopupsKey(readerId), -1, TOPUPS_TTL_MS);
  if (left >= 0) return true;
  await store.incrByFloat(voiceTopupsKey(readerId), 1, TOPUPS_TTL_MS).catch(() => 0);
  return false;
}
/** Gives back the top-up a start spent and then failed. */
export const refundVoiceTopup = (readerId: string) => grantVoiceTopups(readerId, 1).then(() => {});
/** The interview's own daily spend (micro-dollars), inside the gateway's global one. */
export const interviewSpendKey = (now = new Date()) => `interview:spend:${now.toISOString().slice(0, 10)}`;
/** The voice room's daily spend (micro-dollars), inside the interview's. */
export const voiceSpendKey = (now = new Date()) => `interview:voice-spend:${now.toISOString().slice(0, 10)}`;
export const INTERVIEW_SWITCH_KEY = 'interview:enabled';
export const INTERVIEW_SWITCH_REASON_KEY = 'interview:enabled:reason';
export const VOICE_SWITCH_KEY = 'interview:voice:enabled';
export const VOICE_SWITCH_REASON_KEY = 'interview:voice:enabled:reason';

export const newSessionId = () => randomBytes(12).toString('hex');

/** Gives back one of this month's sessions (a start that was refused or failed), never below 0. */
export const refundMonth = (readerId: string) => refundCount(monthKey(readerId));
/** Gives back a drill the start refused (quota, store failure). */
export const refundDrillMonth = (readerId: string) => refundCount(drillMonthKey(readerId));
/** Gives back a coach lesson the start refused. */
export const refundCoachMonth = (readerId: string) => refundCount(coachMonthKey(readerId));
/** Gives back a voice session the start refused (quota, store failure). */
export const refundVoiceMonth = (readerId: string) => refundCount(voiceMonthKey(readerId));

async function refundCount(key: string): Promise<void> {
  const store = await getStore();
  for (let attempt = 0; attempt < 10; attempt++) {
    const raw = await store.get(key);
    if (raw === null) return;
    if (await store.cas(key, raw, String(Math.max(0, (Number(raw) || 0) - 1)), 40 * DAY_MS)) return;
  }
}

/** Milliseconds a session started at `startedAt` is kept, from now (at least a minute). */
export const ttlFrom = (startedAt: string, retentionDays: number) => Math.max(60_000, Date.parse(startedAt) + retentionDays * DAY_MS - Date.now());

export async function getSession(id: string): Promise<Session | null> {
  if (!ID_PATTERN.test(id)) return null;
  const raw = await (await getStore()).get(sessionKey(id));
  return raw ? (JSON.parse(raw) as Session) : null;
}

/** Changes a session with compare-and-set, re-reading and re-applying `change` on a conflict. */
export async function updateSession(id: string, retentionDays: number, change: (s: Session) => Session | null): Promise<Session | null> {
  const store = await getStore();
  for (let attempt = 0; attempt < 10; attempt++) {
    const raw = await store.get(sessionKey(id));
    if (!raw) return null;
    const next = change(JSON.parse(raw) as Session);
    if (!next) return null;
    next.updatedAt = new Date().toISOString();
    if (await store.cas(sessionKey(id), raw, JSON.stringify(next), ttlFrom(next.startedAt, retentionDays))) return next;
  }
  throw new Error('could not update the interview session (contention)');
}

async function updateJson<T>(store: Store, key: string, ttlMs: number, change: (v: T | null) => T): Promise<T> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const raw = await store.get(key);
    const next = JSON.stringify(change(raw ? (JSON.parse(raw) as T) : null));
    const ok = raw === null ? await store.setNx(key, next, ttlMs) : await store.cas(key, raw, next, ttlMs);
    if (ok) return JSON.parse(next) as T;
  }
  throw new Error(`could not update ${key.split(':').slice(0, 2).join(':')} (contention)`);
}

/** Stores a new session and adds it to the reader's index. */
export async function createSession(session: Session, retentionDays: number): Promise<void> {
  const store = await getStore();
  const ttl = ttlFrom(session.startedAt, retentionDays);
  if (!(await store.setNx(sessionKey(session.id), JSON.stringify(session), ttl))) throw new Error('interview session id collision');
  await updateJson<SessionIndexEntry[]>(store, indexKey(session.readerId), retentionDays * DAY_MS, (list) => [
    ...(list ?? []),
    { id: session.id, system: session.system, startedAt: session.startedAt },
  ]);
}

/** The reader's sessions that still exist (expired ones drop out of the index as they are read). */
export async function listSessions(readerId: string): Promise<Session[]> {
  const store = await getStore();
  const raw = await store.get(indexKey(readerId));
  const entries = raw ? (JSON.parse(raw) as SessionIndexEntry[]) : [];
  const sessions = (await Promise.all(entries.map((e) => getSession(e.id)))).filter((s): s is Session => !!s && s.readerId === readerId);
  return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Deletes one session and its index entry. */
export async function deleteSession(session: Pick<Session, 'id' | 'readerId'>, retentionDays: number): Promise<void> {
  const store = await getStore();
  await store.del(sessionKey(session.id));
  await deleteSessionKeys(store, session.id);
  await updateJson<SessionIndexEntry[]>(store, indexKey(session.readerId), retentionDays * DAY_MS, (list) => (list ?? []).filter((e) => e.id !== session.id));
}

/** Deletes every session of a reader (account deletion). Returns how many there were. */
export async function deleteReaderSessions(readerId: string): Promise<number> {
  const store = await getStore();
  const raw = await store.get(indexKey(readerId));
  const entries = raw ? (JSON.parse(raw) as SessionIndexEntry[]) : [];
  for (const e of entries) {
    await store.del(sessionKey(e.id));
    await deleteSessionKeys(store, e.id);
  }
  await store.del(indexKey(readerId));
  return entries.length;
}

/**
 * Holds a session for one paid call at a time (a reply or the feedback), across instances.
 * Returns the release function, or null when another call holds it.
 */
export const lockSession = (id: string, ttlMs: number) => lock(lockKey(id), ttlMs);

/**
 * Holds a reader's session starts, so the check for a running session and the creation of a new
 * one happen as one step (two starts at once can't open two sessions). Returns the release
 * function, or null when another start holds it.
 */
export const lockReaderStart = (readerId: string, ttlMs: number) => lock(startLockKey(readerId), ttlMs);

async function lock(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
  const store = await getStore();
  const token = randomBytes(8).toString('hex');
  if (!(await store.setNx(key, token, ttlMs))) return null;
  return async () => {
    // Only our own lock: after its TTL another holder may have a new one.
    if ((await store.get(key)) === token) await store.del(key);
  };
}

/** A session's spend by service with `usd` added to each line (lines of nothing are left out). */
export function addSpend(spend: Record<string, number> | undefined, usd: Record<string, number>): Record<string, number> {
  const out = { ...spend };
  for (const [line, v] of Object.entries(usd)) if (v > 0) out[line] = (out[line] ?? 0) + v;
  return out;
}

/** Every session in the store, for a report (scripts/session-costs.ts): a scan, never on a request's path. */
export async function allSessions(): Promise<Session[]> {
  const store = await getStore();
  if (!store.keys) return [];
  const out: Session[] = [];
  for (const key of await store.keys('interview:session:')) {
    const raw = await store.get(key);
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw) as Session);
    } catch {
      // an unreadable record is left out of the report
    }
  }
  return out;
}
