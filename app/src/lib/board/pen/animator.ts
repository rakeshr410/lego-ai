import { ARROW_MS, CHAR_MS, CHAR_W, FRAME_MS, MOVE_MS, PAUSE_MS, REST_MS, SHAPE_MS, SYNC_CHAR_MS, SYNC_MOVE_MS, SYNC_SHAPE_MS, TEXT_MAX_MS } from './timing';

// The animated pen (docs/interview/coach-mode.md, phase 5): drawing-board's `src/pen/animator.ts` (2026),
// vendored and cut to what the room draws. A box grows from its corner and its label is typed; an arrow
// extends from its tail; a note is written out; a highlight pulses; an erased element shrinks or is untyped.
// The pen holds a queue, so drawings land one after another in order, and a cursor listener gets the pen's
// position for the overlay. Everything the pen knows of the canvas goes through a `PenHost`
// (ExcalidrawCanvas.tsx `penHost`), so this module imports nothing of the library and runs under Node.
// Not vendored: freehand strokes and walks (the room has no ink of that kind), the hover, the camera.

/** An element as the pen sees it: the library's shape, loosely typed. */
export type PenElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version?: number;
  isDeleted?: boolean;
  text?: string;
  originalText?: string;
  fontSize?: number;
  textAlign?: string;
  autoResize?: boolean;
  containerId?: string | null;
  strokeColor?: string;
  strokeWidth?: number;
  groupIds?: readonly string[];
  points?: readonly (readonly [number, number])[];
  boundElements?: unknown;
  startBinding?: unknown;
  endBinding?: unknown;
  customData?: Record<string, unknown>;
  [field: string]: unknown;
};

export type Point = { x: number; y: number };
export type CursorPos = { readonly x: number; readonly y: number; readonly drawing: boolean };
export type CursorListener = (pos: CursorPos | null) => void;

/** What the pen asks of the canvas. */
export interface PenHost {
  getElements(): readonly PenElement[];
  /** The scene as it should be; `record` for a mark that stays (undo sees it), `skip` for a frame of the animation. */
  commit(next: readonly PenElement[], opts: { history: 'record' | 'skip' }): void;
  toViewport(p: Point): Point;
  /** Bring these into view before drawing them (the view may already show them). */
  fit(all: readonly PenElement[], recent: readonly PenElement[]): Promise<void>;
  fitAll(): Promise<void>;
  /** Pan just enough for these to be on screen, zoom untouched. */
  reveal?(els: readonly PenElement[]): Promise<void>;
}

/** The pen waits on these before a mark: a voice reaching the words, or nothing (`NO_SYNC`). */
export interface PenSync {
  beforeShape(cue: string | undefined, signal: AbortSignal): Promise<void>;
  beforeLabel(cue: string, signal: AbortSignal): Promise<void>;
  beforeArrow?(cue: string, signal: AbortSignal): Promise<void>;
}

export const NO_SYNC: PenSync = {
  beforeShape: async () => {},
  beforeLabel: async () => {},
};

/** How the pen stopped when it did not finish: a decision (abort) or the canvas throwing (failed). */
export type PenStop = 'aborted' | 'failed';

export interface DrawOpts {
  /** Keep the view where it is, panning only as far as the ink needs. */
  keepView?: boolean;
  /** Told once, only when the batch did not finish. */
  onStop?: (stop: PenStop) => void;
}

export type ErrorSink = (e: { at: string; error: unknown }) => void;
const consoleSink: ErrorSink = ({ at, error }) => console.error(`[board] pen ${at}:`, error instanceof Error ? error.message : error);

type TextEl = PenElement & { text: string };
type Input<T> = T | (() => T);

const HIGHLIGHT_COLOR = '#e8590c';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hidden = () => (globalThis as { document?: { hidden?: boolean } }).document?.hidden === true;
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const nonce = () => Math.floor(Math.random() * 0x7fffffff);
const ABORTED = Symbol('pen-aborted');
const resolve = <T>(input: Input<T>): T => (typeof input === 'function' ? (input as () => T)() : input);
const isText = (e: PenElement): e is TextEl => e.type === 'text';
const isShape = (e: PenElement) => e.type === 'rectangle' || e.type === 'ellipse' || e.type === 'diamond';
const isLinear = (e: PenElement) => e.type === 'arrow' || e.type === 'line';
const isFrame = (e: PenElement) => e.type === 'frame' || e.type === 'magicframe';

/**
 * How wide the words will be, which is not always how wide the element says it is: a label sized to its
 * own text is as wide as it says; a line of text in a wider box is as wide as its characters.
 */
