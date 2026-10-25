import type { InterviewConfig } from './config';

// The web tier's client of the interview-voice service (design section 6, "web → voice"): asks it
// to run a pipeline for a session (it dials the Daily room out and attaches to the session with
// the token), and to stop one. Both carry the shared bearer; the service's own calls back to the
// web (the internal routes) carry the same one. `fetch` is injectable for tests.

export type PipelineStart = {
  sid: string;
  /** The attach token (voice-token.ts) the pipeline hands back on /attach. */
  attach: string;
  room: { url: string; token: string };
  /** The candidate's English: en-IN by default (design: Indian English). */
  language: string;
  audioOptIn: boolean;
  plannedMinutes: number;
  /** A mock interview or a coach lesson: the service names the bot and picks its closing lines by it. */
  kind: 'interview' | 'coach';
  /** The pause that ends the speaker's turn, when the session wants one other than the service's default (a learner thinks aloud). */
  turnStopSecs?: number;
};

export class VoiceServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Voice = InterviewConfig['voice'];
type Opts = { fetch?: typeof fetch };

const call = async (voice: Voice, method: string, path: string, body: unknown, opts: Opts) => {
  if (!voice.url || !voice.secret) throw new VoiceServiceError('The voice service is not configured.', 503);
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${voice.url.replace(/\/$/, '')}${path}`, {
      method,
      headers: { Authorization: `Bearer ${voice.secret}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new VoiceServiceError(`voice service ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`, 503);
  }
  if (!res.ok) throw new VoiceServiceError(`voice service ${method} ${path}: ${res.status}`, res.status);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
};

/** Starts a pipeline for the session; the service answers 503 when it has no slot (capacity). */
export async function startPipeline(voice: Voice, body: PipelineStart, opts: Opts = {}): Promise<{ task: string }> {
  const out = await call(voice, 'POST', '/sessions', body, opts);
  return { task: typeof out.task === 'string' ? out.task : 'unknown' };
}

/**
 * Whether the service still runs the session's pipeline. A lease looks live for VOICE_LEASE_MS after
 * the last heartbeat, but a crashed or restarted service never detaches; the room's rejoin would
 * find no bot and give up inside that minute. False on a 404 or an unreachable service (a new
 * pipeline is started, or the start reports the outage); any other answer trusts the lease.
 */
export async function pipelineRunning(voice: Voice, sid: string, opts: Opts = {}): Promise<boolean> {
  try {
    await call(voice, 'GET', `/sessions/${encodeURIComponent(sid)}`, undefined, opts);
    return true;
  } catch (err) {
    if (err instanceof VoiceServiceError && (err.status === 404 || err.status === 503)) return false;
    return true;
  }
}

/** Stops the session's pipeline, if it is running there (a 404 is fine). */
export async function stopPipeline(voice: Voice, sid: string, opts: Opts = {}): Promise<void> {
  try {
    await call(voice, 'DELETE', `/sessions/${encodeURIComponent(sid)}`, undefined, opts);
  } catch (err) {
    if (err instanceof VoiceServiceError && err.status === 404) return;
    throw err;
  }
}
