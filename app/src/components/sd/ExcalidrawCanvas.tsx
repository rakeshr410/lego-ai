import { CaptureUpdateAction, Excalidraw, convertToExcalidrawElements, exportToBlob, restoreElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { memo, useRef, useState, type ComponentProps } from 'react';
import type { BoardElement } from '../../lib/board/serialise';
import { arrowRoute, followView, freeSpot, GAP, labelRoom, nextBoxSpot, noteSpot, union, viewFor, type Rect, type View } from '../../lib/board/geometry';
import { labelsAfterBoxes, type PenElement, type PenHost } from '../../lib/board/pen';

// The interview whiteboard's canvas: Excalidraw, loaded only by InterviewBoard.tsx (import()) so
// the room's page pays for it when the board opens, not at load. Everything the board needs from
// the library goes through here: the component, the PNG export, the outline's edits
// (BoardOutline.tsx) and the model's drawings, written as element skeletons the library lays out,
// and the pen's view of the canvas (lib/board/pen, `penHost`), which animates them onto it.

type Props = ComponentProps<typeof Excalidraw>;
export type Api = Parameters<NonNullable<Props['excalidrawAPI']>>[0];
export type SceneElements = Parameters<NonNullable<Props['onChange']>>[0];
type Skeleton = Parameters<typeof convertToExcalidrawElements>[0];

/** What the server has for the scene, back into the library's shape (missing fields filled in). */
export const restore = (elements: readonly BoardElement[]) =>
  restoreElements(labelsAfterBoxes(elements as unknown as { id: string; containerId?: string | null }[]) as unknown as Parameters<typeof restoreElements>[0], null);

const UI_OPTIONS: Props['UIOptions'] = {
  canvasActions: { export: false, loadScene: false, saveToActiveFile: false, saveAsImage: false, changeViewBackgroundColor: false, toggleTheme: false },
  tools: { image: false },
};

// Excalidraw calls onChange after every one of its own renders (componentDidUpdate), so a parent
// that answers onChange with state and re-renders this with fresh props feeds it forever ("Maximum
// update depth exceeded"). Every prop here is stable across the board's renders: the callbacks go
// through refs, the options and the initial scene are made once. Only viewMode may change.
export default memo(function ExcalidrawCanvas({
  initialElements,
  viewMode,
  onApi,
  onChange,
  onPointer,
}: {
  /** The scene at mount; later values are ignored (remount with a new key to replace it). */
  initialElements: readonly BoardElement[];
  viewMode: boolean;
  onApi: (api: Api) => void;
  onChange: (elements: SceneElements) => void;
  onPointer: (down: boolean) => void;
}) {
  const latest = useRef({ onApi, onChange, onPointer });
  latest.current = { onApi, onChange, onPointer };
  const stable = useRef({
    onApi: (api: Api) => latest.current.onApi(api),
    onChange: (elements: SceneElements) => latest.current.onChange(elements),
    onPointer: ({ button }: { button: 'down' | 'up' }) => latest.current.onPointer(button === 'down'),
  }).current;
  // The initial scene is read at mount only.
  const [initialData] = useState<Props['initialData']>(() => ({ elements: restore(initialElements), appState: { viewBackgroundColor: '#ffffff' }, scrollToContent: true }));
  return (
    <Excalidraw
      excalidrawAPI={stable.onApi}
      initialData={initialData}
      onChange={stable.onChange}
      onPointerUpdate={stable.onPointer}
      viewModeEnabled={viewMode}
      langCode="en"
      theme="light"
      UIOptions={UI_OPTIONS}
    />
  );
});

/** The board as a PNG, at most `maxSize` px on its longer side (the server keeps one per stage). */
export async function toPng(api: Api, maxSize: number): Promise<Blob> {
  return exportToBlob({
    elements: api.getSceneElements(),
    appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false },
    files: api.getFiles(),
    mimeType: 'image/png',
    maxWidthOrHeight: maxSize,
  });
}

const BOX = { width: 160, height: 64 };
const NOTE_FONT = 14;
const ARROW_FONT = 16;