export const typedWidth = (el: TextEl): number => {
  const chars = (el.originalText || el.text).length;
  if (!chars || el.autoResize === false) return el.width;
  return Math.max(4, Math.min(el.width, chars * (el.fontSize ?? 16) * CHAR_W));
};

export class Pen {
  private readonly host: PenHost;
  private readonly onCursor: CursorListener;
  private readonly onError: ErrorSink;
  private queue: Promise<void> = Promise.resolve();
  private pendingTasks = 0;
  private pen = { x: 0, y: 0, placed: false };
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private gen = 0;
  private abortSignal!: Promise<typeof ABORTED>;
  private fireAbort: () => void = () => {};
  private aborter = new AbortController();

  constructor(host: PenHost, onCursor: CursorListener, onError: ErrorSink = consoleSink) {
    this.host = host;
    this.onCursor = onCursor;
    this.onError = onError;
    this.armAbort();
  }

  /**
   * Runs `task` after the queued ones. The catch keeps one bad batch from wedging every later one: an
   * abort is expected and silent, anything else is reported, and `onStop` says which it was.
   */
  enqueue<T = void>(task: () => Promise<T>, at = 'pen', onStop?: (stop: PenStop) => void): Promise<T | undefined> {
    const g = this.gen;
    this.pendingTasks++;
    const run = this.queue
      .then(() => {
        if (g !== this.gen) throw ABORTED;
        return task();
      })
      .catch((error) => {
        if (error === ABORTED) onStop?.('aborted');
        else {
          this.onError({ at, error });
          onStop?.('failed');
        }
        return undefined;
      })
      .finally(() => {
        this.pendingTasks--;
      });
    this.queue = run.then(() => {});
    return run;
  }

  /** Stops the mark in progress and drops what has not started; the cursor leaves the board. */
  abort(): void {
    this.gen++;
    const fire = this.fireAbort;
    this.aborter.abort();
    this.armAbort();
    fire();
    this.onCursor(null);
    this.pen.placed = false;
  }

  /** Settles when every queued mark has landed (or been dropped). */
  idle(): Promise<void> {
    return this.queue;
  }

  isBusy(): boolean {
    return this.pendingTasks > 0;
  }

  get signal(): AbortSignal {
    return this.aborter.signal;
  }

  /**
   * Draws these elements: frames, then shapes with their labels, then arrows with theirs, then free text.
   * Given a function, the elements are built when the pen reaches them, on the scene as it stands then (an
   * arrow finds the box drawn a mark earlier). Resolves true when all of it landed.
   */
  async drawElements(input: Input<readonly PenElement[]>, sync: PenSync | undefined = NO_SYNC, opts?: DrawOpts): Promise<boolean> {
    const done = await this.enqueue(
      async () => {
        const elements = resolve(input);
        if (!elements.length) return true;
        const api = this.host;
        const textFor = (id: string) => elements.find((e): e is TextEl => isText(e) && e.containerId === id);
        const frames = elements.filter(isFrame);
        const shapes = elements.filter(isShape);
        const arrows = elements.filter(isLinear);
        const freeText = elements.filter((e): e is TextEl => isText(e) && !e.containerId);
        if (!opts?.keepView) await this.race(api.fit([...api.getElements(), ...elements], elements));
        else if (api.reveal) await this.race(api.reveal(elements));
        if (!hidden()) await this.wait(120);
        for (const f of frames) await this.growShape(f, undefined, true);
        for (const s of shapes) await this.growShape(s, textFor(s.id), false, sync);
        for (const a of arrows) {
          const label = textFor(a.id);
          if (!hidden() && sync?.beforeArrow) await this.race(sync.beforeArrow(label?.originalText ?? label?.text ?? '', this.signal));
          await this.extendArrow(a, label);
        }
        for (const t of freeText) await this.typeText(t, true, sync ? SYNC_CHAR_MS : CHAR_MS);
        this.restLater();
        return true;
      },
      'pen.draw',
      opts?.onStop,
    );
    return done === true;
  }

  /** Points at an element and pulses its outline. */
  highlight(input: Input<string | null>, pulses = 3): Promise<void> {
    return this.enqueue(async () => {
      const id = resolve(input);
      const el = id ? this.host.getElements().find((e) => e.id === id) : null;
      if (!el) return;
      await this.moveTo(el.x + el.width / 2, el.y - 10, MOVE_MS);
      await this.pulse(el, pulses);
      this.restLater();
    }, 'pen.highlight');
  }

