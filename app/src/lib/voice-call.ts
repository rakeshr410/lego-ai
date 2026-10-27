// The voice room's call (docs/README.md, "Voice"): the Pipecat browser client over Daily's
// WebRTC transport, reduced to what the room shows. The room gets a state, captions (the
// candidate's words as they are transcribed, the interviewer's as they are spoken) and who is
// speaking; it gives a join (the Daily room and the candidate's token the web minted), mute and
// hang up. The client is built by a factory so the tests can stand one in.

export type VoiceCallState = 'connecting' | 'live' | 'ended' | 'error';
/** Why a call ended: the candidate hung up, the line dropped, or the pipeline left the room. */
export type EndReason = 'hangup' | 'dropped' | 'bot';
export type Caption = { who: 'you' | 'interviewer'; text: string; final: boolean };

export type VoiceCallEvents = {
  onState: (state: VoiceCallState, detail?: EndReason | string) => void;
  onCaption: (caption: Caption) => void;
  onSpeaking: (who: 'you' | 'interviewer' | null) => void;
  /** A message from the pipeline over the call (a coach's drawing: `{kind: 'draw', ops}`; the session's state). */
  onMessage?: (data: unknown) => void;
  /** The interviewer's (or the coach's) words, as they are heard. */
  onWords?: (text: string) => void;
};

/** What the room uses of the Pipecat client. */
export interface VoiceClient {
  connect(params: { url: string; token: string }): Promise<unknown>;
  disconnect(): Promise<void>;
  enableMic(enable: boolean): void;
  readonly isMicEnabled: boolean;
  /** A message to the pipeline over the call (a lesson's new pace: `pace`, {selfDrive}). */
  sendClientMessage?(msgType: string, data?: unknown): void;
}

/** The Pipecat callbacks the call listens to (the client's RTVIEventCallbacks, the subset used). */
export type VoiceCallbacks = {
  onBotReady: () => void;
  onDisconnected: () => void;
  onBotDisconnected: () => void;
  onError: (message: { data?: unknown }) => void;
  onTransportStateChanged: (state: string) => void;
  onUserTranscript: (data: { text: string; final: boolean }) => void;
  onBotTtsText: (data: { text: string }) => void;
  onServerMessage: (data: unknown) => void;
  onBotStartedSpeaking: () => void;
  onBotStoppedSpeaking: () => void;
  onUserStartedSpeaking: () => void;
  onUserStoppedSpeaking: () => void;
  /** A media track began or ended; the interviewer's audio is played from here (Daily plays nothing itself). */
  onTrackStarted: (track: MediaStreamTrack, participant?: { local: boolean }) => void;
  onTrackStopped: (track: MediaStreamTrack, participant?: { local: boolean }) => void;
};

export type ClientFactory = (callbacks: VoiceCallbacks) => Promise<VoiceClient>;

/** The real client: loaded on demand, so the room's chunk carries Daily only when it joins. */
export const pipecatClient: ClientFactory = async (callbacks) => {
  const [{ PipecatClient }, { DailyTransport }] = await Promise.all([import('@pipecat-ai/client-js'), import('@pipecat-ai/daily-transport')]);
  // avoidEval: the room's CSP has no 'unsafe-eval' (security-headers.ts, roomCsp).
  const transport = new DailyTransport({ dailyConfig: { avoidEval: true } });
  return new PipecatClient({ transport, enableMic: true, enableCam: false, callbacks });
};

export class VoiceCall {
  private client: VoiceClient | null = null;
  private hungUp = false;
  /** Which client's callbacks still count: a rejoin's new client silences the one it replaces. */
  private generation = 0;
  private spoken = '';
  /** The interviewer's audio: a hidden element the remote track is attached to (the transport plays nothing itself). */
  private audio: HTMLAudioElement | null = null;

  constructor(
    private readonly events: VoiceCallEvents,
    private readonly factory: ClientFactory = pipecatClient,
  ) {}

