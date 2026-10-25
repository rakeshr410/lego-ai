import type { APIRoute } from 'astro';
import { getAskContext } from '../../lib/server/ask-context';
import { SLUG } from '../../lib/server/ask-http';
import { countThreads } from '../../lib/server/ask-threads';
import { FLAGS } from '../../lib/sd';
import { isToday, type ProgressSummary } from '../../lib/learner';
import { progressSummary } from '../../lib/server/learner';
import { budget, within } from '../../lib/server/deadline';
import { planOf } from '../../lib/server/entitlements';
import { serverEnv } from '../../lib/server/env';
import { clientIp, json, tooMany } from '../../lib/server/http';
import { askStatus, unavailableStatus, type AskStatus } from '../../lib/server/llm-gateway';
import { logFor } from '../../lib/server/log';
import { rateLimit } from '../../lib/server/rate-limit';
import { getReader, type Reader } from '../../lib/server/session';

export const prerender = false;

// The reader page's one bootstrap call: who is signed in, Ask's status for them, their learning
// progress (with ?today=, their own date; P3-1), and how many
// notes they have on this topic (?system=&topic=), so the page loads the notes themselves
// (GET /api/ask) only when there are some to park or when Ask mode is switched on. Pages call
// it only when the signed-in hint cookie is there, plus once per browser to find sessions from
// before the hint (lib/session-hint.ts); a signed-in answer sets the hint if it was missing.
//
// When Strapi or the store can't be reached this still answers 200, with `degraded: true` and
// what it couldn't find out as null, so reader pages keep working through an outage. It answers
// within BOOTSTRAP_TIMEOUT_MS (default 800 ms) however slow they are: the rate limit fails open,
// a recently verified reader stays signed in while Strapi re-checks them in the background, the
// notes count is cut off, and anything still unknown at the deadline is reported degraded.
//
// In a build without Ask (PUBLIC_ASK_ENABLED off) `ask` and `noteCount` are always null: neither
// is looked up.

export type SessionInfo = {
  /** null: couldn't be checked right now (degraded). */
  signedIn: boolean | null;
  user: { username: string } | null;
  ask: AskStatus | null;
  /** The reader's notes on the requested topic; null when not asked for or unknown. */
  noteCount: number | null;
  /** The reader's learning progress (lib/learner.ts); null when not asked for (no ?today=) or unknown. */
  progress: ProgressSummary | null;
  degraded?: true;
};

const SIGNED_OUT: SessionInfo = { signedIn: false, user: null, ask: null, noteCount: null, progress: null };

async function noteCount(reader: Reader, system: string, topic: string, left: () => number): Promise<number | null> {
  // The topic lookup is shared with other requests (and cached), so it is only waited on; the
  // count is this request's own read and is cut off at the deadline.
  const ctx = await within(getAskContext(system, topic), left(), 'the topic lookup');
  // A page this build doesn't publish, or a topic the CMS doesn't have yet: no notes on it.
  if (!ctx) return 0;
  const ms = left();
  return within(countThreads(reader.documentId, ctx.topicDocumentId, { signal: AbortSignal.timeout(Math.max(1, ms)) }), ms, 'the notes count');
}

export const GET: APIRoute = async (ctx) => {
  const { url, cookies, locals } = ctx;
  const { left } = budget(serverEnv().BOOTSTRAP_TIMEOUT_MS);
  // The limiter fails open when the store is down; a store too slow to answer counts the same.
  const limit = await within(rateLimit(`session:ip:${clientIp(ctx)}`, 120, 60_000), left(), 'the rate limit').catch(() => ({
    ok: true,
    retryAfter: 0,
  }));
  if (!limit.ok) return tooMany(limit.retryAfter);
  const system = url.searchParams.get('system') ?? '';
  const topic = url.searchParams.get('topic') ?? '';
  const scoped = SLUG.test(system) && SLUG.test(topic);

  let reader: Reader | null;
  try {
    // Half the time left for a Strapi re-check, so a reader it can't confirm in time is still
    // answered from the store before the deadline.
    reader = await within(getReader(cookies, { waitMs: left() / 2 }), left(), 'the session check');
  } catch (err) {
    logFor(locals).warn({ err: (err as Error).message }, 'session degraded: could not check the reader');
    return json({ ...SIGNED_OUT, signedIn: null, degraded: true } satisfies SessionInfo);
  }
  if (!reader) return json(SIGNED_OUT);

  const plan = planOf(reader);
  const today = url.searchParams.get('today') ?? '';
  const [ask, count, progress] = await Promise.all([
    !FLAGS.ask
      ? null
      : within(askStatus(reader.documentId, plan), left(), 'Ask status').catch((err: unknown) => {
          logFor(locals).warn({ err: (err as Error).message }, 'session degraded: could not read Ask status');
          return undefined;
        }),
    FLAGS.ask && scoped
      ? noteCount(reader, system, topic, left).catch((err: unknown) => {
          logFor(locals).warn({ err: (err as Error).message }, 'session degraded: could not count notes');
          return undefined;
        })
      : null,
    isToday(today)
      ? within(progressSummary(reader.documentId, today), left(), 'the progress').catch((err: unknown) => {
          logFor(locals).warn({ err: (err as Error).message }, 'session degraded: could not load progress');
          return undefined;
        })
      : null,
  ]);
  const body: SessionInfo = {
    signedIn: true,
    user: { username: reader.username },
    ask: ask === null ? null : (ask ?? unavailableStatus(reader.documentId, plan)),
    noteCount: count ?? null,
    progress: progress ?? null,
  };
  if (ask === undefined || count === undefined || progress === undefined) body.degraded = true;
  return json(body);
};
