import Anthropic from '@anthropic-ai/sdk';
import { derivePlans } from '@arrowbox/content-kit';
import { loadContent } from '@arrowbox/content-kit/node';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from './plans';
import { interviewerSystem, replyRequest, SPOKEN_STYLE } from './prompt';

// The voice room's server side (design section 6): a Pro reader's voice session, the Daily room
// and the pipeline it is given (both vendors faked at fetch), the pipeline's lease and turns, its
// heartbeats' charges, parking and rejoining, and what the room may do meanwhile. The store is in
// memory and the Anthropic client stubbed, as in service.test.ts.

const { store } = vi.hoisted(() => {
  const map = new Map<string, string>();
  const store = {
    map,
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => void map.set(k, v),
    setNx: async (k: string, v: string) => (map.has(k) ? false : (map.set(k, v), true)),
    del: async (k: string) => void map.delete(k),
    cas: async (k: string, expected: string, v: string) => (map.get(k) !== expected ? false : (map.set(k, v), true)),
    incr: async (k: string) => {
      const n = Number(map.get(k) ?? 0) + 1;
      map.set(k, String(n));
      return n;
    },
    incrByFloat: async (k: string, delta: number) => {
      const n = Number(map.get(k) ?? 0) + delta;
      map.set(k, String(n));
      return n;
    },
  };
  return { store };
});

const contentDir = fileURLToPath(new URL('../../../../../content', import.meta.url));
const { catalog } = loadContent(contentDir);
const record = catalog.interviews.find((i) => i.system === 'instagram')!;
const login = catalog.topics.find((t) => t.system === 'instagram' && t.slug === 'email-and-password-login')!;
const instagram = catalog.systems.find((s) => s.slug === 'instagram')!;
const derived = derivePlans({ system: instagram, topics: catalog.topics.filter((t) => t.system === 'instagram').map((t) => ({ slug: t.slug, file: t.file, data: t.data })), override: record.data }).system!;
const PLAN: Plan = { system: { slug: 'instagram', name: 'Instagram' }, plan: derived, version: 'plan-v1', briefs: [{ slug: login.slug, title: login.data.title, brief: login.data.tutorBrief! }], scope: null };

vi.mock('../env', async (importOriginal) => ({ ...(await importOriginal<typeof import('../env')>()), isProduction: () => false }));
vi.mock('../store', () => ({ getStore: async () => store }));
vi.mock('./plans', async (importOriginal) => ({ ...(await importOriginal<typeof import('./plans')>()), getPlan: (system: string, scope: unknown = null) => (system === 'instagram' && !scope ? PLAN : null) }));

const gw = await import('../llm-gateway');
const svc = await import('./service');
const voice = await import('./voice');
const { VOICE_CONSENT_VERSION } = await import('./config');
const { voiceMonthKey, voiceMinutesKey, voiceSpendKey, interviewSpendKey, voiceTopupsKey, grantVoiceTopups } = await import('./sessions');
const { mintVoiceToken } = await import('./voice-token');

const SECRET = 'voice-secret-for-tests-0123456789abcdef';
const PRO = { id: 7, documentId: 'readerPro', username: 'ada', email: 'ada@example.com', plan: 'pro', planExpiresAt: null };
const FREE = { id: 8, documentId: 'readerFree', username: 'bob', email: 'bob@example.com', plan: 'free', planExpiresAt: null };
const create = vi.fn();
const stream = vi.fn();

function message(text: string): Anthropic.Beta.BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

// The vendors at fetch: Daily's rooms and tokens, and the voice service's sessions.
type Call = { method: string; url: string; body: Record<string, unknown>; auth: string | null };
const calls: Call[] = [];
let pipelineStatus = 200;
// Whether the voice service still runs a session's pipeline (GET /sessions/:sid).
let pipelineRuns = true;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method: init?.method ?? 'GET', url, body, auth: (init?.headers as Record<string, string>)?.Authorization ?? null });
  if (url.startsWith('https://daily.test/rooms') && init?.method === 'POST') return Response.json({ name: body.name, url: `https://arrowbox.daily.co/${body.name}` });
  if (url.startsWith('https://daily.test/rooms') && init?.method === 'DELETE') return Response.json({ deleted: true });
  if (url.startsWith('https://daily.test/meeting-tokens')) return Response.json({ token: `tok-${body.properties.user_id}` });
  if (url.startsWith('http://voice.test/sessions') && init?.method === 'POST') return pipelineStatus === 200 ? Response.json({ task: 'task-1' }) : new Response('full', { status: pipelineStatus });
  if (url.startsWith('http://voice.test/sessions') && init?.method === 'DELETE') return Response.json({ ok: true });
  if (url.startsWith('http://voice.test/sessions/') && init?.method === 'GET') return pipelineRuns ? Response.json({ running: true, task: 'task-1' }) : new Response('no such session', { status: 404 });
  return new Response('not found', { status: 404 });
});