const rectOf = (e: { x: number; y: number; width: number; height: number }): Rect => ({ x: Math.min(e.x, e.x + e.width), y: Math.min(e.y, e.y + e.height), w: Math.abs(e.width), h: Math.abs(e.height) });
/** What a new box or note must keep clear of: everything drawn but arrows and the text inside a shape. */
const taken = (api: Api): Rect[] =>
  api
    .getSceneElements()
    .filter((e) => e.type !== 'arrow' && e.type !== 'line' && !(e.type === 'text' && (e as { containerId?: string | null }).containerId))
    .map(rectOf);

/** Where the next box goes: beside the last box drawn while its row has room, else under everything; never on anything. */
function nextSpot(api: Api, size: { w: number; h: number } = { w: BOX.width, h: BOX.height }): { x: number; y: number } {
  const boxes = api
    .getSceneElements()
    .filter((e) => isShape(e) && !customOf(e).region && !customOf(e).highlight)
    .map(rectOf);
  return nextBoxSpot(size, boxes, taken(api));
}

/** Who drew an element: the candidate unless marked (the interviewer's drawings, server/interview/draw.ts). */
/** Who drew an element: the candidate unless marked (the interviewer's or the coach's drawings, server/interview/draw.ts). */
export type Author = 'interviewer' | 'coach' | undefined;
/** The interviewer's elements are dashed rust; the coach's solid blue: both tell apart from the candidate's at a glance. */
const AUTHOR_STYLE: Record<NonNullable<Author>, { strokeColor: string; strokeStyle: 'dashed' | 'solid' }> = {
  interviewer: { strokeColor: '#9a3412', strokeStyle: 'dashed' },
  coach: { strokeColor: '#1d4ed8', strokeStyle: 'solid' },
};
type Custom = { author?: NonNullable<Author>; group?: string; highlight?: boolean; region?: boolean };

type Made = ReturnType<typeof convertToExcalidrawElements>;

/** The elements a skeleton lays out to, styled and marked for their author, not yet on the board. */
const build = (skeleton: NonNullable<Skeleton>, author?: Author, custom: Omit<Custom, 'author'> = {}, dashed = false): Made =>
  convertToExcalidrawElements(author ? skeleton.map((s) => ({ ...s, ...AUTHOR_STYLE[author], ...(dashed ? { strokeStyle: 'dashed' as const } : {}) })) : skeleton).map((e) =>
    author ? { ...e, customData: { ...(e.customData ?? {}), author, ...custom } } : e,
  );

const add = (api: Api, skeleton: NonNullable<Skeleton>, author?: Author, custom: Omit<Custom, 'author'> = {}) => {
  const made = build(skeleton, author, custom);
  api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...made] });
  return made;
};

const asPen = (made: Made) => made as unknown as PenElement[];

const customOf = (e: { customData?: unknown }): Custom => (e.customData && typeof e.customData === 'object' ? (e.customData as Custom) : {});
const isShape = (e: { type: string }) => e.type === 'rectangle' || e.type === 'ellipse' || e.type === 'diamond';

/** A lesson's colours by meaning (server/coaching/schema.ts TONES): a light fill behind the author's stroke. */
export type Tone = 'neutral' | 'blue' | 'green' | 'red' | 'amber' | 'grey';
const TONE_FILL: Record<Tone, string> = {
  neutral: 'transparent',
  blue: '#dbeafe',
  green: '#dcfce7',
  red: '#fee2e2',
  amber: '#fef3c7',
  grey: '#f1f5f9',
};
const toneStyle = (tone: Tone | undefined) => (tone && tone !== 'neutral' ? { backgroundColor: TONE_FILL[tone], fillStyle: 'solid' as const } : {});

export type BoxOptions = {
  /** A store (oval) or a decision (diamond); a box otherwise. */
  kind?: 'box' | 'oval' | 'diamond';
  /** Placed beside the other boxes of this group, and marked with it. */
  group?: string;
  /** Exactly here (a renamed box keeps its place; a lesson's board plan places every box). */
  at?: { x: number; y: number };
  /** Its size, when the board plan gives one. */
  size?: { w: number; h: number };
  tone?: Tone;
  /** A dashed edge: a boundary that is not a visible line (a margin, a viewport). */
  dashed?: boolean;
};

