import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { InterviewPage } from '../../lib/interview.node';
import { readEvents } from '../../lib/sse';
import tc from '../../i18n/messages/common';
import t from '../../i18n/messages/interview';
import type { SessionView, VoiceJoin } from '../../pages/api/interview/index';
import '../../styles/interview-room.css';
import '../../styles/interview-call.css';
import Logo from '../Logo';
import InterviewFeedback from './InterviewFeedback';
import CoachRail from './CoachRail';
import CoachSummary from './CoachSummary';
import type { BoardHandle } from './InterviewBoard';
import type { DrawOp } from '../../lib/server/interview/draw';
import '../../styles/interview-coach.css';

// The interview room (P3-11, design 10a without voice): the stage bar and clock, the transcript
// (role=log), the whiteboard (InterviewBoard.tsx, in a build with PUBLIC_INTERVIEW_BOARD_ENABLED),
// the answer box, "Next stage" and "End interview", then the written feedback (InterviewFeedback.tsx). The server owns the session: every change comes back as the saved session,
// and the interviewer's reply streams in (server-sent events) before it is saved.

type Props = {
  page: InterviewPage;
  initial: SessionView;
  /** A voice session's join, from the start; null when the room must ask for one (a resume). */
  join?: VoiceJoin | null;
  onExit: () => void;
};

// The whiteboard (InterviewBoard.tsx, and Excalidraw behind it) loads only in a build with
// PUBLIC_INTERVIEW_BOARD_ENABLED: a literal comparison, so Vite drops the import() and its chunks
// from the other builds (the same pattern as Ask mode in Reader.tsx).
const InterviewBoard = import.meta.env.PUBLIC_INTERVIEW_BOARD_ENABLED === 'true' ? lazy(() => import('./InterviewBoard')) : null;
// The voice part (VoiceRoom.tsx, Daily's client behind it) likewise only in a build with
// PUBLIC_INTERVIEW_VOICE_ENABLED.
const VoiceRoom = import.meta.env.PUBLIC_INTERVIEW_VOICE_ENABLED === 'true' ? lazy(() => import('./VoiceRoom')) : null;

type Turn = SessionView['turns'][number];

