import { describe, expect, it, vi } from 'vitest';
import { VoiceCall, type Caption, type VoiceCallbacks, type VoiceClient } from './voice-call';

class FakeClient implements VoiceClient {
  connected: { url: string; token: string } | null = null;
  mic = true;
  disconnects = 0;
  fail: Error | null = null;
  async connect(params: { url: string; token: string }) {
    if (this.fail) throw this.fail;
    this.connected = params;
  }
  async disconnect() {
    this.disconnects += 1;
    this.connected = null;
  }
  enableMic(enable: boolean) {
    this.mic = enable;
  }
  get isMicEnabled() {
    return this.mic;
  }
}

const harness = () => {
  const client = new FakeClient();
  let callbacks!: VoiceCallbacks;
  const states: [string, string | undefined][] = [];
  const captions: Caption[] = [];
  const speaking: (string | null)[] = [];
  const call = new VoiceCall(
    { onState: (s, d) => states.push([s, d]), onCaption: (c) => captions.push(c), onSpeaking: (w) => speaking.push(w) },
    async (cb) => {
      callbacks = cb;
      return client;
    },
  );
  return { client, call, states, captions, speaking, cb: () => callbacks };
};

describe('the voice call', () => {
  it('joins with the room and token the web gave, and is live once the pipeline is ready', async () => {
    const h = harness();
    await h.call.connect({ url: 'https://x.daily.co/iv-a', token: 'tok' });
    expect(h.client.connected).toEqual({ url: 'https://x.daily.co/iv-a', token: 'tok' });
    h.cb().onBotReady();
    expect(h.states).toEqual([['connecting', undefined], ['live', undefined]]);
  });

  it('turns transcripts and spoken text into captions, and says who is speaking', async () => {
    const h = harness();
    await h.call.connect({ url: 'u', token: 't' });
    h.cb().onBotReady();
    h.cb().onUserStartedSpeaking();
    h.cb().onUserTranscript({ text: 'mobile we', final: false });
    h.cb().onUserTranscript({ text: '  ', final: false });
    h.cb().onUserTranscript({ text: 'mobile web first.', final: true });
    h.cb().onUserStoppedSpeaking();
    h.cb().onBotStartedSpeaking();
    h.cb().onBotTtsText({ text: 'Who are the users,' });
    h.cb().onBotTtsText({ text: ' and on which devices?' });
    h.cb().onBotStoppedSpeaking();
    expect(h.captions).toEqual([
      { who: 'you', text: 'mobile we', final: false },
      { who: 'you', text: 'mobile web first.', final: true },
      { who: 'interviewer', text: 'Who are the users,', final: false },
      { who: 'interviewer', text: 'Who are the users, and on which devices?', final: false },
      { who: 'interviewer', text: 'Who are the users, and on which devices?', final: true },
    ]);
    expect(h.speaking).toEqual(['you', null, 'interviewer', null]);
    // The next reply starts a fresh caption.
    h.cb().onBotStartedSpeaking();
    h.cb().onBotTtsText({ text: 'Right.' });
    expect(h.captions.at(-1)).toEqual({ who: 'interviewer', text: 'Right.', final: false });
  });

  it('tells a dropped line from a hang-up, and reports nothing after the hang-up', async () => {
    const h = harness();
    await h.call.connect({ url: 'u', token: 't' });
    h.cb().onBotReady();
    h.cb().onDisconnected();
    expect(h.states.at(-1)).toEqual(['ended', 'dropped']);

    const h2 = harness();
    await h2.call.connect({ url: 'u', token: 't' });
    h2.cb().onBotReady();
    await h2.call.disconnect();
    expect(h2.client.disconnects).toBe(1);
    expect(h2.states.at(-1)).toEqual(['ended', 'hangup']);
    const before = h2.states.length;
    h2.cb().onDisconnected();
    h2.cb().onBotTtsText({ text: 'late' });
    h2.cb().onBotDisconnected();
    expect(h2.states.length).toBe(before);
    expect(h2.captions).toEqual([]);
  });

  it('reports the pipeline leaving, fatal errors, and a connect that fails', async () => {
    const h = harness();
    await h.call.connect({ url: 'u', token: 't' });
    h.cb().onBotReady();
    h.cb().onError({ data: { message: 'minor', fatal: false } });
    expect(h.states.at(-1)).toEqual(['live', undefined]);
    h.cb().onError({ data: { message: 'tts down', fatal: true } });
    expect(h.states.at(-1)).toEqual(['error', 'tts down']);
    h.cb().onBotDisconnected();
    expect(h.states.at(-1)).toEqual(['ended', 'bot']);

    const h2 = harness();
    h2.client.fail = new Error('room full');
    await expect(h2.call.connect({ url: 'u', token: 't' })).rejects.toThrow('room full');
    expect(h2.states).toEqual([['connecting', undefined], ['error', 'room full']]);
  });

  it('mutes and unmutes the microphone', async () => {
    const h = harness();
    expect(h.call.muted).toBe(false);
    await h.call.connect({ url: 'u', token: 't' });
    h.call.setMuted(true);
    expect(h.client.mic).toBe(false);
    expect(h.call.muted).toBe(true);
    h.call.setMuted(false);
    expect(h.call.muted).toBe(false);
    expect(vi.isMockFunction(h.call.setMuted)).toBe(false);
  });
});