  /** Erases these: text is untyped, arrows retract, shapes shrink; what was bound to them lets go. */
  eraseElements(input: Input<readonly PenElement[]>): Promise<void> {
    return this.enqueue(async () => {
      const elements = resolve(input);
      if (!elements.length) return;
      const texts = elements.filter(isText);
      const arrows = elements.filter(isLinear);
      const shapes = elements.filter((e) => !isText(e) && !isLinear(e));
      if (!hidden()) await this.wait(320);
      for (const t of texts) await this.untype(t);
      for (const a of arrows) await this.retractArrow(a);
      for (const sh of shapes) await this.shrinkShape(sh);
      this.restLater();
    }, 'pen.erase');
  }

  /** Takes these elements off the board at once. */
  clear(input: Input<readonly string[]>): Promise<void> {
    return this.enqueue(async () => {
      const ids = new Set(resolve(input));
      if (!ids.size) return;
      this.host.commit(
        this.host.getElements().filter((e) => !ids.has(e.id)),
        { history: 'record' },
      );
      this.onCursor(null);
    }, 'pen.clear');
  }

  private armAbort() {
    this.aborter = new AbortController();
    this.abortSignal = new Promise((r) => {
      this.fireAbort = () => r(ABORTED);
    });
  }

  private async race<T>(p: Promise<T>): Promise<T> {
    const g = this.gen;
    const r = await Promise.race([p, this.abortSignal]);
    if (r === ABORTED || g !== this.gen) throw ABORTED;
    return r as T;
  }

  private wait(ms: number) {
    return this.race(sleep(ms));
  }

  private async growShape(el: PenElement, label: TextEl | undefined, frame: boolean, sync?: PenSync) {
    const labelText = label ? label.originalText || label.text : undefined;
    const synced = !!sync && !hidden();
    if (synced) await this.race(sync.beforeShape(labelText, this.signal));
    await this.moveTo(el.x, el.y, synced ? SYNC_MOVE_MS : MOVE_MS);
    await this.animate(synced ? SYNC_SHAPE_MS : SHAPE_MS, (t) => {
      const w = Math.max(2, el.width * t);
      const h = Math.max(2, el.height * t);
      this.upsert({ ...el, width: w, height: h, boundElements: null }, false);
      this.penAt(el.x + w, el.y + h, true);
    });
    this.upsert(el, true);
    if (label && !frame) {
      if (synced && labelText) {
        this.penAt(el.x + el.width / 2, el.y + el.height / 2, false);
        await this.race(sync.beforeLabel(labelText, this.signal));
        await Promise.all([this.typeText(label, false, SYNC_CHAR_MS), this.pulse(el, 2, 230)]);
      } else await this.typeText(label, false);
    }
    if (!hidden()) await this.wait(PAUSE_MS);
  }

  private async pulse(el: PenElement, n: number, onMs = 260) {
    for (let i = 0; i < n && !hidden(); i++) {
      this.upsert({ ...el, strokeColor: HIGHLIGHT_COLOR, strokeWidth: (el.strokeWidth ?? 1) + 2 }, false);
      await this.wait(onMs);
      this.upsert(el, false);
      await this.wait(Math.round(onMs * 0.7));
    }
  }

  private pointsOf(el: PenElement): readonly (readonly [number, number])[] {
    return (
      el.points ?? [
        [0, 0],
        [el.width, el.height],
      ]
    );
  }

  private async extendArrow(el: PenElement, label: TextEl | undefined) {
    const pts = this.pointsOf(el);
    await this.moveTo(el.x, el.y, MOVE_MS);
    await this.animate(ARROW_MS, (t) => {
      const scaled = pts.map(([px, py]) => [px * t, py * t] as const);
      const tip = scaled[scaled.length - 1];
      this.upsert({ ...el, points: scaled, startBinding: null, endBinding: null, boundElements: null }, false);
      this.penAt(el.x + tip[0], el.y + tip[1], true);
    });
    this.upsert(el, true);
    if (label) await this.typeText(label, false);
    if (!hidden()) await this.wait(PAUSE_MS);
  }

  private async retractArrow(el: PenElement) {
    const pts = this.pointsOf(el);
    const tip = pts[pts.length - 1];
    await this.moveTo(el.x + tip[0], el.y + tip[1], MOVE_MS);
    await this.animate(ARROW_MS * 0.7, (t) => {
      const k = 1 - t;
      const scaled = pts.map(([px, py]) => [px * k, py * k] as const);
      const end = scaled[scaled.length - 1];
      this.upsert({ ...el, points: scaled, startBinding: null, endBinding: null, boundElements: null }, false);
      this.penAt(el.x + end[0], el.y + end[1], true);
    });
    this.removeFromScene([el.id]);
  }

