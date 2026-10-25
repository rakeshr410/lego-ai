import { Component, forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { compactElements, fingerprint, freehandHeavy, serialise, unlabelledRatio, type BoardElement, type BoardGraph } from '../../lib/board/serialise';
import t from '../../i18n/messages/interview';
import BoardOutline from './BoardOutline';
import type { DrawOp } from '../../lib/server/interview/draw';
import { NO_SYNC, Pen, type CursorPos, type PenElement } from '../../lib/board/pen';
import type { Api, SceneElements } from './ExcalidrawCanvas';

// The interview room's whiteboard (docs/interview/README.md, "Whiteboard"): the Excalidraw canvas
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
// extending, a note written, with a cursor over the canvas where the pen is. In a voice lesson the pipeline
// sends each drawing as the words before it have played, so the pen keeps time with the voice.

export type BoardHandle = {
  /** Saves now, if anything changed. Resolves when the server has it (or the attempt failed). */
  flush: () => Promise<void>;
  /** Posts a PNG of the board for the stage that is ending. */
  exportStage: (stage: string) => Promise<void>;
  /** Draws the interviewer's (or the coach's) drawing from a reply (server/interview/draw.ts) with the pen, as its own elements; queued until the canvas is up. */
  draw: (ops: readonly DrawOp[]) => void;
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
  /** Whose drawings the replies carry: the interviewer's (the default) or the coach's (docs/interview/coach-mode.md). */
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
  // The model's drawings waiting for the canvas (it loads on demand, and may be hidden).
  const queued = useRef<DrawOp[]>([]);
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
    const draw = (build: () => readonly PenElement[]) => void p.drawElements(build, NO_SYNC, { keepView: true });
    for (const op of ops) {
      if (op.op === 'box') draw(() => (find(op.label) ? [] : lib.buildBox(api, op.label, author, { kind: op.kind, group: op.group }).elements));
      else if (op.op === 'arrow')
        draw(() => {
          const from = find(op.from);
          const to = find(op.to);
          return from && to ? lib.buildArrow(api, from, to, op.label ?? '', author, { dashed: op.dashed, both: op.both }) : [];
        });
      else if (op.op === 'note') draw(() => lib.buildNote(api, op.text, op.near ? find(op.near) : null, author));
      else if (op.op === 'highlight') void p.highlight(() => find(op.target));
      else if (op.op === 'rename') {
        // The old box is erased where it stands and the new one drawn in its place.
        let at: { x: number; y: number; kind: 'box' | 'oval' | 'diamond'; group?: string } | null = null;
        void p.eraseElements(() => {
          const id = own(op.target);
          const box = id ? api.getSceneElements().find((e) => e.id === id) : null;
          if (!box) return [];
          const custom = (box.customData ?? {}) as { group?: string };
          at = { x: box.x, y: box.y, kind: box.type === 'ellipse' ? 'oval' : box.type === 'diamond' ? 'diamond' : 'box', group: custom.group };
          return lib.elementsOf(api, box.id);
        });
        draw(() => (at ? lib.buildBox(api, op.label, author, { kind: at.kind, group: at.group, at }).elements : []));
      } else if (op.op === 'erase')
        void p.eraseElements(() => {
          const id = own(op.target);
          return id ? lib.elementsOf(api, id) : [];
        });
      else if (op.op === 'clear') void p.clear(() => lib.idsBy(api, author));
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

  useImperativeHandle(
    ref,
    () => ({
      draw: (ops) => {
        queued.current.push(...ops);
        applyQueued();
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
        applyQueued();
      });
    },
    [applyQueued],
  );
  useEffect(() => () => pen.current?.abort(), []);
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