describe('the interviewer’s audio', () => {
  // Daily plays nothing itself: the call attaches the remote audio track to a hidden element.
  const dom = () => {
    const el = { autoplay: false, hidden: false, srcObject: null as unknown, attrs: {} as Record<string, string>, played: 0, removed: 0, setAttribute(k: string, v: string) { this.attrs[k] = v; }, play: vi.fn(async function (this: { played: number }) { this.played += 1; }), remove() { this.removed += 1; } };
    const body = { appended: [] as unknown[], appendChild(x: unknown) { this.appended.push(x); } };
    vi.stubGlobal('document', { createElement: () => el, body });
    vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} getTracks() { return this.tracks; } });
    return { el, body };
  };
  const track = (kind: string) => ({ kind }) as MediaStreamTrack;

  it('plays the remote audio track, ignores the candidate’s own and video, and takes the element down with the call', async () => {
    const { el, body } = dom();
    try {
      const h = harness();
      await h.call.connect({ url: 'https://x.daily.co/iv-a', token: 'tok' });
      h.cb().onTrackStarted(track('audio'), { local: true });
      h.cb().onTrackStarted(track('video'), { local: false });
      expect(body.appended).toEqual([]);
      const bot = track('audio');
      h.cb().onTrackStarted(bot, { local: false });
      expect(body.appended).toEqual([el]);
      expect(el.autoplay).toBe(true);
      expect(el.attrs.playsinline).toBe('');
      expect((el.srcObject as { tracks: unknown[] }).tracks).toEqual([bot]);
      expect(el.played).toBe(1);
      // Another remote track (the pipeline rejoined) replaces the stream on the same element.
      const again = track('audio');
      h.cb().onTrackStarted(again, { local: false });
      expect(body.appended).toHaveLength(1);
      expect((el.srcObject as { tracks: unknown[] }).tracks).toEqual([again]);
      h.cb().onTrackStopped(bot, { local: false });
      expect(el.removed).toBe(0);
      await h.call.disconnect();
      expect(el.removed).toBe(1);
      expect(el.srcObject).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves with the client a failed line left behind before joining again, and stops listening to it', async () => {
    const clients: FakeClient[] = [];
    const cbs: VoiceCallbacks[] = [];
    const states: string[] = [];
    const call = new VoiceCall({ onState: (s) => states.push(s), onCaption: () => {}, onSpeaking: () => {} }, async (cb) => {
      cbs.push(cb);
      clients.push(new FakeClient());
      return clients[clients.length - 1];
    });
    await call.connect({ url: 'u', token: 't1' });
    cbs[0].onBotReady();
    cbs[0].onTransportStateChanged('error');
    await call.connect({ url: 'u', token: 't2' });
    // The first client gave its seat back before the second took one.
    expect(clients[0].disconnects).toBe(1);
    expect(clients[1].connected).toEqual({ url: 'u', token: 't2' });
    states.length = 0;
    cbs[0].onBotReady();
    cbs[0].onDisconnected();
    expect(states).toEqual([]);
    cbs[1].onBotReady();
    expect(states).toEqual(['live']);
  });
});