  /** Joins the room; resolves once the pipeline says it is ready (or rejects: the room shows why). */
  async connect(join: { url: string; token: string }): Promise<void> {
    // A client left over from a dropped or failed join may still hold a seat in the two-seat room, and
    // the new one would be turned away ("Meeting is full"): it leaves first, and its callbacks go quiet.
    const previous = this.client;
    this.client = null;
    const generation = ++this.generation;
    if (previous) await previous.disconnect().catch(() => {});
    this.hungUp = false;
    this.spoken = '';
    this.events.onState('connecting');
    const client = await this.factory(this.callbacks(generation));
    this.client = client;
    try {
      await client.connect({ url: join.url, token: join.token });
    } catch (err) {
      this.client = null;
      void client.disconnect().catch(() => {});
      this.events.onState('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** The candidate hangs up (or the room unmounts): nothing more is reported for this call. */
  async disconnect(): Promise<void> {
    const client = this.client;
    this.hungUp = true;
    this.client = null;
    this.generation += 1;
    this.detachAudio();
    if (client) await client.disconnect().catch(() => {});
    this.events.onSpeaking(null);
    this.events.onState('ended', 'hangup');
  }

  /** Plays a remote audio track (the interviewer's) through a hidden audio element. */
  private attachAudio(track: MediaStreamTrack): void {
    if (typeof document === 'undefined') return;
    if (!this.audio) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.setAttribute('playsinline', '');
      el.hidden = true;
      document.body.appendChild(el);
      this.audio = el;
    }
    this.audio.srcObject = new MediaStream([track]);
    // The join followed a click, so playback is allowed; if the browser still refuses, say so once.
    this.audio.play().catch((err: unknown) => console.warn('[interview] voice playback:', err instanceof Error ? err.message : String(err)));
  }

  private detachAudio(): void {
    if (!this.audio) return;
    this.audio.srcObject = null;
    this.audio.remove();
    this.audio = null;
  }

  setMuted(muted: boolean): void {
    this.client?.enableMic(!muted);
  }

  /** Tells the pipeline something over the call, if it is on one (nothing is queued for a later join). */
  send(type: string, data: unknown): void {
    try {
      this.client?.sendClientMessage?.(type, data);
    } catch {
      /* not connected yet, or no longer: the pipeline reads the session's state on its next turn */
    }
  }

  get muted(): boolean {
    return this.client ? !this.client.isMicEnabled : false;
  }

  private callbacks(generation: number): VoiceCallbacks {
    const live = () => !this.hungUp && this.client !== null && this.generation === generation;
    return {
      onBotReady: () => {
        if (live()) this.events.onState('live');
      },
      onDisconnected: () => {
        if (!live()) return;
        this.client = null;
        this.events.onSpeaking(null);
        this.events.onState('ended', 'dropped');
      },
      onBotDisconnected: () => {
        if (!live()) return;
        this.events.onSpeaking(null);
        this.events.onState('ended', 'bot');
      },
      onError: (message) => {
        if (!live()) return;
        const data = message.data as { message?: string; fatal?: boolean } | undefined;
        if (data?.fatal) this.events.onState('error', data.message ?? 'error');
      },
      onTransportStateChanged: (state) => {
        if (live() && state === 'error') this.events.onState('error', 'transport');
      },
      onUserTranscript: (data) => {
        if (live() && data.text.trim()) this.events.onCaption({ who: 'you', text: data.text.trim(), final: data.final });
      },
      onServerMessage: (data) => {
        if (live()) this.events.onMessage?.(data);
      },
      onBotTtsText: (data) => {
        if (!live()) return;
        this.spoken = `${this.spoken} ${data.text}`.replace(/\s+/g, ' ').trim();
        this.events.onWords?.(data.text);
        this.events.onCaption({ who: 'interviewer', text: this.spoken, final: false });
      },
      onBotStartedSpeaking: () => {
        if (!live()) return;
        this.spoken = '';
        this.events.onSpeaking('interviewer');
      },
      onBotStoppedSpeaking: () => {
        if (!live()) return;
        if (this.spoken) this.events.onCaption({ who: 'interviewer', text: this.spoken, final: true });
        this.events.onSpeaking(null);
      },
      onUserStartedSpeaking: () => {
        if (live()) this.events.onSpeaking('you');
      },
      onUserStoppedSpeaking: () => {
        if (live()) this.events.onSpeaking(null);
      },
      onTrackStarted: (track, participant) => {
        if (live() && track.kind === 'audio' && !participant?.local) this.attachAudio(track);
      },
      onTrackStopped: (track, participant) => {
        if (track.kind === 'audio' && !participant?.local && this.audio?.srcObject instanceof MediaStream && this.audio.srcObject.getTracks().includes(track)) this.detachAudio();
      },
    };
  }
}