function boxSkeleton(api: Api, label: string, opts: BoxOptions): NonNullable<Skeleton> {
  const type = opts.kind === 'oval' ? 'ellipse' : opts.kind === 'diamond' ? 'diamond' : 'rectangle';
  const size = opts.size ? { width: opts.size.w, height: opts.size.h } : BOX;
  const wh = { w: size.width, h: size.height };
  let spot = opts.at ?? nextSpot(api, wh);
  if (opts.group && !opts.at) {
    // Beside the last box of the group, when it has one and that spot is free.
    const peers = api.getSceneElements().filter((e) => isShape(e) && customOf(e).group === opts.group);
    const last = peers[peers.length - 1];
    if (last) spot = freeSpot(wh, taken(api), [{ x: last.x + last.width + GAP / 2, y: last.y }, { x: last.x, y: last.y + last.height + GAP / 2 }]);
  }
  return [{ type, x: spot.x, y: spot.y, ...size, ...toneStyle(opts.tone), label: { text: label } }];
}

/**
 * A labelled panel (a lesson's region: a tree, a context, a layer), its label at the top so the
 * boxes placed in it stay clear; it is named by its label like a box.
 */
/** What the learner gave (a line in their words, a part of the plan they named), green beside the coach's blue. */
const LEARNER_INK = '#15803d';
function inked<T extends { strokeColor?: string }>(learner: boolean, made: T[]): T[] {
  return learner ? made.map((e) => ({ ...e, strokeColor: LEARNER_INK })) : made;
}

export function buildRegion(api: Api, label: string, at: { x: number; y: number }, size: { w: number; h: number }, author?: Author, tone?: Tone, dashed?: boolean, learner = false): { id: string; elements: PenElement[] } {
  const made = inked(learner, build([{ type: 'rectangle', x: at.x, y: at.y, width: size.w, height: size.h, roundness: { type: 3 }, ...toneStyle(tone), label: { text: label, verticalAlign: 'top', fontSize: 16 } }], author, { region: true }, dashed));
  return { id: made.find((e) => isShape(e))?.id ?? made[0].id, elements: asPen(made) };
}

/** A labelled box, laid out by the library; returns its element id. */
export function addBox(api: Api, label: string, author?: Author, opts: BoxOptions = {}): string {
  const made = add(api, boxSkeleton(api, label, opts), author, opts.group ? { group: opts.group } : {});
  return made.find((e) => isShape(e))?.id ?? made[0].id;
}

/** The same box, built for the pen to draw (lib/board/pen): the shape and its label, not yet on the board. */
export function buildBox(api: Api, label: string, author?: Author, opts: BoxOptions = {}, learner = false): { id: string; elements: PenElement[] } {
  const made = inked(learner, build(boxSkeleton(api, label, opts), author, opts.group ? { group: opts.group } : {}, opts.dashed));
  return { id: made.find((e) => isShape(e))?.id ?? made[0].id, elements: asPen(made) };
}

export type ArrowOptions = { dashed?: boolean; both?: boolean };

function arrowSkeleton(api: Api, from: string, to: string, label: string, opts: ArrowOptions): NonNullable<Skeleton> | null {
  const live = api.getSceneElements();
  const a = live.find((e) => e.id === from);
  const b = live.find((e) => e.id === to);
  if (!a || !b) return null;
  const ra = rectOf(a);
  const rb = rectOf(b);
  // It goes around the other shapes, not the regions or panels its ends sit in.
  const within = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
  const obstacles = live
    .filter((e) => isShape(e) && e.id !== from && e.id !== to && !customOf(e).region && !customOf(e).highlight)
    .map(rectOf)
    .filter((r) => !within(r, ra) && !within(r, rb));
  const route = arrowRoute(ra, rb, obstacles, labelRoom(label, ARROW_FONT));
  const xs = route.points.map((p) => p[0]);
  const ys = route.points.map((p) => p[1]);
  return [
    {
      type: 'arrow',
      x: route.start.x,
      y: route.start.y,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      points: route.points,
      start: { id: from },
      end: { id: to },
      ...(label ? { label: { text: label, fontSize: ARROW_FONT } } : {}),
      ...(opts.dashed ? { strokeStyle: 'dashed' as const } : {}),
      ...(opts.both ? { startArrowhead: 'arrow' as const, endArrowhead: 'arrow' as const } : {}),
    },
  ];
}

/** An arrow from one box to another, bound at both ends, with an optional label. */
export function addArrow(api: Api, from: string, to: string, label: string, author?: Author, opts: ArrowOptions = {}): void {
  const skeleton = arrowSkeleton(api, from, to, label, opts);
  if (skeleton) add(api, skeleton, author);
}

