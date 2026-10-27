import type { APIContext } from 'astro';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The interview API routes (pages/api/interview/): hidden without the build flag, and wired to
// the service when it is on. The service is mocked; service.test.ts covers it.

const reader = { id: 7, documentId: 'doc7', username: 'ada', email: 'ada@example.com' };
const ID = 'a'.repeat(24);
const flags = { interview: false, reviewedOnly: false };

const mocks = {
  getReader: vi.fn(),
  rateLimit: vi.fn(),
  interviewStatus: vi.fn(),
  overview: vi.fn(),
  startSession: vi.fn(),
  readSession: vi.fn(),
  reply: vi.fn(),
  continueLesson: vi.fn(),
  advance: vi.fn(),
  finish: vi.fn(),
  removeSession: vi.fn(),
};

async function routes() {
  vi.resetModules();
  vi.doMock('../../sd', () => ({ FLAGS: flags }));
  vi.doMock('../session', () => ({ getReader: mocks.getReader }));
  vi.doMock('../rate-limit', () => ({ rateLimit: mocks.rateLimit }));
  vi.doMock('./service', async (importOriginal) => {
    const real = await importOriginal<typeof import('./service')>();
    return {
      InterviewError: real.InterviewError,
      learnerName: real.learnerName,
      interviewStatus: mocks.interviewStatus,
      overview: mocks.overview,
      startSession: mocks.startSession,
      readSession: mocks.readSession,
      reply: mocks.reply,
      continueLesson: mocks.continueLesson,
      advance: mocks.advance,
      finish: mocks.finish,
      removeSession: mocks.removeSession,
    };
  });
  // A drill's page projection (docs/README.md, "Drills"): one drill exists, on one topic.
  vi.doMock('../../interview.node', () => ({
    drillPage: vi.fn(async (system: string, topic: string, section: string | null) => (system === 'instagram' && topic === 'login' && section === null ? { scope: 'topic', topic, section, title: 'Login', stages: [] } : null)),
    lessonPage: vi.fn(async (playlist: string, lesson: string) => (playlist === 'frontend-foundations' && lesson === 'box-model' ? { title: 'The box model', stages: [], course: { playlist, lesson, hub: '/coach/frontend-foundations', href: '/coach/frontend-foundations/box-model' } } : null)),
  }));
  vi.doMock('./voice', () => ({
    voiceStatus: vi.fn().mockResolvedValue({ enabled: false, reason: 'unavailable', limit: 0, remaining: 0, minutesLeft: 0, topups: 0, resetsAt: '' }),
    startVoiceSession: vi.fn(),
    settleVoice: vi.fn(),
    releaseVoiceFor: vi.fn(),
  }));
  return { index: await import('../../../pages/api/interview/index'), one: await import('../../../pages/api/interview/[id]') };
}

