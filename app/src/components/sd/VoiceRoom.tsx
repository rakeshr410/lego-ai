import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import t from '../../i18n/messages/interview';
import type { DrawOp } from '../../lib/server/interview/draw';
import type { PenCueMessage } from '../../lib/board/pen/cues';
import type { SessionView, VoiceJoin } from '../../pages/api/interview/index';
import { VoiceCall, type Caption } from '../../lib/voice-call';

// The voice part of a voice session (docs/README.md, "Voice"; design section 6), in the
// room where the answer box would be. It joins the session's Daily room with the token the web
// minted (a fresh one from POST [id]/voice when it has none), shows the line's state, who is
// speaking and live captions, and offers mute and "switch to typing". The pipeline, not this
// component, runs the conversation: the transcript it saves arrives through the session, which
// the room refreshes while the line is up. A dropped line rejoins by itself (the server parks the
// session and stops the clock); after a few failures the candidate retries by hand.

type Props = {
  sessionId: string;
  /** The join the start answered with, or null (resumed, reloaded): the room asks for one. */
  join: VoiceJoin | null;
  session: SessionView;
  onSession: (s: SessionView) => void;
  onLeft: (s: SessionView) => void;
  /**
   * 'panel' (the default): a bar where the answer box would be. 'call' (design 17a): the call
   * room's column, the interviewer's and the candidate's tiles and the transcript.
   */
  layout?: 'panel' | 'call';
  /** The call column's transcript is open (the header's CC toggles it). */
  showTranscript?: boolean;
  onHideTranscript?: () => void;
  /** A mock interview (the default) or a coach lesson: who the bot is called. */
  kind?: 'interview' | 'coach';
  /** A drawing the pipeline sends over the call (a coach's, as it speaks): for the room's board; `pace` names it in the voice's cues. */
  onDraw?: (ops: DrawOp[], pace?: string, instant?: boolean) => void;
  /** A voice cue for the board's pen (voice/bot/conductor.py); a `release` too when the call stops being live. */
  onPen?: (cue: PenCueMessage) => void;
  /** The voice started or stopped talking, and its words as they are heard (the pen hovers over what they name). */
  onVoice?: (e: { speaking: boolean } | { words: string }) => void;
  /** The call layout's syllabus rail (a lesson), under the speakers. */
  rail?: ReactNode;
  /** A lesson's new wait before its next move (the questions toggle), passed on to the pipeline when it changes. */
  pace?: { selfDrive: number | null; seq: number } | null;
};

/** Five bars that move while the speaker talks. */
function Wave({ on }: { on: boolean }) {
  return (
    <span className={`ivc-wave${on ? ' is-on' : ''}`} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} />
      ))}
    </span>
  );
}

const MicIcon = ({ off }: { off: boolean }) => (
  <svg width="15" height="18" viewBox="0 0 12 14" aria-hidden="true">
    <rect x="3.5" y="1" width="5" height="8" rx="2.5" />
    <path d={off ? 'M1.5 7a4.5 4.5 0 0 0 9 0M6 11.5V13M1 1L11 13' : 'M1.5 7a4.5 4.5 0 0 0 9 0M6 11.5V13'} />
  </svg>
);

type Status = 'joining' | 'connecting' | 'live' | 'reconnecting' | 'lost' | 'leaving' | 'ended';

const REJOIN_ATTEMPTS = 4;
const REJOIN_BASE_MS = 1500;
/**
 * How long the line may sit on "connecting" (joined the room, no pipeline ready) before the room
 * joins again. A reload can land while the previous pipeline is still leaving: the join then
 * finds its lease live and starts no new one, and the bot never comes.
 */
const CONNECT_TIMEOUT_MS = 20_000;
/** How often the saved transcript is fetched while the line is up. */
const REFRESH_MS = 8000;

