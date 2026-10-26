import { Component, forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { compactElements, fingerprint, freehandHeavy, serialise, unlabelledRatio, type BoardElement, type BoardGraph } from '../../lib/board/serialise';
import t from '../../i18n/messages/interview';
import BoardOutline from './BoardOutline';
import type { DrawOp } from '../../lib/server/interview/draw';
import { NO_SYNC, Pen, Pointer, VoiceCues, type CursorPos, type PenCueMessage, type PenElement, type PenSync } from '../../lib/board/pen';
import type { Api, SceneElements } from './ExcalidrawCanvas';

// The interview room's whiteboard (docs/README.md, "Whiteboard"): the Excalidraw canvas
// (ExcalidrawCanvas.tsx, loaded on demand) or the same board as a list (BoardOutline.tsx), saved to
// the session as it settles. The room only compacts the scene and computes its fingerprint; the
// server serialises it for the interviewer.
//
// Saves: 1.3 s after the last change with the pointer up, at most one every 5 s, skipping scenes
// whose fingerprint has not changed; a hard save (flush) before the candidate's message goes, at a
// stage change and at the finish, so the interviewer reads the board as it stood. A 409 (another
// tab saved first) loads the server's scene. On leaving the page, unsaved changes go by sendBeacon.
// A PNG of the board goes to the server as a stage ends (the grader's picture) and, when the board
// is mostly freehand or unlabelled, after a save (the vision fallback's), rendered here.
//
// The model's drawings (the interviewer's, the coach's) are drawn by the pen (lib/board/pen, phase 5 of
// coach-mode.md): one operation after another, a box growing from its corner and its label typed, an arrow
// extending, a note written, with a cursor over the canvas where the pen is. In a voice lesson each drawing comes
// with a reference, and the pen draws each of its operations on the voice's cues (lib/board/pen/cues.ts): the
// outline in the voice's pause before the label, each word of the label as the voice says it.

/** A word's share of the voice's time, when it gives a sentence at once (about three words a second). */
const HEARD_WORD_MS = 320;

export type BoardHandle = {
  /** Saves now, if anything changed. Resolves when the server has it (or the attempt failed). */
  flush: () => Promise<void>;
  /** Posts a PNG of the board for the stage that is ending. */
  exportStage: (stage: string) => Promise<void>;
  /**
   * Draws the interviewer's (or the coach's) drawing from a reply (server/interview/draw.ts) with the pen, as its
   * own elements; queued until the canvas is up. With `pace` (a voice lesson), each operation waits for its cues;
   * `instant` (the board a lesson opens with, drawn in earlier lessons) puts it there at once, without the pen.
   */
  draw: (ops: readonly DrawOp[], pace?: string, instant?: boolean) => void;
  /** A voice cue for the pen (voice/bot/conductor.py). */
  cue: (cue: PenCueMessage) => void;
  /** The voice started (true) or stopped talking: the pen comes to what was written last, or leaves. */
  speaking: (on: boolean) => void;
  /** Words the voice just said: the pen hovers over what they name on the board (pen/pointer.ts). */
  spoken: (text: string) => void;
};

type Props = {
  sessionId: string;
  /** No more changes (the session closed, or a reply is on its way). */
  disabled: boolean;
  onError: (message: string) => void;
  /** The call room's board (design 17a): fills its area, no bar; the save state goes to the room's header. */
  fill?: boolean;
  /** The save state's words, for a header that shows it (fill). */
  onStatus?: (text: string) => void;
  /** Whose drawings the replies carry: the interviewer's (the default) or the coach's (docs/coach-mode.md). */
  author?: 'interviewer' | 'coach';
};

type ServerBoard = { version: number; fingerprint: string; elements: BoardElement[] };

const SETTLE_MS = 1300;
const SAVE_MIN_MS = 5000;
const PNG_MAX_PX = 1024;
const PNG_MAX_BYTES = 200 * 1024;

/**
 * A crash inside the canvas (the library's, or a scene it cannot render) must not take the room with
 * it: the boundary shows a notice and a button that mounts the canvas again on the current scene,
 * and the outline keeps working meanwhile.
 */
class CanvasBoundary extends Component<{ children: ReactNode; onReset: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('[interview] board canvas:', err instanceof Error ? err.message : String(err));
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="ivr-board__loading" role="alert">
        {t('board.crashed')}{' '}
        <button
          type="button"
          className="ivr-btn ivr-btn--small"
          onClick={() => {
            this.props.onReset();
            this.setState({ failed: false });
          }}
        >
          {t('board.reload')}
        </button>
      </div>
    );
  }
}