const ENV = ['INTERVIEW_VOICE_URL', 'INTERVIEW_VOICE_SECRET', 'DAILY_API_KEY', 'DAILY_API_URL', 'INTERVIEW_VOICE_MONTHLY_SESSIONS', 'INTERVIEW_VOICE_MONTHLY_MINUTES', 'INTERVIEW_VOICE_ENABLED', 'INTERVIEW_VOICE_DAILY_BUDGET_USD', 'INTERVIEW_VOICE_MAX_EXCHANGES', 'INTERVIEW_VOICE_SESSION_BUDGET_USD', 'INTERVIEW_EVALUATOR'];
let now = Date.parse('2026-10-23T12:00:00Z');
const tick = (ms: number) => {
  now += ms;
  vi.setSystemTime(now);
};

beforeEach(() => {
  vi.clearAllMocks();
  store.map.clear();
  calls.length = 0;
  pipelineStatus = 200;
  pipelineRuns = true;
  for (const k of ENV) delete process.env[k];
  process.env.INTERVIEW_EVALUATOR = 'false';
  process.env.INTERVIEW_VOICE_URL = 'http://voice.test';
  process.env.INTERVIEW_VOICE_SECRET = SECRET;
  process.env.DAILY_API_KEY = 'daily-key-for-tests-0123456789';
  process.env.DAILY_API_URL = 'https://daily.test';
  create.mockReset();
  create.mockResolvedValue(message('Who are the users, and on which devices?'));
  stream.mockReset();
  gw.setAnthropicClient({ beta: { messages: { create, stream } } } as unknown as Anthropic);
  vi.stubGlobal('fetch', fetchMock);
  tick(60_000);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  svc.resetInterviewSwitchCache();
  voice.resetVoiceSwitchCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const start = (reader = PRO) => voice.startVoiceSession(reader, 'instagram', VOICE_CONSENT_VERSION, false);
const token = (sid: string, uid = PRO.documentId) => mintVoiceToken(SECRET, { uid, sid, planHash: PLAN.version, consentVersion: VOICE_CONSENT_VERSION }, now);
/** A started session with its pipeline attached, as the voice service would. */
async function attached() {
  const { session } = await start();
  const view = await voice.attachPipeline(session.id, token(session.id), 'task-1');
  return { id: session.id, epoch: view.epoch, view };
}

describe('starting a voice session', () => {
  it('needs Pro, the voice consent and the voice switch, then opens a room and a pipeline and counts the month’s session and minutes', async () => {
    await expect(start(FREE)).rejects.toMatchObject({ code: 'plan', status: 403 });
    await expect(voice.startVoiceSession(PRO, 'instagram', 'an-old-version', false)).rejects.toMatchObject({ code: 'consent', detail: { consentVersion: VOICE_CONSENT_VERSION } });
    const { session, join, resumed } = await start();
    expect(resumed).toBe(false);
    expect(session.mode).toBe('voice');
    expect(session.voice).toMatchObject({ live: false, parked: false, ended: false });
    expect(join.url).toBe(`https://arrowbox.daily.co/iv-${session.id}`);
    expect(join.token).toBe(`tok-${session.id}`);
    // The room: private, two seats, no recording; the bot's token; the pipeline, with the attach token and the bot's seat.
    const room = calls.find((c) => c.url.endsWith('/rooms'))!;
    // Its media server in Mumbai, with the voice service and the candidates (DAILY_GEO).
    expect(room.body).toMatchObject({ privacy: 'private', properties: { max_participants: 2, enable_chat: false, geo: 'ap-south-1' } });
    expect(JSON.stringify(room.body)).not.toContain('enable_recording');
    expect(room.auth).toBe('Bearer daily-key-for-tests-0123456789');
    const pipeline = calls.find((c) => c.url === 'http://voice.test/sessions')!;
    expect(pipeline.auth).toBe(`Bearer ${SECRET}`);
    expect(pipeline.body).toMatchObject({ sid: session.id, room: { url: join.url, token: 'tok-bot' }, language: 'en-IN', audioOptIn: false, plannedMinutes: 45 });
    expect(typeof pipeline.body.attach).toBe('string');
    expect(store.map.get(voiceMonthKey(PRO.documentId))).toBe('1');
    expect(store.map.get(voiceMinutesKey(PRO.documentId))).toBe('45');
    // The month's text sessions are not touched.
    expect(store.map.has(`interview:month:${PRO.documentId}:2026-10`)).toBe(false);
  });

  it('enforces the voice quota in sessions and in minutes, and says when the voice room is off or full', async () => {
    process.env.INTERVIEW_VOICE_MONTHLY_SESSIONS = '1';
    const { session } = await start();
    await svc.finish(PRO.documentId, session.id);
    await expect(start()).rejects.toMatchObject({ code: 'quota', status: 429 });
    expect(store.map.get(voiceMonthKey(PRO.documentId))).toBe('1');

    process.env.INTERVIEW_VOICE_MONTHLY_SESSIONS = '5';
    process.env.INTERVIEW_VOICE_MONTHLY_MINUTES = '60';
    await expect(start()).rejects.toMatchObject({ code: 'quota', detail: { resetsAt: '2026-11-01T00:00:00.000Z' } });
    expect(store.map.get(voiceMonthKey(PRO.documentId))).toBe('1');

    delete process.env.INTERVIEW_VOICE_MONTHLY_MINUTES;
    pipelineStatus = 503;
    await expect(start()).rejects.toMatchObject({ code: 'capacity', status: 503 });

    pipelineStatus = 200;
    process.env.INTERVIEW_VOICE_ENABLED = 'false';
    voice.resetVoiceSwitchCache();
    await expect(start()).rejects.toMatchObject({ code: 'disabled' });
    expect(await voice.voiceStatus(PRO)).toMatchObject({ enabled: false, reason: 'disabled' });
    delete process.env.INTERVIEW_VOICE_ENABLED;
    voice.resetVoiceSwitchCache();

    delete process.env.INTERVIEW_VOICE_URL;
    expect(await voice.voiceStatus(PRO)).toMatchObject({ enabled: false, reason: 'unavailable' });
    expect(await voice.voiceStatus(FREE)).toMatchObject({ enabled: false });
  });

  it('tells a reader without Pro so in the status, and counts a Pro reader’s month', async () => {
    expect(await voice.voiceStatus(FREE)).toMatchObject({ enabled: false, reason: 'plan', limit: 5, topups: 0 });
    await start();
    expect(await voice.voiceStatus(PRO)).toMatchObject({ enabled: true, remaining: 4, minutesLeft: 180, topups: 0 });
  });

  it('runs a whole session past the month’s quota on a purchased top-up, reserving no minutes, and refuses when none is left', async () => {
    process.env.INTERVIEW_VOICE_MONTHLY_SESSIONS = '1';
    const first = await start();
    await svc.finish(PRO.documentId, first.session.id);
    await expect(start()).rejects.toMatchObject({ code: 'quota' });

    expect(await grantVoiceTopups(PRO.documentId, 2)).toBe(2);
    expect(await grantVoiceTopups(PRO.documentId, -5)).toBe(0);
    expect(await grantVoiceTopups(PRO.documentId, 1)).toBe(1);
    expect(await voice.voiceStatus(PRO)).toMatchObject({ enabled: true, remaining: 0, topups: 1 });

    const { session, resumed } = await start();
    expect(resumed).toBe(false);
    expect(session.mode).toBe('voice');
    expect(store.map.get(voiceTopupsKey(PRO.documentId))).toBe('0');
    // The month's counters are as the first session left them: a top-up is outside them.
    expect(store.map.get(voiceMonthKey(PRO.documentId))).toBe('1');
    expect(store.map.get(voiceMinutesKey(PRO.documentId))).toBe('45');
    expect(JSON.parse(store.map.get(`interview:session:${session.id}`)!).topup).toBe(true);
    expect(await voice.voiceStatus(PRO)).toMatchObject({ remaining: 0, topups: 0 });

    await svc.finish(PRO.documentId, session.id);
    await expect(start()).rejects.toMatchObject({ code: 'quota', status: 429 });
    expect(store.map.get(voiceTopupsKey(PRO.documentId))).toBe('0');
  });
});

describe('the pipeline', () => {
  it('attaches once per token, with a new epoch, and gets the opener to speak', async () => {
    const { session } = await start();
    const t = token(session.id);
    const view = await voice.attachPipeline(session.id, t, 'task-1');
    expect(view).toMatchObject({ epoch: 1, seq: 0, stageIndex: 0, resumed: false, closed: null, exchangesLeft: 90 });
    expect(view.say).toContain(PLAN.plan.stages[0].opener);
    // The token works once; a forged, foreign or expired one not at all.
    await expect(voice.attachPipeline(session.id, t, 'task-2')).rejects.toMatchObject({ code: 'stale_epoch' });
    await expect(voice.attachPipeline(session.id, token(session.id, 'someone-else'), 'task-2')).rejects.toMatchObject({ code: 'not_found' });
    await expect(voice.attachPipeline(session.id, mintVoiceToken('another-secret-0123456789abcdefghij', { uid: PRO.documentId, sid: session.id, planHash: PLAN.version, consentVersion: VOICE_CONSENT_VERSION }, now), 'x')).rejects.toMatchObject({ code: 'not_found' });
    // While the lease stands, the room's own controls wait.
    const live = await svc.readSession(PRO.documentId, session.id);
    expect(live.voice).toMatchObject({ live: true });
    await expect(svc.reply(PRO.documentId, session.id, 'typed')).rejects.toMatchObject({ code: 'voice_live', status: 409 });
    await expect(svc.advance(PRO.documentId, session.id, 0)).rejects.toMatchObject({ code: 'voice_live' });
    await expect(svc.finish(PRO.documentId, session.id)).rejects.toMatchObject({ code: 'voice_live' });
    // A token older than a minute is dead.
    const old = token(session.id);
    tick(61_000);
    await expect(voice.attachPipeline(session.id, old, 'task-3')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('starts the reply on the words heard before the turn is confirmed, and hands it to the turn that matches', async () => {
    const { id, epoch } = await attached();
    const signals: AbortSignal[] = [];
    stream.mockImplementation((_body: unknown, opts: { signal: AbortSignal }) => {
      signals.push(opts.signal);
      const handlers: Record<string, ((x: unknown) => void)[]> = {};
      return {
        on(event: string, fn: (x: unknown) => void) {
          (handlers[event] ??= []).push(fn);
          return this;
        },
        async finalMessage() {
          for (const t of ['Who are ', 'the users?']) for (const fn of handlers.text ?? []) fn(t);
          return message('Who are the users?');
        },
      };
    });
    // The transcriber's interim words: no capitals, no punctuation.
    expect(await voice.pipelineSpeculate(id, { epoch }, 'mobile web first with a feed and stories')).toEqual({ started: true });
    // The guess's call is made past the gateway's guards, a moment later.
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    const heard: string[] = [];
    const out = await voice.pipelineTurn(id, { epoch, seq: 1 }, 'Mobile web first, with a feed and stories.', { onText: (d) => heard.push(d) });
    expect(stream).toHaveBeenCalledTimes(1); // the guess was the reply
    expect(heard.join('')).toBe('Who are the users?');
    expect(out.turn.text).toBe('Who are the users?');
    const saved = await svc.readSession(PRO.documentId, id);
    expect(saved.turns.at(-2)).toMatchObject({ role: 'candidate', text: 'Mobile web first, with a feed and stories.' });
    // A guess on other words is dropped (its call aborted) and the turn answered afresh.
    expect(await voice.pipelineSpeculate(id, { epoch }, 'then i would add caching')).toEqual({ started: true });
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
    await voice.pipelineTurn(id, { epoch, seq: 2 }, 'Then I would add a queue.', { onText: () => {} });
    // The log tells the two apart: the guess's call is marked speculative, the shelf says what became of it.
    const logged = vi
      .mocked(console.log)
      .mock.calls.map((c) => JSON.parse(String(c[0])) as { event: string; outcome?: string; speculative?: boolean })
      .filter((e) => e.event === 'interview_prefetch' || e.event === 'ask_call')
      .map((e) => (e.event === 'ask_call' ? `call:${e.speculative ? 'guess' : 'turn'}:${e.outcome}` : `shelf:${e.outcome}`));
    expect(logged).toEqual(['call:guess:ok', 'shelf:hit', 'call:guess:ok', 'shelf:mismatch', 'call:turn:ok']);
    expect(stream).toHaveBeenCalledTimes(3);
    expect(signals[1].aborted).toBe(true);
    expect(signals[2].aborted).toBe(false);
    // An old epoch's guess is refused like its turns.
    await expect(voice.pipelineSpeculate(id, { epoch: 0 }, 'hello')).rejects.toMatchObject({ code: 'stale_epoch' });
  });

  it('keeps a turn the candidate cut into as far as it got, and answers the next one at once', async () => {
    const { id, epoch } = await attached();
    let abort: (() => void) | null = null;
    stream.mockImplementation((_body: unknown, opts: { signal: AbortSignal }) => {
      const handlers: Record<string, ((x: unknown) => void)[]> = {};
      return {
        on(event: string, fn: (x: unknown) => void) {
          (handlers[event] ??= []).push(fn);
          return this;
        },
        async finalMessage() {
          for (const fn of handlers.text ?? []) fn('Who are ');
          abort?.(); // the candidate speaks over the first words: the voice service drops the stream
          if (opts.signal.aborted) throw new Error('aborted');
          for (const fn of handlers.text ?? []) fn('the users?');
          return message('Who are the users?');
        },
      };
    });
    const ac = new AbortController();
    abort = () => ac.abort();
    const heard: string[] = [];
    const out = await voice.pipelineTurn(id, { epoch, seq: 1 }, 'Mobile web first.', { signal: ac.signal, onText: (d) => heard.push(d) });
    expect(heard.join('')).toBe('Who are ');
    expect(out.turn).toMatchObject({ text: 'Who are —' });
    let saved = await svc.readSession(PRO.documentId, id);
    expect(saved.turns.slice(-2)).toMatchObject([
      { role: 'candidate', text: 'Mobile web first.' },
      { role: 'interviewer', text: 'Who are —' },
    ]);
    expect(JSON.parse(store.map.get(`interview:session:${id}`)!).turns.at(-1).meta.interrupted).toBe(true);
    // The words that actually played trim it further; the turn counts as answered.
    await voice.pipelinePlayed(id, { epoch }, 'Who');
    saved = await svc.readSession(PRO.documentId, id);
    expect(saved.turns.at(-1)!.text).toBe('Who —');
    expect(JSON.parse(store.map.get(`interview:session:${id}`)!).voice.lease.seq).toBe(1);
    // Cut before any word arrived: the candidate's words stand alone, and the next turn answers both.
    abort = null;
    const ac2 = new AbortController();
    ac2.abort();
    const out2 = await voice.pipelineTurn(id, { epoch, seq: 2 }, 'Also the admins.', { signal: ac2.signal, onText: () => {} });
    expect(out2.turn.text).toBe('');
    saved = await svc.readSession(PRO.documentId, id);
    expect(saved.turns.at(-1)).toMatchObject({ role: 'candidate', text: 'Also the admins.' });
    const out3 = await voice.pipelineTurn(id, { epoch, seq: 3 }, 'And the auditors.', { onText: () => {} });
    expect(out3.turn.text).toBe('Who are the users?');
    expect(JSON.parse(store.map.get(`interview:session:${id}`)!).voice.lease.seq).toBe(3);
  });

  it('answers each spoken turn in sequence, as a voice turn, and refuses an old epoch or a repeated turn', async () => {
    const { id, epoch } = await attached();
    const out = await voice.pipelineTurn(id, { epoch, seq: 1 }, 'Mobile web first, with a feed and stories.', {});
    expect(out.turn.text).toBe('Who are the users, and on which devices?');
    expect(out.state).toMatchObject({ epoch: 1, seq: 1, exchangesLeft: 89 });
    const saved = await svc.readSession(PRO.documentId, id);
    expect(saved.turns.at(-2)).toMatchObject({ role: 'candidate', text: 'Mobile web first, with a feed and stories.' });
    // The candidate's turn is marked as spoken (the transcript tells the grader so).
    const raw = JSON.parse(store.map.get(`interview:session:${id}`)!);
    expect(raw.turns.at(-2).meta.source).toBe('voice');
    expect(raw.voice.usage.exchanges).toBe(1);
    // The same turn again (a dropped response) and a turn out of order are refused without a call.
    create.mockClear();
    await expect(voice.pipelineTurn(id, { epoch, seq: 1 }, 'again', {})).rejects.toMatchObject({ code: 'stale_epoch', detail: { seq: 1 } });
    await expect(voice.pipelineTurn(id, { epoch, seq: 3 }, 'skip', {})).rejects.toMatchObject({ code: 'stale_epoch' });
    await expect(voice.pipelineTurn(id, { epoch: 0, seq: 2 }, 'old', {})).rejects.toMatchObject({ code: 'stale_epoch', detail: { epoch: 1 } });
    expect(create).not.toHaveBeenCalled();
    // A spoken turn may run longer than a typed one.
    await voice.pipelineTurn(id, { epoch, seq: 2 }, 'x'.repeat(3000), {});
    await expect(voice.pipelineTurn(id, { epoch, seq: 3 }, 'x'.repeat(6001), {})).rejects.toMatchObject({ code: 'invalid' });
  });

  it('trims a reply the candidate cut off to the words that played', async () => {
    const { id, epoch } = await attached();
    await voice.pipelineTurn(id, { epoch, seq: 1 }, 'Mobile web first.', {});
    await voice.pipelinePlayed(id, { epoch }, 'Who are the users,');
    const saved = await svc.readSession(PRO.documentId, id);
    expect(saved.turns.at(-1)!.text).toBe('Who are the users, —');
    // Words that never played, or an old epoch, change nothing.
    await voice.pipelinePlayed(id, { epoch }, 'Something else');
    await voice.pipelinePlayed(id, { epoch: 0 }, 'Who');
    expect((await svc.readSession(PRO.documentId, id)).turns.at(-1)!.text).toBe('Who are the users, —');
  });

  it('charges the speech its heartbeats report, to the session and both days, and renews the lease', async () => {
    const { id, epoch } = await attached();
    const a = await voice.pipelineHeartbeat(id, { epoch }, { sttSeconds: 60, ttsChars: 1000, degraded: [] });
    expect(a).toMatchObject({ ok: true, closed: null });
    let raw = JSON.parse(store.map.get(`interview:session:${id}`)!);
    expect(raw.costUsd).toBeCloseTo(0.0077 + 0.03, 6);
    expect(Number(store.map.get(voiceSpendKey()))).toBeCloseTo((0.0077 + 0.03) * 1e6, 0);
    expect(Number(store.map.get(interviewSpendKey()))).toBeCloseTo((0.0077 + 0.03) * 1e6, 0);
    // Cumulative figures: only the difference is charged again.
    await voice.pipelineHeartbeat(id, { epoch }, { sttSeconds: 120, ttsChars: 1000, degraded: ['tts'] });
    raw = JSON.parse(store.map.get(`interview:session:${id}`)!);
    expect(raw.costUsd).toBeCloseTo(2 * 0.0077 + 0.03, 6);
    expect(raw.voice.usage).toMatchObject({ sttSeconds: 120, ttsChars: 1000 });
    expect((await svc.readSession(PRO.documentId, id)).voice).toMatchObject({ degraded: ['tts'] });
    // Past the lease without a heartbeat the room's controls work again; a heartbeat renews it.
    tick(61_000);
    expect((await svc.readSession(PRO.documentId, id)).voice).toMatchObject({ live: false });
    await voice.pipelineHeartbeat(id, { epoch }, { sttSeconds: 120, ttsChars: 1000, degraded: [] });
    expect((await svc.readSession(PRO.documentId, id)).voice).toMatchObject({ live: true });
    // A stale epoch's heartbeat is refused.
    await expect(voice.pipelineHeartbeat(id, { epoch: 0 }, { sttSeconds: 1, ttsChars: 1, degraded: [] })).rejects.toMatchObject({ code: 'stale_epoch' });
  });

  it('tells the pipeline when the session stops taking turns: its exchanges, its budget, or the voice day’s', async () => {
    process.env.INTERVIEW_VOICE_MAX_EXCHANGES = '4';
    const { id, epoch } = await attached();
    for (let seq = 1; seq <= 4; seq++) await voice.pipelineTurn(id, { epoch, seq }, `turn ${seq}`, {});
    expect(await voice.pipelineHeartbeat(id, { epoch }, { sttSeconds: 0, ttsChars: 0, degraded: [] })).toMatchObject({ closed: 'turns' });
    await expect(voice.pipelineTurn(id, { epoch, seq: 5 }, 'one more', {})).rejects.toMatchObject({ code: 'turns' });
    process.env.INTERVIEW_VOICE_DAILY_BUDGET_USD = '0';
    expect(await voice.pipelineHeartbeat(id, { epoch }, { sttSeconds: 0, ttsChars: 0, degraded: [] })).toMatchObject({ closed: 'turns' });
    delete process.env.INTERVIEW_VOICE_MAX_EXCHANGES;
    expect(await voice.pipelineHeartbeat(id, { epoch }, { sttSeconds: 0, ttsChars: 0, degraded: [] })).toMatchObject({ closed: 'voice_budget' });
  });

  it('moves the session on and reports silence through the same director as the text room', async () => {
    const { id, epoch } = await attached();
    const next = await voice.pipelineAdvance(id, { epoch }, 0);
    expect(next.stageIndex).toBe(1);
    expect(next.say).toBe(PLAN.plan.stages[1].opener);
    expect(create).not.toHaveBeenCalled();
    const quiet = await voice.pipelineIdle(id, { epoch }, 35);
    expect(quiet.say).toBe('Take your time.');
    await expect(voice.pipelineAdvance(id, { epoch: 0 }, 1)).rejects.toMatchObject({ code: 'stale_epoch' });
  });
});

describe('parking and ending', () => {
  it('parks the session when the line drops, stops the clock, and credits the wait when a new pipeline attaches', async () => {
    const { id, epoch } = await attached();
    const before = await svc.readSession(PRO.documentId, id);
    await voice.pipelineDetach(id, { epoch }, 'transport');
    let view = await svc.readSession(PRO.documentId, id);
    expect(view.voice).toMatchObject({ live: false, parked: true, ended: false });
    // Meanwhile the candidate may type (the pipeline is gone).
    await svc.reply(PRO.documentId, id, 'I can type while the line is down.');
    tick(4 * 60_000);
    // Rejoining starts a new pipeline (a new attach token) and a new seat; the old epoch is dead.
    calls.length = 0;
    const { join } = await voice.joinVoice(PRO.documentId, id);
    expect(join.token).toBe(`tok-${id}`);
    const pipeline = calls.find((c) => c.url === 'http://voice.test/sessions')!;
    expect(calls.some((c) => c.url.endsWith('/rooms'))).toBe(false);
    const again = await voice.attachPipeline(id, pipeline.body.attach as string, 'task-2');
    expect(again).toMatchObject({ epoch: 2, seq: 1, resumed: true });
    expect(again.say).toMatch(/^Sorry, we lost the line/);
    await expect(voice.pipelineHeartbeat(id, { epoch: 1 }, { sttSeconds: 0, ttsChars: 0, degraded: [] })).rejects.toMatchObject({ code: 'stale_epoch' });
    view = await svc.readSession(PRO.documentId, id);
    expect(view.voice).toMatchObject({ live: true, parked: false });
    expect(Date.parse(view.endsAt) - Date.parse(before.endsAt)).toBe(4 * 60_000);
    expect(view.stagePausedMs).toBe(4 * 60_000);
  });

  it('speaks in a shorter style: the voice turns add the spoken style to the system prompt, text turns do not', () => {
    const text = interviewerSystem(PLAN);
    expect(text).not.toContain('spoken aloud');
    expect(interviewerSystem(PLAN, true)).toBe(text + SPOKEN_STYLE);
    const systemText = (req: ReturnType<typeof replyRequest>) => {
      const block = (req.system as { text: string }[])[0];
      return block ? block.text : '';
    };
    expect(systemText(replyRequest(PLAN, [], { voice: true })).endsWith(SPOKEN_STYLE)).toBe(true);
    expect(systemText(replyRequest(PLAN, []))).toBe(text);
  });

  it('replaces a pipeline the service lost (a crash, a restart) on the next join, inside the lease', async () => {
    const { id } = await attached();
    const before = await svc.readSession(PRO.documentId, id);
    expect(before.voice).toMatchObject({ live: true });
    // Still inside VOICE_LEASE_MS, but the service no longer runs the pipeline: the join parks the
    // session from the last heartbeat and starts a new pipeline, instead of a room with no bot.
    tick(20_000);
    pipelineRuns = false;
    calls.length = 0;
    const { join } = await voice.joinVoice(PRO.documentId, id);
    expect(join.token).toBe(`tok-${id}`);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(expect.arrayContaining([`GET http://voice.test/sessions/${id}`, 'POST http://voice.test/sessions']));
    const view = await svc.readSession(PRO.documentId, id);
    expect(view.voice).toMatchObject({ live: false, parked: true });
    // The clock was paused from the last heartbeat, not from the join.
    const pipeline = calls.find((c) => c.url === 'http://voice.test/sessions')!;
    const again = await voice.attachPipeline(id, pipeline.body.attach as string, 'task-2');
    expect(again).toMatchObject({ epoch: 2, resumed: true });
    expect((await svc.readSession(PRO.documentId, id)).stagePausedMs).toBe(20_000);
    // A pipeline the service confirms is left alone.
    pipelineRuns = true;
    calls.length = 0;
    await voice.joinVoice(PRO.documentId, id);
    expect(calls.some((c) => c.method === 'POST' && c.url === 'http://voice.test/sessions')).toBe(false);
  });

  it('ends the voice part when a park runs out, when the candidate leaves, and with the session', async () => {
    const { id, epoch } = await attached();
    await voice.pipelineDetach(id, { epoch }, 'transport');
    tick(16 * 60_000);
    await voice.settleVoice(PRO.documentId, id);
    let view = await svc.readSession(PRO.documentId, id);
    expect(view.voice).toMatchObject({ ended: true, parked: false, live: false });
    // The clock was credited the whole park (capped), the room was deleted, and no pipeline may attach again.
    expect(view.stagePausedMs).toBe(15 * 60_000);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/rooms/'))).toBe(true);
    await expect(voice.joinVoice(PRO.documentId, id)).rejects.toMatchObject({ code: 'voice_ended' });
    await expect(voice.attachPipeline(id, token(id), 'task-9')).rejects.toMatchObject({ code: 'voice_ended' });
    // Typing and the feedback still work.
    await svc.reply(PRO.documentId, id, 'Carrying on in text.');
    expect((await svc.finish(PRO.documentId, id)).status).toBe('finished');

    const second = await attached();
    calls.length = 0;
    view = (await voice.leaveVoice(PRO.documentId, second.id)) as typeof view;
    expect(view.voice).toMatchObject({ ended: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE http://voice.test/sessions/${second.id}`, `DELETE https://daily.test/rooms/iv-${second.id}`]);
    await expect(voice.pipelineTurn(second.id, { epoch: second.epoch, seq: 1 }, 'hello?', {})).rejects.toMatchObject({ code: 'voice_ended' });
  });

  it('releases the pipeline and the room when the session is deleted', async () => {
    const { id } = await attached();
    calls.length = 0;
    await voice.releaseVoiceFor(PRO.documentId, id);
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
    await voice.releaseVoiceFor('someone-else', id);
    expect(calls).toHaveLength(2);
  });
});

describe('a voice coach lesson (docs/interview/coach-mode.md, phase 2)', () => {
  it('drives itself: the pipeline attaches to a self-drive, asks for each move as a continue, gets its drawing, takes the spoken answer in sequence, and trims a cut move', async () => {
    const { session } = await voice.startVoiceSession(PRO, 'instagram', VOICE_CONSENT_VERSION, false, null, 'coach');
    expect(session).toMatchObject({ kind: 'coach', mode: 'voice' });
    const pipeline = calls.find((c) => c.url === 'http://voice.test/sessions')!;
    expect(pipeline.body).toMatchObject({ kind: 'coach', turnStopSecs: 3 });
    // Nothing to say on attach: the first move is a continue, a beat after the learner joins.
    const view = await voice.attachPipeline(session.id, token(session.id), 'task-1');
    expect(view).toMatchObject({ kind: 'coach', say: '', seq: 0, selfDrive: 1.5, idleRungs: [] });
    const drawn: unknown[] = [];
    create.mockResolvedValueOnce(message('Welcome. We start with who logs in.\n<draw><box label="Client"/><box label="Login service"/><arrow from="Client" to="Login service"/></draw>'));
    const first = await voice.pipelineTurn(session.id, { epoch: view.epoch, seq: -1 }, '', { kind: 'continue', onDraw: (ops) => drawn.push(...ops) });
    expect(first.turn.text).toBe('Welcome. We start with who logs in.');
    expect(first.state).toMatchObject({ seq: 0, exchangesLeft: 90, selfDrive: 1.5 });
    const raw = JSON.parse(store.map.get(`interview:session:${session.id}`)!);
    expect(raw.turns.map((t: { role: string }) => t.role)).toEqual(['event', 'interviewer']);
    // The drawing reaches the pipeline as it is parsed (when the move may draw), and the saved turn carries it too.
    if (raw.turns[0].meta.coach.draw) {
      expect(drawn).toHaveLength(3);
      expect(first.turn.draw).toEqual(drawn);
    } else expect(drawn).toHaveLength(0);
    const [body] = create.mock.calls.at(-1)!;
    expect(body.system[0].text).toContain('You are the coach');
    expect(body.system[0].text).toContain('This lesson is spoken aloud');
    // The learner's words are a spoken turn in sequence, answered by the coach; the lease counts it.
    create.mockResolvedValueOnce(message('Right, phones first.'));
    const spoken = await voice.pipelineTurn(session.id, { epoch: view.epoch, seq: 1 }, 'Mobile web first, on phones.', {});
    expect(spoken.turn.text).toBe('Right, phones first.');
    expect(spoken.state).toMatchObject({ seq: 1, exchangesLeft: 89 });
    const after = JSON.parse(store.map.get(`interview:session:${session.id}`)!);
    expect(after.turns.at(-2)).toMatchObject({ role: 'candidate', text: 'Mobile web first, on phones.', meta: { source: 'voice' } });
    expect(after.voice.usage.exchanges).toBe(1);
    await expect(voice.pipelineTurn(session.id, { epoch: view.epoch, seq: 1 }, 'again', {})).rejects.toMatchObject({ code: 'stale_epoch', detail: { seq: 1 } });
    await expect(voice.pipelineTurn(session.id, { epoch: 0, seq: -1 }, '', { kind: 'continue' })).rejects.toMatchObject({ code: 'stale_epoch' });
    // A move the learner cut into is trimmed to the words that played; the room's own continue waits for the pipeline.
    create.mockResolvedValueOnce(message('Next, the functional requirements: sign in, sign up, and a reset.'));
    await voice.pipelineTurn(session.id, { epoch: view.epoch, seq: -1 }, '', { kind: 'continue' });
    await voice.pipelinePlayed(session.id, { epoch: view.epoch }, 'Next, the functional requirements:');
    const cut = await svc.readSession(PRO.documentId, session.id);
    expect(cut.turns.at(-1)!.text).toBe('Next, the functional requirements: —');
    await expect(svc.continueLesson(PRO.documentId, session.id)).rejects.toMatchObject({ code: 'voice_live' });
    // The voice part over, the lesson goes on typed: the continue works again.
    await voice.leaveVoice(PRO.documentId, session.id);
    create.mockResolvedValueOnce(message('Where were we: the requirements.'));
    expect((await svc.continueLesson(PRO.documentId, session.id)).turn.text).toBe('Where were we: the requirements.');
  });
});