  private async shrinkShape(el: PenElement) {
    await this.moveTo(el.x + el.width, el.y + el.height, MOVE_MS);
    await this.animate(SHAPE_MS * 0.7, (t) => {
      const k = 1 - t;
      const w = Math.max(2, el.width * k);
      const h = Math.max(2, el.height * k);
      this.upsert({ ...el, width: w, height: h, boundElements: null }, false);
      this.penAt(el.x + w, el.y + h, true);
    });
    this.removeFromScene([el.id]);
    if (!hidden()) await this.wait(PAUSE_MS);
  }

  private async typeText(el: TextEl, moveFirst: boolean, charMs = CHAR_MS) {
    const full = el.originalText || el.text;
    const n = full.length;
    if (n === 0) return;
    const cx = el.x + el.width / 2;
    if (moveFirst) await this.moveTo(el.x, el.y, MOVE_MS);
    const perChar = Math.min(charMs, TEXT_MAX_MS / n);
    const grown = typedWidth(el);
    for (let i = 1; i <= n && !hidden(); i++) {
      const sub = full.slice(0, i);
      const w = Math.max(4, (grown * i) / n);
      const x = el.textAlign === 'center' ? cx - w / 2 : el.x;
      this.upsert({ ...el, text: sub, originalText: sub, width: w, x }, false);
      this.penAt(x + w, el.y + el.height * 0.8, true);
      const jitter = 0.65 + Math.random() * 0.7;
      await this.wait(perChar * jitter + (full[i - 1] === ' ' ? perChar * 0.8 : 0));
    }
    this.upsert(el, true);
  }

  private async untype(el: TextEl) {
    const full = el.originalText || el.text;
    const n = full.length;
    const cx = el.x + el.width / 2;
    const grown = typedWidth(el);
    await this.moveTo(el.x + grown, el.y + el.height * 0.8, MOVE_MS);
    const perChar = Math.min(CHAR_MS * 0.6, 700 / Math.max(1, n));
    for (let i = n - 1; i >= 1 && !hidden(); i--) {
      const sub = full.slice(0, i);
      const w = Math.max(4, (grown * i) / n);
      const x = el.textAlign === 'center' ? cx - w / 2 : el.x;
      this.upsert({ ...el, text: sub, originalText: sub, width: w, x }, false);
      this.penAt(x + w, el.y + el.height * 0.8, true);
      await this.wait(perChar);
    }
    this.removeFromScene([el.id]);
  }

  /** Takes elements out, and unbinds whatever pointed at them (a label's container, an arrow's ends). */
  private removeFromScene(ids: string[]) {
    const gone = new Set(ids);
    const rest = this.host
      .getElements()
      .filter((e) => !gone.has(e.id))
      .map((e) => {
        const patch: Record<string, unknown> = {};
        const bound = e.boundElements as { id: string }[] | null | undefined;
        if (bound?.some((b) => gone.has(b.id))) patch.boundElements = bound.filter((b) => !gone.has(b.id));
        const start = e.startBinding as { elementId: string } | null | undefined;
        const end = e.endBinding as { elementId: string } | null | undefined;
        if (start && gone.has(start.elementId)) patch.startBinding = null;
        if (end && gone.has(end.elementId)) patch.endBinding = null;
        return Object.keys(patch).length ? { ...e, ...patch, version: (e.version ?? 1) + 1, versionNonce: nonce() } : e;
      });
    this.host.commit(rest, { history: 'record' });
  }

  private upsert(el: PenElement, final: boolean) {
    const bumped = { ...el, version: (el.version ?? 1) + 1, versionNonce: nonce(), updated: Date.now() };
    const rest = this.host.getElements().filter((e) => e.id !== el.id);
    this.host.commit(isFrame(el) ? [bumped, ...rest] : [...rest, bumped], { history: final ? 'record' : 'skip' });
  }

  private async animate(ms: number, step: (t: number) => void) {
    if (hidden()) return step(1);
    const start = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - start) / ms);
      step(easeOut(t));
      if (t >= 1) return;
      await this.wait(FRAME_MS);
    }
  }

  private async moveTo(sx: number, sy: number, ms: number) {
    if (!this.pen.placed || hidden()) {
      this.pen = { x: sx, y: sy, placed: true };
      this.penAt(sx, sy, false);
      if (!hidden()) await this.wait(120);
      return;
    }
    const from = { ...this.pen };
    await this.animate(ms, (t) => this.penAt(from.x + (sx - from.x) * t, from.y + (sy - from.y) * t, false));
  }

  private penAt(sx: number, sy: number, drawing: boolean) {
    this.pen = { x: sx, y: sy, placed: true };
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (hidden()) return; // nobody is watching the pen
    const { x, y } = this.host.toViewport({ x: sx, y: sy });
    this.onCursor({ x, y, drawing });
  }

  private restLater() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.onCursor(null);
      this.pen.placed = false;
    }, REST_MS);
  }
}
