import type { APIRoute } from 'astro';
import { readerOr503, SLUG } from '../../../lib/server/ask-http';
import { clientIp, isSameOrigin, json, readJson, tooMany } from '../../../lib/server/http';
import { assertAccess, interviewAccess } from '../../../lib/server/interview/access';
import { handle, interviewOff } from '../../../lib/server/interview/http';
import type { PlanScope } from '../../../lib/server/interview/plans';
import { interviewStatus, overview, startSession, type SessionKind } from '../../../lib/server/interview/service';
import { startVoiceSession, voiceStatus } from '../../../lib/server/interview/voice';
import { rateLimit } from '../../../lib/server/rate-limit';
import { drillPage } from '../../../lib/interview.node';

export const prerender = false;

// Mock interview sessions on a system (P3-11, docs/interview/README.md). A 404 in a build without
// PUBLIC_INTERVIEW_ENABLED.
//
//   GET  ?system=<slug>                  status (on or off, sessions left this month), the reader's
//                                        session there that is still running (to resume), past ones
//   POST {system, consent}               starts a session (or returns the running one); consent is
//                                        the consent text's version the reader agreed to
//   POST {system, consent, mode: "voice", audioOptIn}
//                                        starts a voice session (Pro; the voice consent version)
//                                        and its pipeline: {session, join: {url, token, expiresAt}}
//   ?kind=coach / {kind: "coach"}        the same, for a coach lesson on the plan (docs/interview/coach-mode.md):
//                                        the coach teaches the plan's sections and checks them; its own quota
//   ?topic=<slug>[&section=<key>] / {topic, section}
//                                        the same, on a drill (docs/interview/README.md, "Drills"):
//                                        the topic's or one section's short plan. The GET's `page`
//                                        is then the drill's landing-page projection (the system's
//                                        page is prerendered; a drill's comes from here).
// The GET's `voice` is the voice room's state: on or off and why (plan, disabled, budget), and
// the month's voice sessions and minutes left. In early access (an allowlist, access.ts) a reader
// not on it gets `status.enabled: false, reason: 'access'` and 403 `access` on a start.

export type { InterviewStatus, SessionView, VoiceView } from '../../../lib/server/interview/service';
export type { VoiceJoin, VoiceStatus } from '../../../lib/server/interview/voice';

/** A section key as the derivation writes it (a heading's slug). */
const SECTION_KEY = /^[a-z0-9][a-z0-9-]{0,120}$/;

/** The drill the request names, null for the whole interview, or an error when the names are malformed. */
function scopeOf(topic: unknown, section: unknown): PlanScope | Response {
  if (topic === null || topic === undefined || topic === '') return section ? json({ error: 'A section needs its topic' }, 400) : null;
  if (typeof topic !== 'string' || !SLUG.test(topic)) return json({ error: 'Unknown topic' }, 400);
  if (section === null || section === undefined || section === '') return { topic, section: null };
  if (typeof section !== 'string' || !SECTION_KEY.test(section)) return json({ error: 'Unknown section' }, 400);
  return { topic, section };
}

/** The session kind the request names: a mock interview unless it says coach. */
function kindOf(kind: unknown): SessionKind | Response {
  if (kind === null || kind === undefined || kind === '' || kind === 'interview') return 'interview';
  if (kind === 'coach') return 'coach';
  return json({ error: 'Unknown kind' }, 400);
}

export const GET: APIRoute = async (ctx) => {
  const off = interviewOff();
  if (off) return off;
  const system = ctx.url.searchParams.get('system') ?? '';
  if (!SLUG.test(system)) return json({ error: 'Unknown system' }, 400);
  const scope = scopeOf(ctx.url.searchParams.get('topic'), ctx.url.searchParams.get('section'));
  if (scope instanceof Response) return scope;
  const kind = kindOf(ctx.url.searchParams.get('kind'));
  if (kind instanceof Response) return kind;
  const reader = await readerOr503(ctx.cookies);
  if (reader instanceof Response) return reader;
  const limit = await rateLimit(`interview:get:${reader?.documentId ?? clientIp(ctx)}`, 120, 60_000);
  if (!limit.ok) return tooMany(limit.retryAfter, 'Too many requests. Give it a minute.');
  const page = scope ? await drillPage(system, scope.topic, scope.section) : null;
  if (scope && !page) return json({ error: 'There is no drill on that topic or section.' }, 404);
  if (!reader) return json({ signedIn: false, status: await interviewStatus(null), voice: await voiceStatus(null), current: null, past: [], page });
  return handle('overview', async () => {
    const [o, voice, access] = await Promise.all([kind === 'coach' ? overview(reader.documentId, system, scope, 'coach') : overview(reader.documentId, system, scope), voiceStatus(reader), interviewAccess(reader)]);
    const status = access.allowed ? o.status : { ...o.status, enabled: false, reason: 'access' as const };
    return json({ signedIn: true, ...o, status, voice, page });
  });
};

export const POST: APIRoute = async ({ request, url, cookies }) => {
  const off = interviewOff();
  if (off) return off;
  if (!isSameOrigin(request, url)) return json({ error: 'Forbidden' }, 403);
  const reader = await readerOr503(cookies);
  if (reader instanceof Response) return reader;
  if (!reader) return json({ error: 'Sign in to start a mock interview.' }, 401);
  const limit = await rateLimit(`interview:start:${reader.id}`, 10, 60 * 60_000, { failOpen: false });
  if (!limit.ok) return tooMany(limit.retryAfter, 'That’s a lot of new sessions. Try again later.');
  const body = await readJson(request);
  const system = typeof body?.system === 'string' ? body.system : '';
  if (!SLUG.test(system)) return json({ error: 'Unknown system' }, 400);
  const scope = scopeOf(body?.topic, body?.section);
  if (scope instanceof Response) return scope;
  const kind = kindOf(body?.kind);
  if (kind instanceof Response) return kind;
  if (body?.mode === 'voice') {
    return handle('start voice', async () => {
      await assertAccess(reader);
      const { session, join, resumed } = kind === 'coach' ? await startVoiceSession(reader, system, body?.consent, body?.audioOptIn, scope, kind) : await startVoiceSession(reader, system, body?.consent, body?.audioOptIn, scope);
      return json({ session, join, resumed }, resumed ? 200 : 201);
    });
  }
  return handle('start', async () => {
    await assertAccess(reader);
    const { session, resumed } = await startSession(reader.documentId, system, body?.consent, { scope, ...(kind === 'coach' ? { kind } : {}) });
    return json({ session, resumed }, resumed ? 200 : 201);
  });
};