async function voiceAction(id: string, action: 'join' | 'leave') {
  const res = await fetch(`/api/interview/${id}/voice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
  const data = (await res.json().catch(() => ({}))) as { session?: SessionView; join?: VoiceJoin; error?: string; code?: string };
  return { ok: res.ok, status: res.status, data };
}

export default function VoiceRoom({ sessionId, join: initialJoin, session, onSession, onLeft, layout = 'panel', showTranscript = true, onHideTranscript, kind = 'interview', onDraw, onPen, onVoice, rail = null, pace = null }: Props) {
  const who = t(kind === 'coach' ? 'voice.coach' : 'voice.interviewer');
  const onDrawRef = useRef(onDraw);
  const onPenRef = useRef(onPen);
  const onVoiceRef = useRef(onVoice);
  useEffect(() => {
    onDrawRef.current = onDraw;
    onPenRef.current = onPen;
    onVoiceRef.current = onVoice;
  });
  const [status, setStatus] = useState<Status>('joining');
  const [detail, setDetail] = useState('');
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState<'you' | 'interviewer' | null>(null);
  const [captions, setCaptions] = useState<{ you: Caption | null; interviewer: Caption | null }>({ you: null, interviewer: null });
  const callRef = useRef<VoiceCall | null>(null);
  useEffect(() => {
    if (pace) callRef.current?.send('pace', { selfDrive: pace.selfDrive });
  }, [pace]);
  const linesRef = useRef<HTMLDivElement>(null);
  const joinRef = useRef<VoiceJoin | null>(initialJoin);
  const attemptsRef = useRef(0);
  const aliveRef = useRef(true);
  const statusRef = useRef<Status>('joining');
  const set = useCallback((s: Status) => {
    // A call that stops being live sends no more cues: the pen draws what it waits on at its own pace.
    if (statusRef.current === 'live' && s !== 'live') onPenRef.current?.({ at: 'release' });
    statusRef.current = s;
    setStatus(s);
  }, []);

  // The rejoin and the call's callbacks are plain functions over refs, declared before connect
  // (which they reach through connectRef) so the compiler sees no use before declaration.
  const connectRef = useRef<((fresh: boolean) => Promise<void>) | null>(null);
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rejoinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRejoin = () => {
    if (connectTimer.current) clearTimeout(connectTimer.current);
    connectTimer.current = null;
    // One failure is reported twice (the call's error state and connect's catch): one rejoin for both.
    if (rejoinTimer.current) return;
    attemptsRef.current += 1;
    if (attemptsRef.current > REJOIN_ATTEMPTS) {
      set('lost');
      return;
    }
    set('reconnecting');
    rejoinTimer.current = setTimeout(() => {
      rejoinTimer.current = null;
      void connectRef.current?.(true);
    }, REJOIN_BASE_MS * attemptsRef.current);
  };

  function onCallState(state: 'connecting' | 'live' | 'ended' | 'error', why?: string) {
    if (!aliveRef.current) return;
    if (state === 'live') {
      if (connectTimer.current) clearTimeout(connectTimer.current);
      connectTimer.current = null;
      attemptsRef.current = 0;
      setDetail('');
      set('live');
    } else if (state === 'ended' && why === 'hangup') {
      // The candidate's own leave or the room going away: nothing to do.
    } else if (state === 'ended' || state === 'error') {
      if (statusRef.current === 'leaving' || statusRef.current === 'ended') return;
      setDetail(state === 'error' ? (why ?? '') : '');
      // The pipeline left (closed session, stale epoch): a join tells us whether the voice part is over.
      scheduleRejoin();
    }
  }

  function onMessage(data: unknown) {
    const m = data as { kind?: unknown; ops?: unknown; pace?: unknown; instant?: unknown; at?: unknown } | null;
    if (m?.kind === 'draw' && Array.isArray(m.ops)) onDrawRef.current?.(m.ops as DrawOp[], typeof m.pace === 'string' ? m.pace : undefined, m.instant === true);
    else if (m?.kind === 'pen' && (m.at === 'shape' || m.at === 'write' || m.at === 'release')) onPenRef.current?.(m as PenCueMessage);
  }

  function onSpeakingChange(who: 'you' | 'interviewer' | null) {
    setSpeaking(who);
    onVoiceRef.current?.({ speaking: who === 'interviewer' });
  }

  function onCaption(c: Caption) {
    setCaptions((prev) => (c.who === 'you' ? { ...prev, you: c } : { ...prev, interviewer: c }));
  }

  const connect = useCallback(
    async (fresh: boolean) => {
      if (!aliveRef.current) return;
      try {
        if (fresh || !joinRef.current || Date.parse(joinRef.current.expiresAt) < Date.now() + 10_000) {
          set(attemptsRef.current ? 'reconnecting' : 'joining');
          const r = await voiceAction(sessionId, 'join');
          if (!aliveRef.current) return;
          if (!r.ok || !r.data.join) {
            if (r.data.session) onSession(r.data.session);
            if (r.data.session?.voice?.ended) {
              set('ended');
              return;
            }
            throw new Error(r.data.error ?? t('error.voice'));
          }
          joinRef.current = r.data.join;
          if (r.data.session) onSession(r.data.session);
        }
        if (attemptsRef.current === 0) set('connecting');
        const call = callRef.current ?? new VoiceCall({ onState: onCallState, onCaption, onSpeaking: onSpeakingChange, onMessage, onWords: (words) => onVoiceRef.current?.({ words }) });
        callRef.current = call;
        await call.connect(joinRef.current);
        call.setMuted(muted);
        // Joined, but no pipeline said it is ready: hang up and join again (a fresh join starts one).
        if (connectTimer.current) clearTimeout(connectTimer.current);
        connectTimer.current = setTimeout(() => {
          connectTimer.current = null;
          if (!aliveRef.current || statusRef.current !== 'connecting' || callRef.current !== call) return;
          callRef.current = null;
          void call.disconnect();
          scheduleRejoin();
        }, CONNECT_TIMEOUT_MS);
      } catch (err) {
        if (!aliveRef.current) return;
        setDetail(err instanceof Error ? err.message : String(err));
        scheduleRejoin();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the callbacks below are stable module functions over refs
    [sessionId],
  );

  useEffect(() => {
    connectRef.current = connect;
    aliveRef.current = true;
    // A microtask later: connect's first state change is then not synchronous within the effect.
    void Promise.resolve().then(() => connect(false));
    return () => {
      aliveRef.current = false;
      if (connectTimer.current) clearTimeout(connectTimer.current);
      connectTimer.current = null;
      if (rejoinTimer.current) clearTimeout(rejoinTimer.current);
      rejoinTimer.current = null;
      void callRef.current?.disconnect();
      callRef.current = null;
    };
  }, [connect]);

  // The saved transcript, while the line is up or coming back.
  useEffect(() => {
    if (status !== 'live' && status !== 'reconnecting') return;
    const timer = setInterval(() => {
      void fetch(`/api/interview/${sessionId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { session?: SessionView } | null) => {
          if (!aliveRef.current || !data?.session) return;
          onSession(data.session);
          if (data.session.voice?.ended || data.session.status === 'finished') {
            set('ended');
            void callRef.current?.disconnect();
          }
        })
        .catch(() => {});
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [status, sessionId, onSession, set]);

  const leave = async () => {
    set('leaving');
    await callRef.current?.disconnect();
    const r = await voiceAction(sessionId, 'leave').catch(() => null);
    if (!aliveRef.current) return;
    if (r?.ok && r.data.session) {
      set('ended');
      onLeft(r.data.session);
    } else {
      setDetail(r?.data.error ?? t('error.action'));
      set('lost');
    }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    callRef.current?.setMuted(next);
  };

  const retry = () => {
    if (rejoinTimer.current) clearTimeout(rejoinTimer.current);
    rejoinTimer.current = null;
    attemptsRef.current = 0;
    setDetail('');
    void connect(true);
  };

  const voice = session.voice;
  const line =
    status === 'joining'
      ? t('voice.joining')
      : status === 'connecting'
        ? t('voice.connecting')
        : status === 'live'
          ? speaking === 'you'
            ? t('voice.listening')
            : speaking === 'interviewer'
              ? t('voice.speaking')
              : t('voice.live')
          : status === 'reconnecting'
            ? t('voice.reconnecting')
            : status === 'lost'
              ? t('voice.lost')
              : status === 'leaving'
                ? t('voice.leaving')
                : t('voice.ended');

  // The call column's transcript: the saved turns, then what is being said now (live captions,
  // until the saved transcript catches up).
  const lines = session.turns.filter((turn) => turn.role !== 'event' && turn.text);
  const lastSaved = lines[lines.length - 1]?.text ?? '';
  const live = [captions.interviewer, captions.you].filter((c): c is Caption => !!c && !!c.text && !lastSaved.includes(c.text.slice(0, 40)));
  useEffect(() => {
    const el = linesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, live.length, showTranscript]);

  if (layout === 'call') {
    const ai = status === 'live' && speaking === 'interviewer';
    const you = status === 'live' && speaking === 'you' && !muted;
    return (
      <aside className={`ivc-side is-${status}`} aria-label={t('voice.title')}>
        <div className={`ivc-tile${ai ? ' is-speaking' : ''}`}>
          <div className="ivc-avatar">
            <span className="ivc-face ivc-face--ai">
              <svg width="32" height="28" viewBox="0 0 22 20" aria-hidden="true">
                <rect x="3" y="5" width="16" height="12" rx="3" />
                <circle cx="8.5" cy="11" r="1.4" className="is-dot" />
                <circle cx="13.5" cy="11" r="1.4" className="is-dot" />
                <path d="M11 5V2" />
              </svg>
            </span>
          </div>
          <div className="ivc-tile__foot">
            <span className="ivc-name">
              {who}
              <span className="ivc-badge">{t('call.ai')}</span>
            </span>
            <Wave on={ai} />
          </div>
        </div>
        <div className={`ivc-tile${you ? ' is-speaking' : ''}`}>
          <div className="ivc-avatar">
            <span className="ivc-face ivc-face--you">
              <svg width="30" height="30" viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="7" r="3.5" />
                <path d="M3.5 18C4.5 14 7 12.5 10 12.5S15.5 14 16.5 18" />
              </svg>
            </span>
          </div>
          <div className="ivc-tile__foot">
            <span className="ivc-tile__who">
              <span className="ivc-name">{t('voice.you')}</span>
              {!muted && <Wave on={you} />}
            </span>
            <button type="button" className={`ivc-mute${muted ? ' is-muted' : ''}`} onClick={toggleMute} disabled={status !== 'live'} aria-pressed={muted}>
              <MicIcon off={muted} />
              {muted ? t('voice.unmute') : t('voice.mute')}
            </button>
          </div>
        </div>
        <div className="ivc-status">
          <span className="ivc-status__line" role="status">
            {line}
          </span>
          {detail && (status === 'lost' || status === 'reconnecting') && <span className="ivc-status__detail">{detail}</span>}
          {voice && voice.degraded.length > 0 && status === 'live' && <span className="ivc-status__detail">{t('voice.degraded')}</span>}
          <span className="ivc-status__actions">
            {status === 'lost' && (
              <button type="button" className="ivc-link" onClick={retry}>
                {t('voice.retry')}
              </button>
            )}
            {status !== 'ended' && (
              <button type="button" className="ivc-link" onClick={() => void leave()} disabled={status === 'leaving'}>
                {status === 'leaving' ? t('voice.leaving') : t('voice.leave')}
              </button>
            )}
          </span>
        </div>
        {rail}
        {showTranscript && (
          <section className="ivc-transcript" aria-labelledby="ivc-transcript">
            <div className="ivc-transcript__head">
              <h2 className="ivc-label" id="ivc-transcript">
                {t('call.transcript')}
              </h2>
              <button type="button" className="ivc-close" onClick={onHideTranscript} aria-label={t('call.hideTranscript')}>
                <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M3 3L11 11M11 3L3 11" />
                </svg>
              </button>
            </div>
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the transcript scrolls; keyboard users scroll it once focused */}
            <div className="ivc-lines" ref={linesRef} role="log" aria-label={t('room.log')} tabIndex={0}>
              {lines.map((turn, i) => (
                <p key={`${i}-${turn.at}`} className={`ivc-line ivc-line--${turn.role === 'interviewer' ? 'ai' : 'you'}${i === lines.length - 1 && !live.length ? ' is-last' : ''}`}>
                  <span className="ivc-line__who">{turn.role === 'interviewer' ? who : t('voice.you')}</span>
                  {turn.text}
                </p>
              ))}
              {live.map((c) => (
                <p key={c.who} className={`ivc-line ivc-line--${c.who === 'interviewer' ? 'ai' : 'you'} is-last${c.final ? '' : ' is-interim'}`}>
                  <span className="ivc-line__who">{c.who === 'interviewer' ? who : t('voice.you')}</span>
                  {c.text}
                </p>
              ))}
            </div>
          </section>
        )}
      </aside>
    );
  }

  return (
    <section className={`ivr-voice is-${status}${speaking ? ` is-speaking-${speaking}` : ''}`} aria-label={t('voice.title')}>
      <div className="ivr-voice__bar">
        <span className="ivr-voice__dot" aria-hidden="true" />
        <span className="ivr-voice__state" role="status">
          {line}
        </span>
        <span className="ivr-voice__spacer" />
        {voice && status === 'live' && <span className="ivr-compose__count">{t('voice.exchangesLeft', { count: voice.exchangesLeft })}</span>}
        <button type="button" className={`ivr-btn ivr-btn--small${muted ? ' is-on' : ''}`} onClick={toggleMute} disabled={status !== 'live'} aria-pressed={muted}>
          {muted ? t('voice.unmute') : t('voice.mute')}
        </button>
        {status === 'lost' && (
          <button type="button" className="ivr-btn ivr-btn--small" onClick={retry}>
            {t('voice.retry')}
          </button>
        )}
        {status !== 'ended' && (
          <button type="button" className="ivr-btn ivr-btn--small" onClick={() => void leave()} disabled={status === 'leaving'}>
            {status === 'leaving' ? t('voice.leaving') : t('voice.leave')}
          </button>
        )}
      </div>
      {(captions.interviewer || captions.you) && (
        <div className="ivr-voice__captions" aria-live="polite">
          {captions.interviewer && (
            <p className="ivr-voice__caption ivr-voice__caption--interviewer">
              <span className="ivr-msg__who">{who}</span> {captions.interviewer.text}
            </p>
          )}
          {captions.you && (
            <p className={`ivr-voice__caption ivr-voice__caption--you${captions.you.final ? '' : ' is-interim'}`}>
              <span className="ivr-msg__who">{t('voice.you')}</span> {captions.you.text}
            </p>
          )}
        </div>
      )}
      {detail && (status === 'lost' || status === 'reconnecting') && <p className="ivr-voice__detail">{detail}</p>}
      {voice && voice.degraded.length > 0 && status === 'live' && (
        <p className="ivr-voice__detail" role="status">
          {t('voice.degraded')}
        </p>
      )}
      <p className="ivr-card__small">{t('voice.hint')}</p>
    </section>
  );
}