/** The pen over the canvas, its tip at the pen's position; a shade darker while it draws. */
function PenCursor({ pos }: { pos: CursorPos }) {
  return (
    <svg className={`ivr-board__pen${pos.drawing ? ' is-drawing' : ''}`} style={{ transform: `translate(${Math.round(pos.x)}px, ${Math.round(pos.y) - 22}px)` }} width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <path d="M1 21l3.5-1 14-14a2 2 0 0 0 0-3l-.5-.5a2 2 0 0 0-3 0l-14 14z" fill="currentColor" />
      <path d="M1 21l1-3.5 2.5 2.5z" fill="#fff" opacity="0.6" />
    </svg>
  );
}

/** Loads the board font's glyphs for this text (Excalidraw registers the font in pieces by character range). */
async function fontsFor(text: string): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts?.load) return;
  await Promise.race([fonts.load('20px Excalifont', text).catch(() => []), new Promise((r) => setTimeout(r, 1500))]);
}

const Canvas = lazy(() => {
  // Fonts come from this site (scripts/copy-excalidraw.mjs); set before the library's code runs.
  (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw/';
  return import('./ExcalidrawCanvas');
});

const InterviewBoard = forwardRef<BoardHandle, Props>(function InterviewBoard({ sessionId, disabled, onError, fill = false, onStatus, author = 'interviewer' }, ref) {
  const [initial, setInitial] = useState<ServerBoard | null | 'failed'>(null);
  const [open, setOpen] = useState(true);
  const [view, setView] = useState<'canvas' | 'outline'>('canvas');
  const [status, setStatus] = useState<'saved' | 'unsaved' | 'saving' | 'conflict' | 'error'>('saved');
  const [graph, setGraph] = useState<BoardGraph | null>(null);
  const [cursor, setCursor] = useState<CursorPos | null>(null);
  const apiRef = useRef<Api | null>(null);
  const libRef = useRef<typeof import('./ExcalidrawCanvas') | null>(null);
  const elementsRef = useRef<readonly BoardElement[]>([]);
  const pointerDown = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saved = useRef({ version: 0, fingerprint: '', at: 0 });
  const inflight = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  // The model's drawings waiting for the canvas (it loads on demand, and may be hidden), each operation with its
  // drawing's pace reference and its place in it.
  const queued = useRef<{ op: DrawOp; pace?: string; i: number; instant?: boolean }[]>([]);
  // The voice's cues for paced drawings; they may arrive before the canvas is up.
  const cues = useRef(new VoiceCues());
  const pointer = useRef(new Pointer());
  const heardLater = useRef<ReturnType<typeof setTimeout>[]>([]);
  // The pen that draws them (lib/board/pen), made when the canvas is up; its queue keeps the operations in order.
  const pen = useRef<Pen | null>(null);
  // The last scene the board rendered state for: Excalidraw reports a change after every render of
  // its own, so a change that is no change must not set state again (see ExcalidrawCanvas.tsx).
  const rendered = useRef('');
  // The canvas mounts once per key, on the scene in `start` (the server's, or the current one after a crash).
  const [canvasKey, setCanvasKey] = useState(0);
  const [start, setStart] = useState<readonly BoardElement[] | null>(null);
  // The save the timers call (set below, once `save` exists).
  const later = useRef<() => void>(() => {});

  // Each operation goes to the pen's queue; its elements are built when the pen reaches it, on the scene as
  // it stands then, so an arrow finds the box drawn an operation earlier. The view keeps where it is and pans
  // to the ink only as far as it must.
  const applyQueued = useCallback(() => {
    const api = apiRef.current;
    const lib = libRef.current;
    const p = pen.current;
    if (!api || !lib || !p || !queued.current.length) return;
    const ops = queued.current;
    queued.current = [];
    const find = (label: string) => lib.findBox(api, label);
    const own = (label: string) => {
      // The server allowed the edit only on the author's own box; the room checks again.
      const id = find(label);
      return id && lib.ownedBy(api, id, author) ? id : null;
    };
    // The hand-drawn font's glyphs for these labels, before anything is measured: text measured in the fallback
    // font is narrower, and the label is cut at both ends once the font arrives.
    const texts = ops.map(({ op }) => ('label' in op && op.label) || ('text' in op && op.text) || '').filter(Boolean);
    if (texts.length) void p.enqueue(() => fontsFor(texts.join(' ')), 'pen.fonts');
    for (const { op, pace, i, instant } of ops) {
      const sync: PenSync = pace ? cues.current.sync(pace, i) : NO_SYNC;
      const draw = (build: () => readonly PenElement[]) => void p.drawElements(build, sync, { keepView: true, instant });
      // The voice stopped before it reached this mark (the learner cut in): it is left undrawn.
      const cut = () => !!sync.dropped?.();
      // A mark the pen does not draw from elements waits for its cue in the queue first.
      if (pace && (op.op === 'highlight' || op.op === 'erase' || op.op === 'clear' || op.op === 'rename')) void p.waitFor(sync);
      if (op.op === 'box') draw(() => (find(op.label) ? [] : lib.buildBox(api, op.label, author, { kind: op.kind, group: op.group, at: op.at, size: op.size, tone: op.tone, dashed: op.dashed }, !!op.learner).elements));
      else if (op.op === 'region') draw(() => (find(op.label) ? [] : lib.buildRegion(api, op.label, op.at, op.size, author, op.tone, op.dashed, !!op.learner).elements));
      else if (op.op === 'arrow')
        draw(() => {
          const from = find(op.from);
          const to = find(op.to);
          return from && to ? lib.buildArrow(api, from, to, op.label ?? '', author, { dashed: op.dashed, both: op.both }) : [];
        });
      else if (op.op === 'note') draw(() => lib.buildNote(api, op.text, op.near ? find(op.near) : null, author, op.at, !!op.learner));
      else if (op.op === 'highlight') void p.highlight(() => (cut() ? null : find(op.target)));
      else if (op.op === 'rename') {
        // The old box is erased where it stands and the new one drawn in its place.
        let at: { x: number; y: number; kind: 'box' | 'oval' | 'diamond'; group?: string } | null = null;
        void p.eraseElements(() => {
          const id = cut() ? null : own(op.target);
          const box = id ? api.getSceneElements().find((e) => e.id === id) : null;
          if (!box) return [];
          const custom = (box.customData ?? {}) as { group?: string };
          at = { x: box.x, y: box.y, kind: box.type === 'ellipse' ? 'oval' : box.type === 'diamond' ? 'diamond' : 'box', group: custom.group };
          return lib.elementsOf(api, box.id);
        });
        draw(() => (at ? lib.buildBox(api, op.label, author, { kind: at.kind, group: at.group, at }).elements : []));
      } else if (op.op === 'erase')
        void p.eraseElements(() => {
          const id = cut() ? null : own(op.target);
          return id ? lib.elementsOf(api, id) : [];
        });
      else if (op.op === 'clear') void p.clear(() => (cut() ? [] : lib.idsBy(api, author)));
    }
  }, [author]);

  // The board as the server has it (the session may be resumed in a new tab).
  useEffect(() => {
    let alive = true;
    fetch(`/api/interview/${sessionId}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { session?: { board?: ServerBoard | null } };
        if (!alive) return;
        const board = res.ok ? (data.session?.board ?? { version: 0, fingerprint: '', elements: [] }) : 'failed';
        if (board !== 'failed') {
          saved.current = { version: board.version, fingerprint: board.fingerprint, at: 0 };
          elementsRef.current = board.elements;
          setGraph(serialise(compactElements(board.elements)));
        }
        setInitial(board);
      })
      .catch(() => alive && setInitial('failed'));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const body = useCallback(() => {
    const elements = compactElements(elementsRef.current as unknown[]);
    return { baseVersion: saved.current.version, fingerprint: fingerprint(elements), elements };
  }, []);

  const postPng = useCallback(
    async (stage: string, version: number) => {
      const api = apiRef.current;
      const lib = libRef.current;
      if (!api || !lib || !api.getSceneElements().length) return;
      let blob = await lib.toPng(api, PNG_MAX_PX);
      if (blob.size > PNG_MAX_BYTES) blob = await lib.toPng(api, 640);
      if (blob.size > PNG_MAX_BYTES) return;
      await fetch(`/api/interview/${sessionId}/board/png?stage=${encodeURIComponent(stage)}&version=${version}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob }).catch(() => null);
    },
    [sessionId],
  );

  const save = useCallback(
    async (force: boolean): Promise<void> => {
      if (inflight.current) {
        await inflight.current;
        if (!force) return;
      }
      const payload = body();
      if (payload.fingerprint === saved.current.fingerprint) {
        dirty.current = false;
        setStatus('saved');
        return;
      }
      const wait = SAVE_MIN_MS - (Date.now() - saved.current.at);
      if (!force && wait > 0) {
        settleTimer.current = setTimeout(() => later.current(), wait);
        return;
      }
      setStatus('saving');
      const run = (async () => {
        try {
          const res = await fetch(`/api/interview/${sessionId}/board`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const data = (await res.json().catch(() => ({}))) as { version?: number; fingerprint?: string; board?: ServerBoard; error?: string; code?: string };
          if (res.ok && typeof data.version === 'number') {
            saved.current = { version: data.version, fingerprint: data.fingerprint ?? payload.fingerprint, at: Date.now() };
            dirty.current = body().fingerprint !== saved.current.fingerprint;
            setStatus(dirty.current ? 'unsaved' : 'saved');
            const g = serialise(payload.elements);
            if (freehandHeavy(g) || unlabelledRatio(g) > 0.5) void postPng('current', data.version);
            return;
          }
          if (res.status === 409 && data.code === 'board_conflict' && data.board) {
            // Another tab saved first: theirs is the board now.
            const theirs = data.board;
            saved.current = { version: theirs.version, fingerprint: theirs.fingerprint, at: Date.now() };
            elementsRef.current = theirs.elements;
            setGraph(serialise(compactElements(theirs.elements)));
            const api = apiRef.current;
            const lib = libRef.current;
            if (api && lib) api.updateScene({ elements: lib.restore(theirs.elements) });
            dirty.current = false;
            setStatus('conflict');
            return;
          }
          if (res.status === 409) {
            dirty.current = false;
            setStatus('saved');
            return;
          }
          setStatus('error');
          if (res.status === 400) onError(data.error ?? t('board.error'));
        } catch {
          setStatus('error');
        }
      })();
      inflight.current = run;
      try {
        await run;
      } finally {
        if (inflight.current === run) inflight.current = null;
      }
    },
    [body, onError, postPng, sessionId],
  );

  useEffect(() => {
    later.current = () => void save(false);
  }, [save]);

  const schedule = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    const tick = () => {
      if (pointerDown.current) settleTimer.current = setTimeout(tick, SETTLE_MS);
      else later.current();
    };
    settleTimer.current = setTimeout(tick, SETTLE_MS);
  }, []);

  const onChange = useCallback(
    (elements: SceneElements) => {
      elementsRef.current = elements as unknown as readonly BoardElement[];
      const next = compactElements(elements as unknown as unknown[]);
      const fp = fingerprint(next);
      if (fp === saved.current.fingerprint || fp === rendered.current) return;
      rendered.current = fp;
      dirty.current = true;
      setStatus((s) => (s === 'saving' ? s : 'unsaved'));
      setGraph(serialise(next));
      schedule();
    },
    [schedule],
  );

  /** The writing on the board, in scene order (what the pen touched last, last). */
  const writing = () => ((apiRef.current?.getSceneElements() ?? []) as unknown as PenElement[]).filter((e) => e.type === 'text' && !e.isDeleted && (e.originalText || e.text));

  useImperativeHandle(
    ref,
    () => ({
      draw: (ops, pace, instant) => {
        queued.current.push(...ops.map((op, i) => ({ op, pace, i, instant })));
        applyQueued();
      },
      cue: (cue) => cues.current.receive(cue),
      speaking: (on) => {
        heardLater.current.forEach(clearTimeout);
        heardLater.current = [];
        if (!on) return pen.current?.rest();
        pointer.current.reset();
        // Talking about what is on the board: the pen starts over the last thing written.
        const last = writing().at(-1);
        if (last) pen.current?.hover(last);
      },
      spoken: (text) => {
        // A voice that times its words gives them one by one; one that times sentences gives a sentence as it
        // starts: its words are heard at a speaking pace, so the pen reaches each thing as it is named.
        const hear = (word: string) => {
          const spots = writing();
          const id = pointer.current.hear(word, spots.map((e) => ({ id: e.id, text: e.originalText || e.text || '' })));
          const el = id ? spots.find((e) => e.id === id) : null;
          if (el) pen.current?.hover(el);
          else pen.current?.stay();
        };
        const said = text.split(/\s+/).filter(Boolean);
        const start = heardLater.current.length * HEARD_WORD_MS;
        said.forEach((word, i) => {
          const later = setTimeout(() => {
            heardLater.current = heardLater.current.filter((t) => t !== later);
            hear(word);
          }, start + i * HEARD_WORD_MS);
          heardLater.current.push(later);
        });
      },
      flush: async () => {
        if (settleTimer.current) clearTimeout(settleTimer.current);
        if (initial === null || initial === 'failed') return;
        // A drawing still landing goes with the message too.
        await pen.current?.idle();
        await save(true);
      },
      exportStage: async (stage) => {
        if (initial === null || initial === 'failed') return;
        await postPng(stage, saved.current.version);
      },
    }),
    [applyQueued, initial, postPng, save],
  );

  // Unsaved changes on the way out (the room closing, the tab going).
  useEffect(() => {
    const leave = () => {
      if (!dirty.current) return;
      const json = JSON.stringify(body());
      if (json.length > 60_000) return;
      navigator.sendBeacon(`/api/interview/${sessionId}/board`, new Blob([json], { type: 'application/json' }));
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      if (settleTimer.current) clearTimeout(settleTimer.current);
      leave();
    };
  }, [body, sessionId]);

  const onApi = useCallback(
    (api: Api) => {
      apiRef.current = api;
      void import('./ExcalidrawCanvas').then((lib) => {
        libRef.current = lib;
        // A new canvas (the first, or one mounted again after a crash): a new pen over it.
        pen.current?.abort();
        pen.current = new Pen(lib.penHost(api), setCursor);
        // A board that comes back with drawings on it opens showing all of them, clear of the toolbar.
        if (api.getSceneElements().length) requestAnimationFrame(() => void lib.frameAll(api));
        applyQueued();
      });
    },
    [applyQueued],
  );
  useEffect(
    () => () => {
      heardLater.current.forEach(clearTimeout);
      pen.current?.abort();
    },
    [],
  );
  const onPointer = useCallback((down: boolean) => {
    pointerDown.current = down;
  }, []);
  const remountCanvas = useCallback(() => {
    apiRef.current = null;
    setStart(compactElements(elementsRef.current as unknown as unknown[]));
    rendered.current = '';
    setCanvasKey((k) => k + 1);
  }, []);

  const edit = useCallback(
    (fn: (lib: typeof import('./ExcalidrawCanvas'), api: Api) => void) => {
      const api = apiRef.current;
      const lib = libRef.current;
      if (!api || !lib || disabled) return;
      fn(lib, api);
    },
    [disabled],
  );

  const statusText = { saved: t('board.saved'), unsaved: t('board.unsaved'), saving: t('board.saving'), conflict: t('board.conflict'), error: t('board.error') }[status];
  const stateText = initial === 'failed' ? t('board.unavailable') : initial === null ? t('board.loading') : statusText;
  useEffect(() => onStatus?.(stateText), [onStatus, stateText]);

  const canvas =
    initial !== null && initial !== 'failed' ? (
      <>
        <div className="ivr-board__canvas" hidden={view !== 'canvas'}>
          <CanvasBoundary key={canvasKey} onReset={remountCanvas}>
            <Suspense fallback={<div className="ivr-board__loading">{t('board.loading')}</div>}>
              <Canvas initialElements={start ?? initial.elements} viewMode={disabled} onApi={onApi} onChange={onChange} onPointer={onPointer} />
            </Suspense>
          </CanvasBoundary>
          {cursor && <PenCursor pos={cursor} />}
        </div>
        {view === 'outline' && graph && (
          <BoardOutline
            graph={graph}
            disabled={disabled}
            onAdd={(label) => edit((lib, api) => lib.addBox(api, label))}
            onConnect={(from, to, label) => edit((lib, api) => lib.addArrow(api, from, to, label))}
            onRename={(eid, label) => edit((lib, api) => lib.renameBox(api, eid, label))}
            onDelete={(eid) => edit((lib, api) => lib.removeElement(api, eid))}
          />
        )}
      </>
    ) : null;
  const views = (
    <div className="ivr-board__views" role="group" aria-label={t('board.view')}>
      <button type="button" className={`ivr-btn ivr-btn--small${view === 'canvas' ? ' is-on' : ''}`} aria-pressed={view === 'canvas'} onClick={() => setView('canvas')}>
        {t('board.canvas')}
      </button>
      <button type="button" className={`ivr-btn ivr-btn--small${view === 'outline' ? ' is-on' : ''}`} aria-pressed={view === 'outline'} onClick={() => setView('outline')}>
        {t('board.outline')}
      </button>
    </div>
  );

  if (fill) {
    return (
      <section className="ivr-board is-fill" aria-label={t('board.title')}>
        {canvas ?? <div className="ivr-board__loading">{stateText}</div>}
        {canvas && views}
      </section>
    );
  }

  return (
    <section className="ivr-board" aria-labelledby="ivr-board-title">
      <div className="ivr-board__bar">
        <h2 id="ivr-board-title" className="ivr-board__title">
          {t('board.title')}
        </h2>
        <span className="ivr-board__status" role="status">
          {stateText}
        </span>
        <div className="ivr-board__spacer" />
        {open && views}
        <button type="button" className="ivr-btn ivr-btn--small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? t('board.hide') : t('board.show')}
        </button>
      </div>
      {open && canvas && (
        <>
          <p className="ivr-board__hint">{t('board.hint')}</p>
          {canvas}
        </>
      )}
    </section>
  );
});

export default InterviewBoard;