function ctx(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = new URL(`http://localhost${path}`);
  const init: RequestInit = { method, headers: { origin: 'http://localhost', ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  return { url, request: new Request(url, init), cookies: {}, locals: {}, params: { id: path.split('/')[3]?.split('?')[0] }, clientAddress: '127.0.0.1' } as unknown as APIContext;
}

beforeEach(() => {
  vi.stubEnv('LOG_LEVEL', 'silent');
  for (const m of Object.values(mocks)) m.mockReset();
  flags.interview = false;
  mocks.rateLimit.mockResolvedValue({ ok: true });
  mocks.getReader.mockResolvedValue(reader);
});

describe('with PUBLIC_INTERVIEW_ENABLED off', () => {
  it('every route is a 404 and touches nothing', async () => {
    const { index, one } = await routes();
    const responses = [
      await index.GET(ctx('GET', '/api/interview?system=instagram')),
      await index.POST(ctx('POST', '/api/interview', { system: 'instagram', consent: 'x' })),
      await one.GET(ctx('GET', `/api/interview/${ID}`)),
      await one.POST(ctx('POST', `/api/interview/${ID}`, { action: 'reply', text: 'hi' })),
      await one.DELETE(ctx('DELETE', `/api/interview/${ID}`)),
    ];
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    expect(mocks.getReader).not.toHaveBeenCalled();
    for (const m of [mocks.overview, mocks.startSession, mocks.reply, mocks.removeSession]) expect(m).not.toHaveBeenCalled();
  });
});

describe('with PUBLIC_INTERVIEW_ENABLED on', () => {
  beforeEach(() => {
    flags.interview = true;
  });

  it('GET: the status for a signed-out visitor, the overview for a reader', async () => {
    const { index } = await routes();
    mocks.interviewStatus.mockResolvedValue({ enabled: true });
    mocks.getReader.mockResolvedValueOnce(null);
    const out = await index.GET(ctx('GET', '/api/interview?system=instagram'));
    expect(await out.json()).toMatchObject({ signedIn: false, status: { enabled: true }, current: null });

    mocks.overview.mockResolvedValue({ status: { enabled: true }, current: null, past: [] });
    const res = await index.GET(ctx('GET', '/api/interview?system=instagram'));
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ signedIn: true, past: [] });
    expect(mocks.overview).toHaveBeenCalledWith('doc7', 'instagram', null);
    expect((await index.GET(ctx('GET', '/api/interview?system=../x'))).status).toBe(400);

    // A drill: the overview is the drill's, with its page projection; an unknown drill is a 404, a malformed one a 400.
    const drill = await index.GET(ctx('GET', '/api/interview?system=instagram&topic=login'));
    expect(drill.status).toBe(200);
    expect(await drill.json()).toMatchObject({ signedIn: true, page: { scope: 'topic', topic: 'login', title: 'Login' } });
    expect(mocks.overview).toHaveBeenLastCalledWith('doc7', 'instagram', { topic: 'login', section: null });
    expect((await index.GET(ctx('GET', '/api/interview?system=instagram&topic=login&section=nope'))).status).toBe(404);
    expect((await index.GET(ctx('GET', '/api/interview?system=instagram&topic=../x'))).status).toBe(400);
    expect((await index.GET(ctx('GET', '/api/interview?system=instagram&section=orphan'))).status).toBe(400);
  });

  it('POST start: signed in, same origin, and the service’s errors pass through with their status', async () => {
    const { index } = await routes();
    mocks.getReader.mockResolvedValueOnce(null);
    expect((await index.POST(ctx('POST', '/api/interview', { system: 'instagram' }))).status).toBe(401);
    expect((await index.POST(ctx('POST', '/api/interview', { system: 'instagram' }, { origin: 'https://evil.example' }))).status).toBe(403);

    const { InterviewError } = await import('./service');
    mocks.startSession.mockRejectedValueOnce(new InterviewError('quota', 429, 'Used up.', 3600, { resetsAt: '2026-10-01T00:00:00.000Z' }));
    const refused = await index.POST(ctx('POST', '/api/interview', { system: 'instagram', consent: 'v1' }));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('3600');
    expect(await refused.json()).toMatchObject({ code: 'quota', resetsAt: '2026-10-01T00:00:00.000Z' });

    mocks.startSession.mockResolvedValueOnce({ session: { id: ID }, resumed: false });
    const started = await index.POST(ctx('POST', '/api/interview', { system: 'instagram', consent: 'v1' }));
    expect(started.status).toBe(201);
    expect(mocks.startSession).toHaveBeenLastCalledWith('doc7', 'instagram', 'v1', { scope: null, plan: 'free' });

    // A drill start carries its scope; a malformed one never reaches the service.
    mocks.startSession.mockResolvedValueOnce({ session: { id: ID }, resumed: false });
    expect((await index.POST(ctx('POST', '/api/interview', { system: 'instagram', topic: 'login', section: 'failures', consent: 'v1' }))).status).toBe(201);
    expect(mocks.startSession).toHaveBeenLastCalledWith('doc7', 'instagram', 'v1', { scope: { topic: 'login', section: 'failures' }, plan: 'free' });
    expect((await index.POST(ctx('POST', '/api/interview', { system: 'instagram', topic: 'Bad Topic', consent: 'v1' }))).status).toBe(400);
  });

  it('POST reply streams the interviewer’s words, then the saved turn', async () => {
    const { one } = await routes();
    mocks.reply.mockImplementation(async (_r: string, _id: string, _t: string, opts: { onText?: (d: string) => void }) => {
      opts.onText?.('Why ');
      opts.onText?.('that?');
      return { turn: { role: 'interviewer', text: 'Why that?' }, session: { id: ID } };
    });
    const res = await one.POST(ctx('POST', `/api/interview/${ID}`, { action: 'reply', text: 'A cache.' }, { accept: 'text/event-stream' }));
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: delta\ndata: {"text":"Why "}');
    expect(text).toContain('event: done\ndata: {"turn":{"role":"interviewer","text":"Why that?"}');
    expect(mocks.reply.mock.calls[0].slice(0, 3)).toEqual(['doc7', ID, 'A cache.']);
  });

  it('POST continue streams the coach’s next move the same way (docs/coach-mode.md)', async () => {
    const { one } = await routes();
    mocks.continueLesson.mockImplementation(async (_r: string, _id: string, opts: { onText?: (d: string) => void }) => {
      opts.onText?.('Next, ');
      return { turn: { role: 'interviewer', text: 'Next, the policy service.' }, session: { id: ID, kind: 'coach' } };
    });
    const res = await one.POST(ctx('POST', `/api/interview/${ID}`, { action: 'continue' }, { accept: 'text/event-stream' }));
    const text = await res.text();
    expect(text).toContain('event: delta\ndata: {"text":"Next, "}');
    expect(text).toContain('event: done\ndata: {"turn":{"role":"interviewer","text":"Next, the policy service."}');
    expect(mocks.continueLesson.mock.calls[0].slice(0, 2)).toEqual(['doc7', ID]);
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it('GET and POST take the session kind: a coach lesson has its own overview and start', async () => {
    const { index } = await routes();
    mocks.overview.mockResolvedValue({ status: { enabled: true }, current: null, past: [] });
    expect((await index.GET(ctx('GET', '/api/interview?system=instagram&kind=coach'))).status).toBe(200);
    expect(mocks.overview).toHaveBeenLastCalledWith('doc7', 'instagram', null, 'coach', null);
    expect((await index.GET(ctx('GET', '/api/interview?system=instagram&kind=lecture'))).status).toBe(400);
    mocks.startSession.mockResolvedValue({ session: { id: ID, kind: 'coach' }, resumed: false });
    const res = await index.POST(ctx('POST', '/api/interview', { system: 'instagram', consent: 'v1', kind: 'coach' }));
    expect(res.status).toBe(201);
    expect(mocks.startSession).toHaveBeenCalledWith('doc7', 'instagram', 'v1', { scope: null, plan: 'free', kind: 'coach', name: null });
    // A voice lesson starts as a voice session of the coach kind.
    const { startVoiceSession } = await import('./voice');
    vi.mocked(startVoiceSession).mockResolvedValue({ session: { id: ID, kind: 'coach', mode: 'voice' } as never, join: { url: 'u', token: 't', expiresAt: '' }, resumed: false });
    expect((await index.POST(ctx('POST', '/api/interview', { system: 'instagram', consent: 'v2', kind: 'coach', mode: 'voice' }))).status).toBe(201);
    expect(startVoiceSession).toHaveBeenLastCalledWith(expect.objectContaining({ documentId: 'doc7' }), 'instagram', 'v2', undefined, null, 'coach', null, null);
  });

  it('takes a playlist lesson (docs/coaching.md): the coach’s, on its own, with the lesson’s page', async () => {
    const { index } = await routes();
    mocks.overview.mockResolvedValue({ status: { enabled: true }, current: null, past: [] });
    const got = await index.GET(ctx('GET', '/api/interview?system=frontend-foundations&kind=coach&lesson=box-model'));
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ page: { course: { playlist: 'frontend-foundations', lesson: 'box-model' } } });
    expect(mocks.overview).toHaveBeenLastCalledWith('doc7', 'frontend-foundations', null, 'coach', 'box-model');
    expect((await index.GET(ctx('GET', '/api/interview?system=frontend-foundations&kind=coach&lesson=nope'))).status).toBe(404);
    // Only the coach teaches a lesson, and never as a drill; a malformed slug never reaches the service.
    expect((await index.GET(ctx('GET', '/api/interview?system=frontend-foundations&lesson=box-model'))).status).toBe(400);
    expect((await index.GET(ctx('GET', '/api/interview?system=frontend-foundations&kind=coach&topic=login&lesson=box-model'))).status).toBe(400);
    expect((await index.GET(ctx('GET', '/api/interview?system=frontend-foundations&kind=coach&lesson=../x'))).status).toBe(400);

    mocks.startSession.mockResolvedValue({ session: { id: ID, kind: 'coach' }, resumed: false });
    expect((await index.POST(ctx('POST', '/api/interview', { system: 'frontend-foundations', consent: 'v1', kind: 'coach', lesson: 'box-model' }))).status).toBe(201);
    expect(mocks.startSession).toHaveBeenLastCalledWith('doc7', 'frontend-foundations', 'v1', { scope: null, plan: 'free', kind: 'coach', name: null, lesson: 'box-model' });
    expect((await index.POST(ctx('POST', '/api/interview', { system: 'frontend-foundations', consent: 'v1', lesson: 'box-model' }))).status).toBe(400);
  });

  it('POST advance, finish and DELETE reach the service; unknown actions and ids do not', async () => {
    const { one } = await routes();
    mocks.advance.mockResolvedValue({ stageIndex: 1 });
    mocks.finish.mockResolvedValue({ status: 'finished' });
    mocks.removeSession.mockResolvedValue(undefined);
    expect(await (await one.POST(ctx('POST', `/api/interview/${ID}`, { action: 'advance', from: 0 }))).json()).toEqual({ session: { stageIndex: 1 } });
    expect(mocks.advance).toHaveBeenCalledWith('doc7', ID, 0);
    expect((await one.POST(ctx('POST', `/api/interview/${ID}`, { action: 'finish' }))).status).toBe(200);
    expect((await one.POST(ctx('POST', `/api/interview/${ID}`, { action: 'grade-me' }))).status).toBe(400);
    expect((await one.DELETE(ctx('DELETE', `/api/interview/${ID}`))).status).toBe(200);
    expect(mocks.removeSession).toHaveBeenCalledWith('doc7', ID);
    expect((await one.GET(ctx('GET', '/api/interview/not-an-id'))).status).toBe(404);
  });
});