/** The same arrow, built for the pen; nothing when either box is gone. */
export function buildArrow(api: Api, from: string, to: string, label: string, author?: Author, opts: ArrowOptions = {}): PenElement[] {
  const skeleton = arrowSkeleton(api, from, to, label, opts);
  return skeleton ? asPen(build(skeleton, author)) : [];
}

function noteSkeleton(api: Api, text: string, near: string | null, at?: { x: number; y: number }): NonNullable<Skeleton> {
  const box = near ? api.getSceneElements().find((e) => e.id === near) : null;
  const lines = text.split('\n');
  const size = { w: Math.max(...lines.map((l) => l.length)) * NOTE_FONT * 0.6, h: lines.length * NOTE_FONT * 1.35 };
  const spot = at ?? (box ? noteSpot(size, rectOf(box), taken(api)) : nextSpot(api, size));
  return [{ type: 'text', x: spot.x, y: spot.y, text, fontSize: NOTE_FONT }];
}

/** A sticky note (free text) beside a box, or under everything when `near` is null. */
export function addNote(api: Api, text: string, near: string | null, author?: Author): void {
  add(api, noteSkeleton(api, text, near), author);
}


/** The same note, built for the pen to write (exactly at `at` when a lesson's board plan places it); `learner` inks it as theirs. */
export function buildNote(api: Api, text: string, near: string | null, author?: Author, at?: { x: number; y: number }, learner = false): PenElement[] {
  return asPen(inked(learner, build(noteSkeleton(api, text, near, at), author)));
}

/** An element with what is bound to it (its label, the arrows at its ends): what erasing it takes off. */
export function elementsOf(api: Api, id: string): PenElement[] {
  const all = api.getSceneElements();
  return all.filter((e) => {
    if (e.id === id) return true;
    const el = e as unknown as { containerId?: string | null; startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null };
    return el.containerId === id || el.startBinding?.elementId === id || el.endBinding?.elementId === id;
  }) as unknown as PenElement[];
}

/** The ids of everything an author drew (the coach's "clear"). */
export const idsBy = (api: Api, author: NonNullable<Author>): string[] => api.getSceneElements().filter((e) => customOf(e).author === author).map((e) => e.id);

/**
 * The pen's view of the canvas (lib/board/pen): the scene, a frame of it committed (recorded for a mark that
 * stays, skipped for a frame of the animation), board points as viewport points for the cursor overlay, and
 * the view brought to the ink.
 */
export function penHost(api: Api): PenHost {
  type Scene = Parameters<Api['updateScene']>[0]['elements'];
  // The view follows a drawing only when it must (geometry.ts followView): the whole board while it reads at
  // that size, else the drawing with its region; a drawing already in view moves nothing.
  const follow = async (recent: readonly PenElement[]) => {
    const live = api.getSceneElements();
    const ids = new Set(recent.map((e) => e.id));
    const all = [...live.filter((e) => !ids.has(e.id)), ...(recent as unknown as typeof live)].filter((e) => e.width || e.height).map(rectOf);
    const ink = (recent as unknown as typeof live).filter((e) => e.width || e.height).map(rectOf);
    const regions = live.filter((e) => customOf(e).region).map(rectOf);
    const { scrollX, scrollY, zoom, width, height } = api.getAppState();
    const next = followView({ scrollX, scrollY, zoom: zoom.value }, { width, height }, all, ink, regions);
    if (next) await glide(api, { scrollX, scrollY, zoom: zoom.value }, next);
  };
  return {
    getElements: () => api.getSceneElements() as unknown as readonly PenElement[],
    commit: (next, { history }) => api.updateScene({ elements: labelsAfterBoxes(next) as unknown as Scene, captureUpdate: history === 'record' ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER }),
    toViewport: (p) => {
      const { scrollX, scrollY, zoom } = api.getAppState();
      return { x: (p.x + scrollX) * zoom.value, y: (p.y + scrollY) * zoom.value };
    },
    fit: (_all, recent) => follow(recent),
    fitAll: () => frameAll(api, true),
    reveal: (els) => follow(els),
  };
}

const GLIDE_MS = 320;

