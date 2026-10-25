import { CaptureUpdateAction, Excalidraw, convertToExcalidrawElements, exportToBlob, restoreElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { memo, useRef, useState, type ComponentProps } from 'react';
import type { BoardElement } from '../../lib/board/serialise';
import type { PenElement, PenHost } from '../../lib/board/pen';

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
export const restore = (elements: readonly BoardElement[]) => restoreElements(elements as unknown as Parameters<typeof restoreElements>[0], null);

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
const GAP = 40;

/** Where the next box goes: under everything drawn so far, in rows of four. */
function nextSpot(api: Api): { x: number; y: number } {
  const live = api.getSceneElements();
  if (!live.length) return { x: 0, y: 0 };
  const bottom = Math.max(...live.map((e) => e.y + e.height));
  const boxes = live.filter((e) => e.type === 'rectangle' || e.type === 'ellipse' || e.type === 'diamond');
  const left = boxes.length ? Math.min(...boxes.map((e) => e.x)) : 0;
  const rowY = Math.max(...boxes.map((e) => e.y), 0);
  const inRow = boxes.filter((e) => Math.abs(e.y - rowY) < 20).length;
  return inRow > 0 && inRow < 4 ? { x: left + inRow * (BOX.width + GAP), y: rowY } : { x: left, y: bottom + GAP };
}

/** Who drew an element: the candidate unless marked (the interviewer's drawings, server/interview/draw.ts). */
/** Who drew an element: the candidate unless marked (the interviewer's or the coach's drawings, server/interview/draw.ts). */
export type Author = 'interviewer' | 'coach' | undefined;
/** The interviewer's elements are dashed rust; the coach's solid blue: both tell apart from the candidate's at a glance. */
const AUTHOR_STYLE: Record<NonNullable<Author>, { strokeColor: string; strokeStyle: 'dashed' | 'solid' }> = {
  interviewer: { strokeColor: '#9a3412', strokeStyle: 'dashed' },
  coach: { strokeColor: '#1d4ed8', strokeStyle: 'solid' },
};
type Custom = { author?: NonNullable<Author>; group?: string; highlight?: boolean };

type Made = ReturnType<typeof convertToExcalidrawElements>;

/** The elements a skeleton lays out to, styled and marked for their author, not yet on the board. */
const build = (skeleton: NonNullable<Skeleton>, author?: Author, custom: Omit<Custom, 'author'> = {}): Made =>
  convertToExcalidrawElements(author ? skeleton.map((s) => ({ ...s, ...AUTHOR_STYLE[author] })) : skeleton).map((e) => (author ? { ...e, customData: { ...(e.customData ?? {}), author, ...custom } } : e));

const add = (api: Api, skeleton: NonNullable<Skeleton>, author?: Author, custom: Omit<Custom, 'author'> = {}) => {
  const made = build(skeleton, author, custom);
  api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...made] });
  return made;
};

const asPen = (made: Made) => made as unknown as PenElement[];

const customOf = (e: { customData?: unknown }): Custom => (e.customData && typeof e.customData === 'object' ? (e.customData as Custom) : {});
const isShape = (e: { type: string }) => e.type === 'rectangle' || e.type === 'ellipse' || e.type === 'diamond';

export type BoxOptions = {
  /** A store (oval) or a decision (diamond); a box otherwise. */
  kind?: 'box' | 'oval' | 'diamond';
  /** Placed beside the other boxes of this group, and marked with it. */
  group?: string;
  /** Exactly here (a renamed box keeps its place). */
  at?: { x: number; y: number };
};

function boxSkeleton(api: Api, label: string, opts: BoxOptions): NonNullable<Skeleton> {
  const type = opts.kind === 'oval' ? 'ellipse' : opts.kind === 'diamond' ? 'diamond' : 'rectangle';
  let spot = opts.at ?? nextSpot(api);
  if (opts.group && !opts.at) {
    // Beside the last box of the group, when it has one.
    const peers = api.getSceneElements().filter((e) => isShape(e) && customOf(e).group === opts.group);
    const last = peers[peers.length - 1];
    if (last) spot = { x: last.x + last.width + GAP / 2, y: last.y };
  }
  return [{ type, x: spot.x, y: spot.y, ...BOX, label: { text: label } }];
}

/** A labelled box, laid out by the library; returns its element id. */
export function addBox(api: Api, label: string, author?: Author, opts: BoxOptions = {}): string {
  const made = add(api, boxSkeleton(api, label, opts), author, opts.group ? { group: opts.group } : {});
  return made.find((e) => isShape(e))?.id ?? made[0].id;
}

/** The same box, built for the pen to draw (lib/board/pen): the shape and its label, not yet on the board. */
export function buildBox(api: Api, label: string, author?: Author, opts: BoxOptions = {}): { id: string; elements: PenElement[] } {
  const made = build(boxSkeleton(api, label, opts), author, opts.group ? { group: opts.group } : {});
  return { id: made.find((e) => isShape(e))?.id ?? made[0].id, elements: asPen(made) };
}

export type ArrowOptions = { dashed?: boolean; both?: boolean };

function arrowSkeleton(api: Api, from: string, to: string, label: string, opts: ArrowOptions): NonNullable<Skeleton> | null {
  const a = api.getSceneElements().find((e) => e.id === from);
  const b = api.getSceneElements().find((e) => e.id === to);
  if (!a || !b) return null;
  return [
    {
      type: 'arrow',
      x: a.x + a.width,
      y: a.y + a.height / 2,
      width: Math.max(10, b.x - (a.x + a.width)),
      height: 0,
      start: { id: from },
      end: { id: to },
      ...(label ? { label: { text: label } } : {}),
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

function noteSkeleton(api: Api, text: string, near: string | null): NonNullable<Skeleton> {
  const box = near ? api.getSceneElements().find((e) => e.id === near) : null;
  const spot = box ? { x: box.x, y: box.y + box.height + GAP / 4 } : nextSpot(api);
  return [{ type: 'text', x: spot.x, y: spot.y, text, fontSize: 14 }];
}

/** A sticky note (free text) beside a box, or under everything when `near` is null. */
export function addNote(api: Api, text: string, near: string | null, author?: Author): void {
  add(api, noteSkeleton(api, text, near), author);
}

/** The same note, built for the pen to write. */
export function buildNote(api: Api, text: string, near: string | null, author?: Author): PenElement[] {
  return asPen(build(noteSkeleton(api, text, near), author));
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
  type Target = Parameters<Api['scrollToContent']>[0];
  const bring = async (els: readonly PenElement[], fit: boolean) => {
    if (!els.length) return;
    api.scrollToContent(els as unknown as Target, { fitToViewport: fit, animate: true, duration: 300 });
  };
  return {
    getElements: () => api.getSceneElements() as unknown as readonly PenElement[],
    commit: (next, { history }) => api.updateScene({ elements: next as unknown as Scene, captureUpdate: history === 'record' ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER }),
    toViewport: (p) => {
      const { scrollX, scrollY, zoom } = api.getAppState();
      return { x: (p.x + scrollX) * zoom.value, y: (p.y + scrollY) * zoom.value };
    },
    fit: (_all, recent) => bring(recent, false),
    fitAll: () => bring(api.getSceneElements() as unknown as readonly PenElement[], true),
    reveal: (els) => bring(els, false),
  };
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