/** Client-side limit on waiting for a reply (the server's own is shorter). */
const REPLY_TIMEOUT_MS = 90_000;
/** Seconds without typing after the interviewer's last word before the room tells the server (design section 5). */
const IDLE_RUNGS = [20, 35, 60, 120] as const;
/** "Hold on, I'm thinking" suppresses the rungs this long. */
const HOLD_MS = 60_000;
const MAX_CHARS = 2000;
/** A coach lesson goes on by itself after a move that waits for no answer: reading time for the move, within bounds. */
const AUTO_BASE_MS = 4000;
const AUTO_PER_WORD_MS = 180;
const AUTO_MAX_MS = 24_000;

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function post(id: string, body: unknown) {
  const res = await fetch(`/api/interview/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data: data as { session?: SessionView; error?: string } };
}

export default function InterviewRoom({ page, initial, join = null, onExit }: Props) {
  const [session, setSession] = useState(initial);
  const [draft, setDraft] = useState('');
  // A reply on its way: the learner's words (null on a lesson's continue) and the reply so far.
  const [pending, setPending] = useState<{ candidate: string | null; reply: string } | null>(null);
  const [busy, setBusy] = useState<'reply' | 'continue' | 'advance' | 'finish' | 'delete' | null>(null);
  // A coach lesson's auto-continue (docs/interview/coach-mode.md): when the last move landed (0: the
  // lesson has not opened yet, so the first move comes at once), and whether the learner paused it.
  const [armedAt, setArmedAt] = useState<number | null>(() => (initial.kind === 'coach' && initial.turns.length === 0 ? 0 : null));
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [holdUntil, setHoldUntil] = useState(0);
  // The call room (design 17a): its transcript column, and the board's save state for its header.
  const [showTranscript, setShowTranscript] = useState(true);
  const [boardStatus, setBoardStatus] = useState('');
  // since 0 until the first tick resets it (no clock reads during render).
  const idleRef = useRef<{ since: number; sent: number }>({ since: 0, sent: 0 });
  const stopRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const boardRef = useRef<BoardHandle>(null);

  // A session started on an older plan may be past this build's last stage.
  const stage = page.stages[Math.min(session.stageIndex, page.stages.length - 1)];
  const last = session.stageIndex >= page.stages.length - 1;
  const finished = session.status === 'finished';
  const closed = !finished && session.closed;
  const board = InterviewBoard !== null && !finished;
  // A coach lesson: the coach drives (its syllabus rail, Continue), no idle rungs, a summary instead of feedback.
  const coach = session.kind === 'coach';
  const lesson = session.lesson;
  // The voice part is on: the pipeline takes the turns, so the answer box, the idle rungs and
  // "Next stage" wait (the server answers them 409 voice_live meanwhile).
  const voiceOn = VoiceRoom !== null && session.mode === 'voice' && !!session.voice && !session.voice.ended && !finished;

  useEffect(() => {
    if (finished) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [finished]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [session.turns.length, pending?.reply]);

  useEffect(() => () => stopRef.current?.abort(), []);

  // The interviewer's drawings (server/interview/draw.ts): each new interviewer turn's operations
  // go to the board once. The turns on the board already when the room opened are in the scene.
  const drawnRef = useRef(initial.turns.length);
  // While the voice is on, the pipeline sends each drawing over the call as the words are spoken
  // (VoiceRoom's onDraw), so the saved turns are not drawn a second time.
  useEffect(() => {
    const turns = session.turns;
    if (!voiceOn) {
      for (let i = drawnRef.current; i < turns.length; i++) {
        const turn = turns[i];
        if (turn.role === 'interviewer' && turn.draw?.length) boardRef.current?.draw(turn.draw);
      }
    }
    drawnRef.current = turns.length;
  }, [session.turns, initial.turns.length, voiceOn]);

  // The idle clock restarts with every saved turn and every keystroke; a rung posts once.
  useEffect(() => {
    idleRef.current = { since: Date.now(), sent: 0 };
  }, [session.turns.length]);
  useEffect(() => {
    if (coach || finished || closed || busy || draft || voiceOn || now < holdUntil) return;
    if (!idleRef.current.since) idleRef.current.since = now;
    const quiet = (now - idleRef.current.since) / 1000;
    const rung = [...IDLE_RUNGS].reverse().find((r) => quiet >= r && r > idleRef.current.sent);
    if (!rung) return;
    idleRef.current.sent = rung;
    void post(session.id, { action: 'idle', rung }).then((r) => {
      if (r.ok && r.data.session) setSession(r.data.session);
    }).catch(() => {});
  }, [now, finished, closed, busy, draft, holdUntil, voiceOn, coach, session.id]);

  // A voice session's clock stood still while its line was down (stagePausedMs, voice.pausedMs).
  const stageMs = now - Date.parse(session.stageStartedAt) - (session.stagePausedMs ?? 0);
  const plannedEnd = Date.parse(session.startedAt) + session.plannedMinutes * 60_000 + (session.voice?.pausedMs ?? 0);
  const overStage = stage && stageMs >= stage.minutes * 60_000;

  /**
   * The candidate's message and the reply to it, streamed; or, in a lesson, the coach's next move
   * on its own (`continue`, text null). Nothing is saved until the whole reply has arrived.
   */
  const run = async (action: 'reply' | 'continue', text: string | null) => {
    if (busy || closed || finished) return;
    if (action === 'reply' && !text) return;
    setBusy(action);
    setError('');
    setArmedAt(null);
    setPending({ candidate: text, reply: '' });
    if (action === 'reply') setDraft('');
    const controller = new AbortController();
    stopRef.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REPLY_TIMEOUT_MS);
    const restore = (message: string) => {
      setPending(null);
      if (text !== null) setDraft((d) => d || text);
      setError(action === 'continue' ? t('coach.error.continue') : message);
    };
    try {
      // The board as it stands goes with the message.
      await boardRef.current?.flush().catch(() => {});
      const res = await fetch(`/api/interview/${session.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(action === 'reply' ? { action, text } : { action }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body || !res.headers.get('content-type')?.includes('text/event-stream')) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; session?: SessionView };
        if (res.ok && data.session) {
          setSession(data.session);
          setPending(null);
        } else restore(data.error ?? t('error.reply'));
        return;
      }
      let ended = false;
      let drawnLive = false;
      let reply = '';
      for await (const { event, data } of readEvents(res.body)) {
        const d = data as Record<string, unknown>;
        if (event === 'delta' && typeof d.text === 'string') {
          reply += d.text;
          setPending({ candidate: text, reply });
        } else if (event === 'draw' && Array.isArray(d.ops)) {
          // Each drawing lands as its element closes in the stream; the saved turn is not drawn again.
          boardRef.current?.draw(d.ops as DrawOp[]);
          drawnLive = true;
        } else if (event === 'done') {
          ended = true;
          const next = (d as { session: SessionView }).session;
          if (drawnLive) drawnRef.current = next.turns.length;
          setSession(next);
          setPending(null);
          setArmedAt(Date.now());
        } else if (event === 'error') {
          ended = true;
          restore(typeof d.error === 'string' ? d.error : t('error.reply'));
        }
      }
      if (!ended) restore(t('error.cutOff'));
    } catch {
      if (controller.signal.aborted && !timedOut) restore(t('error.stopped'));
      else restore(timedOut ? t('error.slow') : t('error.offline'));
    } finally {
      clearTimeout(timer);
      if (stopRef.current === controller) stopRef.current = null;
      setBusy(null);
      if (action === 'reply') inputRef.current?.focus();
    }
  };
  const sendReply = (e?: FormEvent) => {
    e?.preventDefault();
    return run('reply', draft.trim());
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendReply();
  };

  const act = async (kind: 'advance' | 'finish', body: Record<string, unknown>) => {
    setBusy(kind);
    setError('');
    // The board as the stage leaves it: saved, and a picture for the grader.
    await boardRef.current?.flush().catch(() => {});
    await boardRef.current?.exportStage(stage.key).catch(() => {});
    if (voiceOn && kind === 'finish') {
      // Ending while the voice is on: the voice part goes first (the session is 409 voice_live until it does).
      const left = await fetch(`/api/interview/${session.id}/voice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'leave' }) }).catch(() => null);
      if (!left?.ok) {
        setBusy(null);
        setError(t('error.action'));
        return;
      }
    }
    const r = await post(session.id, body).catch(() => null);
    setBusy(null);
    setConfirmEnd(false);
    if (r?.ok && r.data.session) {
      setSession(r.data.session);
      // A lesson's next part opens with the coach's move.
      if (coach) setArmedAt(Date.now());
    } else setError(r?.data.error ?? t('error.action'));
  };

  const remove = async () => {
    setBusy('delete');
    const res = await fetch(`/api/interview/${session.id}`, { method: 'DELETE' }).catch(() => null);
    setBusy(null);
    if (res?.ok) onExit();
    else setError(t('error.delete'));
  };

  // A lesson opens with the coach's first move, and goes on by itself after each move that waits for
  // no answer (the server says which): reading time for the move from the moment it landed, unless
  // the learner is typing or paused. `armedAt` is set where a turn lands (run, act), never in an effect.
  const lastTurn = session.turns[session.turns.length - 1];
  const autoDelay = !lastTurn ? 0 : lastTurn.role === 'event' ? AUTO_BASE_MS : Math.min(AUTO_MAX_MS, AUTO_BASE_MS + lastTurn.text.split(/\s+/).length * AUTO_PER_WORD_MS);
  const continueAt = coach && armedAt !== null && !finished && !closed && lesson?.waiting === 'continue' && lastTurn?.role !== 'candidate' ? armedAt + autoDelay : null;
  const counting = continueAt !== null && !paused && !draft && !busy;
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    if (!counting) return;
    const timer = setTimeout(() => void runRef.current('continue', null), Math.max(0, continueAt - Date.now()));
    return () => clearTimeout(timer);
  }, [counting, continueAt]);

  const turns: Turn[] = pending
    ? [
        ...session.turns,
        ...(pending.candidate !== null ? [{ role: 'candidate' as const, stage: stage.key, text: pending.candidate, at: '' }] : []),
        ...(pending.reply ? [{ role: 'interviewer' as const, stage: stage.key, text: pending.reply, at: '' }] : []),
      ]
    : session.turns;

  const closedText =
    closed === 'time'
      ? t(coach ? 'coach.room.closed.time' : 'room.closed.time')
      : closed === 'turns'
        ? t(coach ? 'coach.room.closed.turns' : 'room.closed.turns')
        : closed === 'budget'
          ? t(coach ? 'coach.room.closed.budget' : 'room.closed.budget')
          : closed === 'done'
            ? t(coach ? 'coach.room.closed.done' : 'room.closed.done')
            : '';
  const writing = busy === 'reply' || busy === 'continue';
  const who = coach ? t('coach.room.coach') : t('room.interviewer');

  const log = (
    <>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the transcript scrolls; keyboard users scroll it once focused */}
      <div className="ivr-log" ref={logRef} role="log" aria-label={t(coach ? 'coach.room.log' : 'room.log')} aria-live="polite" aria-busy={writing} tabIndex={0}>
        {turns.map((turn, i) =>
          turn.role === 'event' ? (
            <div key={i} className="ivr-event">
              {turn.text.replace(/^\[|\]$/g, '')}
            </div>
          ) : (
            <div key={i} className={`ivr-msg ivr-msg--${turn.role}`}>
              <div className="ivr-msg__who">{turn.role === 'interviewer' ? who : t('room.you')}</div>
              <div className="ivr-msg__text">{turn.text}</div>
            </div>
          ),
        )}
        {writing && !pending?.reply && (
          <div className="ivr-msg ivr-msg--interviewer ivr-msg--typing" aria-label={t(coach ? 'coach.room.writing' : 'room.writing')}>
            <div className="ivr-msg__who">{who}</div>
            <div className="ivr-msg__text">…</div>
          </div>
        )}
      </div>
    </>
  );

  if (voiceOn && VoiceRoom) {
    // Design 17a: the board fills the screen, the speakers and the transcript on the right.
    return (
      <div className="ivc">
        <header className="ivc-top">
          <a href="/" className="ivc-logo">
            <Logo tone="dark" />
          </a>
          <span className="ivc-top__rule" aria-hidden="true" />
          <div className="ivc-top__title">
            <h1>{page.title}</h1>
            <span>{t(coach ? 'coach.call.sub' : 'call.sub', { n: session.stageIndex + 1, total: page.stages.length, stage: stage.title })}</span>
          </div>
          <div className="ivc-top__spacer" />
          <span className="ivc-clock" aria-label={t('room.clock')}>
            <span aria-hidden="true" />
            {t('room.left', { time: clock(plannedEnd - now) })}
          </span>
          {board && boardStatus && (
            <span className="ivc-saved">
              <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true">
                <path d="M1 5L4.5 8.5L11 1.5" />
              </svg>
              {boardStatus}
            </span>
          )}
          <button type="button" className={`ivc-cc${showTranscript ? ' is-on' : ''}`} aria-pressed={showTranscript} onClick={() => setShowTranscript((v) => !v)}>
            <span aria-hidden="true">{t('call.cc')}</span>
            {t('call.transcript')}
          </button>
          {confirmEnd ? (
            <span className="ivc-confirm" role="group" aria-label={t('room.endConfirm')}>
              <button type="button" className="ivc-end" onClick={() => void act('finish', { action: 'finish' })} disabled={!!busy}>
                {busy === 'finish' ? t(coach ? 'coach.room.ending' : 'room.writingFeedback') : t(coach ? 'coach.room.endAndSummary' : 'room.endAndFeedback')}
              </button>
              <button type="button" className="ivc-cc" onClick={() => setConfirmEnd(false)} disabled={!!busy}>
                {t('room.keepGoing')}
              </button>
            </span>
          ) : (
            <button type="button" className="ivc-end" onClick={() => setConfirmEnd(true)} disabled={!!busy}>
              {t('room.end')}
            </button>
          )}
        </header>
        <div className="ivc-body">
          <main className="ivc-stage" id="content" tabIndex={-1}>
            {error && (
              <div className="ivr-error ivc-error" role="alert">
                {error}
              </div>
            )}
            {board && InterviewBoard ? (
              <Suspense fallback={null}>
                <InterviewBoard ref={boardRef} sessionId={session.id} disabled={!!closed} onError={setError} fill onStatus={setBoardStatus} author={coach ? 'coach' : 'interviewer'} />
              </Suspense>
            ) : (
              <div className="ivc-noboard">{log}</div>
            )}
          </main>
          <Suspense fallback={<aside className="ivc-side">{t('voice.joining')}</aside>}>
            <VoiceRoom
              sessionId={session.id}
              join={join}
              session={session}
              onSession={setSession}
              onLeft={setSession}
              layout="call"
              showTranscript={showTranscript}
              onHideTranscript={() => setShowTranscript(false)}
              kind={coach ? 'coach' : 'interview'}
              onDraw={(ops) => boardRef.current?.draw(ops)}
              rail={coach && lesson ? <CoachRail lesson={lesson} stageIndex={session.stageIndex} /> : null}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="ivr">
      <header className="iv-top">
        <a href="/" className="bp-logo">
          <Logo tone="dark" />
        </a>
        <nav className="iv-top__crumbs" aria-label={tc('nav.breadcrumb')}>
          <a href={`/systems/${page.system.slug}`}>{page.system.name}</a>
          <span>/</span>
          {session.scope ? (
            <>
              <a href={`/systems/${page.system.slug}/interview${coach ? '?kind=coach' : ''}`}>{t(coach ? 'coach.crumb' : 'crumb')}</a>
              <span>/</span>
              <strong>{t('crumb.drill')}</strong>
            </>
          ) : (
            <strong>{t(coach ? 'coach.crumb' : 'crumb')}</strong>
          )}
        </nav>
        <div className="iv-top__spacer" />
        {!finished && (
          <div className="ivr-clock" aria-label={t('room.clock')}>
            {t('room.left', { time: clock(plannedEnd - now) })}
          </div>
        )}
        <button type="button" className="ivr-leave" onClick={onExit} disabled={writing}>
          {finished && <svg className="iv-top__arrow" width="14" height="10" viewBox="0 0 14 10" aria-hidden="true"><path d="M13 5H2M6 1L2 5L6 9" /></svg>}
          {finished ? t('room.back') : t('room.leave')}
        </button>
      </header>

      {finished && coach ? (
        <CoachSummary page={page} session={session} transcript={log} deleting={busy === 'delete'} error={error} onDelete={() => void remove()} onRetry={onExit} />
      ) : finished ? (
        <InterviewFeedback page={page} session={session} transcript={log} deleting={busy === 'delete'} error={error} onDelete={() => void remove()} onRetry={onExit} />
      ) : (
        <>
          {!coach && (
          <ol className="ivr-stages" aria-label={t('room.stages')}>
            {page.stages.map((s, i) => (
              <li
                key={s.key}
                className={i < session.stageIndex ? 'is-done' : i === session.stageIndex ? 'is-current' : undefined}
                aria-current={i === session.stageIndex ? 'step' : undefined}
              >
                <span className="ivr-stages__n">{i + 1}</span>
                <span className="ivr-stages__title">{s.title}</span>
                <span className="ivr-stages__min">{t('tick', { minutes: s.minutes })}</span>
              </li>
            ))}
          </ol>
          )}

          <div className="ivr-body">
            <main className={`ivr-main${board ? ' has-board' : ''}`} id="content" tabIndex={-1}>
              <h1 className="sr-only">{t(coach ? 'coach.room.heading' : 'room.heading', { title: page.title, n: session.stageIndex + 1, total: page.stages.length, stage: stage.title })}</h1>
              {log}

              {error && (
                <div className="ivr-error" role="alert">
                  {error}
                </div>
              )}

              {board && InterviewBoard && (
                <Suspense fallback={null}>
                  <InterviewBoard ref={boardRef} sessionId={session.id} disabled={!!closed || writing} onError={setError} author={coach ? 'coach' : 'interviewer'} />
                </Suspense>
              )}

              {coach && !closed && (
                <div className="ivk-continue" role="status">
                  <span className="ivk-continue__note">
                    {lesson?.waiting === 'answer' && !writing
                      ? t('coach.room.answer')
                      : lesson?.waiting === 'draw' && !writing
                        ? t('coach.room.draw', { task: lesson.task ?? '' })
                        : paused
                        ? t('coach.room.paused')
                        : counting
                          ? t('coach.room.auto', { seconds: Math.max(0, Math.ceil(((continueAt ?? now) - now) / 1000)) })
                          : ''}
                    {counting && (
                      <span className="ivk-continue__bar" aria-hidden="true">
                        <span style={{ width: `${autoDelay ? Math.max(0, Math.min(100, (1 - ((continueAt ?? now) - now) / autoDelay) * 100)) : 100}%` }} />
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    className={`ivr-btn${paused ? ' is-on' : ''}`}
                    aria-pressed={paused}
                    onClick={() => {
                      // Resuming counts from now, not from when the move landed.
                      if (paused) setArmedAt(Date.now());
                      setPaused((p) => !p);
                    }}
                    disabled={!!busy}
                  >
                    {paused ? t('coach.room.resume') : t('coach.room.pause')}
                  </button>
                  <button type="button" className="ivr-btn ivr-btn--primary" onClick={() => void run('continue', null)} disabled={!!busy}>
                    {busy === 'continue' ? t('coach.room.continuing') : lesson?.waiting === 'draw' ? t('coach.room.drawDone') : t('coach.room.continue')}
                  </button>
                </div>
              )}

              {voiceOn && VoiceRoom ? (
                <Suspense fallback={<div className="ivr-closed">{t('voice.joining')}</div>}>
                  <VoiceRoom sessionId={session.id} join={join} session={session} onSession={setSession} onLeft={setSession} kind={coach ? 'coach' : 'interview'} onDraw={(ops) => boardRef.current?.draw(ops)} />
                </Suspense>
              ) : closed ? (
                <div className="ivr-closed" role="status">
                  {closedText}
                </div>
              ) : (
                <form className="ivr-compose" onSubmit={(e) => void sendReply(e)}>
                  <label htmlFor="ivr-answer" className="sr-only">
                    {t('room.answer')}
                  </label>
                  <textarea
                    id="ivr-answer"
                    ref={inputRef}
                    value={draft}
                    maxLength={MAX_CHARS}
                    rows={4}
                    placeholder={t(coach ? 'coach.room.placeholder' : 'room.placeholder')}
                    onChange={(e) => {
                      idleRef.current.since = Date.now();
                      setDraft(e.target.value);
                    }}
                    onKeyDown={onKey}
                    readOnly={writing}
                  />
                  <div className="ivr-compose__row">
                    <span className="ivr-compose__count">
                      {t('room.messagesLeft', { count: session.turnsLeft })}
                    </span>
                    {coach ? null : now < holdUntil ? (
                      <span className="ivr-compose__count" role="status">
                        {t('room.holding')}
                      </span>
                    ) : (
                      <button type="button" className="ivr-btn" onClick={() => setHoldUntil(Date.now() + HOLD_MS)} disabled={!!busy}>
                        {t('room.hold')}
                      </button>
                    )}
                    {writing ? (
                      <button type="button" className="ivr-btn" onClick={() => stopRef.current?.abort()}>
                        {t('room.stop')}
                      </button>
                    ) : (
                      <button type="submit" className="ivr-btn ivr-btn--primary" disabled={!draft.trim() || !!busy}>
                        {t('room.send')}
                      </button>
                    )}
                  </div>
                </form>
              )}
            </main>

            <aside className="ivr-side" aria-label={t('room.side')}>
              <div className="ivr-card">
                <div className="iv-label">{t(coach ? 'coach.room.part' : 'room.stage', { n: session.stageIndex + 1, total: page.stages.length })}</div>
                <h2 className="ivr-card__title">{stage.title}</h2>
                <p className="ivr-card__text">{stage.goal}</p>
                <div className={`ivr-card__time${overStage ? ' is-over' : ''}`}>
                  {t(overStage ? 'room.stageOver' : 'room.stageTime', { time: clock(stageMs), minutes: stage.minutes })}
                </div>
                {session.planChanged && <p className="ivr-card__text">{t('room.planChanged')}</p>}
                <button
                  type="button"
                  className="ivr-btn"
                  onClick={() => void act('advance', { action: 'advance', from: session.stageIndex })}
                  disabled={last || !!busy || !!closed || voiceOn}
                >
                  {busy === 'advance' ? t('room.moving') : last ? t(coach ? 'coach.room.last' : 'room.last') : t(coach ? 'coach.room.next' : 'room.next')}
                </button>
                {voiceOn && <p className="ivr-card__small">{t('voice.next')}</p>}
                {confirmEnd ? (
                  <div className="ivr-confirm">
                    <p className="ivr-card__text">{t(coach ? 'coach.room.endConfirm' : 'room.endConfirm')}</p>
                    <button type="button" className="ivr-btn ivr-btn--primary" onClick={() => void act('finish', { action: 'finish' })} disabled={!!busy}>
                      {busy === 'finish' ? t(coach ? 'coach.room.ending' : 'room.writingFeedback') : t(coach ? 'coach.room.endAndSummary' : 'room.endAndFeedback')}
                    </button>
                    <button type="button" className="ivr-btn" onClick={() => setConfirmEnd(false)} disabled={!!busy}>
                      {t('room.keepGoing')}
                    </button>
                  </div>
                ) : (
                  <button type="button" className={`ivr-btn${closed ? ' ivr-btn--primary' : ''}`} onClick={() => setConfirmEnd(true)} disabled={!!busy}>
                    {t(coach ? 'coach.room.end' : 'room.end')}
                  </button>
                )}
                <p className="ivr-card__small">{t(coach ? 'coach.room.caveat' : 'room.caveat')}</p>
              </div>
              {coach && lesson && <CoachRail lesson={lesson} stageIndex={session.stageIndex} />}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