/** Shows the whole board, clear of the toolbar (a board loaded with drawings on it, the pen's "fit all"). */
export async function frameAll(api: Api, animate = false): Promise<void> {
  const all = union(api.getSceneElements().filter((e) => e.width || e.height).map(rectOf));
  if (!all) return;
  const { scrollX, scrollY, zoom, width, height } = api.getAppState();
  const to = viewFor(all, { width, height });
  const from = { scrollX, scrollY, zoom: zoom.value };
  return animate ? glide(api, from, to) : glide(api, to, to);
}

/** Moves the view from one place to another over GLIDE_MS (the library's own scroll cannot keep clear of its toolbar). */
async function glide(api: Api, from: View, to: View): Promise<void> {
  type Zoom = ReturnType<Api['getAppState']>['zoom'];
  const set = (v: View) => api.updateScene({ appState: { scrollX: v.scrollX, scrollY: v.scrollY, zoom: { value: v.zoom } as Zoom }, captureUpdate: CaptureUpdateAction.NEVER });
  if (typeof requestAnimationFrame === 'undefined' || (typeof document !== 'undefined' && document.hidden)) return set(to);
  const start = performance.now();
  await new Promise<void>((done) => {
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / GLIDE_MS);
      const k = 1 - (1 - t) * (1 - t);
      // Zoom eases on its own scale; the scroll follows so the point in the middle moves in a straight line.
      const zoom = from.zoom + (to.zoom - from.zoom) * k;
      set({ scrollX: from.scrollX + (to.scrollX - from.scrollX) * k, scrollY: from.scrollY + (to.scrollY - from.scrollY) * k, zoom });
      if (t < 1) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  });
}

/** A ring around a box, drawing the eye to it (its own element, so the box stays the author's). */
export function highlightBox(api: Api, id: string, author?: Author): void {
  const box = api.getSceneElements().find((e) => e.id === id);
  if (!box) return;
  const pad = 8;
  add(api, [{ type: 'rectangle', x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad, strokeWidth: 3, roundness: { type: 3 } }], author, { highlight: true });
}

/** The element id of the box with this label (the bound text, case-insensitive), or of the short id the server gave it. */
export function findBox(api: Api, name: string, ids: Readonly<Record<string, string>> = {}): string | null {
  const want = name.trim().toLowerCase();
  const live = api.getSceneElements();
  const text = live.find((e) => e.type === 'text' && (e as { text?: string }).text?.trim().toLowerCase() === want && (e as { containerId?: string | null }).containerId);
  if (text) return (text as { containerId?: string | null }).containerId ?? null;
  const byShort = Object.entries(ids).find(([, short]) => short.toLowerCase() === want)?.[0];
  return byShort && live.some((e) => e.id === byShort) ? byShort : null;
}

/** Whether this author drew the element (the server lets an author change or erase only its own). */
export const ownedBy = (api: Api, id: string, author: NonNullable<Author>): boolean => {
  const e = api.getSceneElements().find((x) => x.id === id);
  return !!e && customOf(e).author === author;
};

const bump = <T extends { version: number }>(e: T): T => ({ ...e, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() });

/** Deletes an element, the text bound to it and the arrows bound to it (the library keeps them as deleted). */
export function removeElement(api: Api, id: string): void {
  const all = api.getSceneElementsIncludingDeleted();
  const gone = new Set([id]);
  for (const e of all) {
    const el = e as unknown as { containerId?: string | null; startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null };
    if (el.containerId === id || el.startBinding?.elementId === id || el.endBinding?.elementId === id) gone.add(e.id);
  }
  api.updateScene({ elements: all.map((e) => (gone.has(e.id) && !e.isDeleted ? bump({ ...e, isDeleted: true }) : e)) });
}

/** Deletes everything an author drew (the coach's "clear"). */
export function removeBy(api: Api, author: NonNullable<Author>): void {
  for (const e of api.getSceneElements()) if (customOf(e).author === author) removeElement(api, e.id);
}

/** Renames a box: the library lays the new label out in the same place (the old box is deleted); the author's mark stays. */
export function renameBox(api: Api, id: string, label: string): void {
  const box = api.getSceneElements().find((e) => e.id === id);
  if (!box) return;
  const { author, group } = customOf(box);
  removeElement(api, id);
  add(api, [{ type: box.type === 'ellipse' || box.type === 'diamond' ? box.type : 'rectangle', x: box.x, y: box.y, width: box.width, height: box.height, label: { text: label } }], author, group ? { group } : {});
}
