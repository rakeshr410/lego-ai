// Where the model's drawings go on the board and how the view follows them (InterviewBoard.tsx,
// ExcalidrawCanvas.tsx), as plain geometry so it is tested without a canvas:
//
// - `freeSpot`: a box or a note the model did not place lands on empty board, never on what is drawn.
// - `arrowRoute`: an arrow leaves the side of its box that faces the other one and ends on the facing side
//   of that one (level with both when they overlap), and when the straight line would cross a box, or is too
//   short for its label to sit on it with line showing at both ends, it goes around, below or above, with the
//   label on the open middle stretch.
// - `viewFor`: the view that shows a rectangle whole, clear of the canvas's toolbar, no closer than 1:1.

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

export const right = (r: Rect) => r.x + r.w;
export const bottom = (r: Rect) => r.y + r.h;
const cx = (r: Rect) => r.x + r.w / 2;
const cy = (r: Rect) => r.y + r.h / 2;

export const union = (rects: readonly Rect[]): Rect | null => {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map(right)) - x, h: Math.max(...rects.map(bottom)) - y };
};

export const overlaps = (a: Rect, b: Rect, pad = 0) => a.x < right(b) + pad && b.x < right(a) + pad && a.y < bottom(b) + pad && b.y < bottom(a) + pad;
export const contains = (outer: Rect, inner: Rect, pad = 0) =>
  inner.x >= outer.x - pad && inner.y >= outer.y - pad && right(inner) <= right(outer) + pad && bottom(inner) <= bottom(outer) + pad;

/** Space kept between a placed box and anything else. */
export const GAP = 40;

/**
 * The first spot for a `size` box, among `tries` (in order of preference), that is clear of everything in
 * `taken` by GAP/2; when none is, a spot under everything, at the left of what is drawn.
 */
export function freeSpot(size: { w: number; h: number }, taken: readonly Rect[], tries: readonly Point[]): Point {
  const clear = (p: Point) => !taken.some((t) => overlaps({ ...p, ...size }, t, GAP / 2));
  for (const p of tries) if (clear(p)) return p;
  const all = union(taken);
  if (!all) return tries[0] ?? { x: 0, y: 0 };
  // Under everything, sliding right along that row until clear (a tall region may sit at the left).
  const y = bottom(all) + GAP;
  for (let x = all.x; x < right(all) + size.w; x += size.w / 2 + GAP / 2) if (clear({ x, y })) return { x, y };
  return { x: all.x, y };
}

/**
 * Where the next box goes when the model gives no place: in the row of the last box drawn, to its right,
 * when that is free and the row has fewer than four; otherwise in a new row under everything.
 */
export function nextBoxSpot(size: { w: number; h: number }, boxes: readonly Rect[], taken: readonly Rect[]): Point {
  if (!taken.length) return { x: 0, y: 0 };
  const last = boxes[boxes.length - 1];
  const tries: Point[] = [];
  if (last) {
    const row = boxes.filter((b) => Math.abs(b.y - last.y) < 20);
    if (row.length < 4) tries.push({ x: Math.max(...row.map(right)) + GAP, y: last.y });
  }
  return freeSpot(size, taken, tries);
}

/** Where a note goes beside a box: under it, then beside it, then under the notes already there. */
export function noteSpot(size: { w: number; h: number }, near: Rect, taken: readonly Rect[]): Point {
  const tries: Point[] = [
    { x: near.x, y: bottom(near) + GAP / 4 },
    { x: right(near) + GAP / 2, y: near.y },
    { x: near.x - size.w - GAP / 2, y: near.y },
  ];
  // Then further down under the box, in steps of a note's height.
  for (let k = 1; k <= 8; k++) tries.push({ x: near.x, y: bottom(near) + GAP / 4 + k * (size.h + GAP / 4) });
  return freeSpot(size, taken, tries);
}

// -------------------------------------------------------------------------------------------------
// Arrows

export type Route = { start: Point; points: [number, number][]; labelSegment: number };

/** Whether the segment a-b passes through the rectangle (Liang-Barsky clipping). */
export function crosses(a: Point, b: Point, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [
    [-dx, a.x - r.x],
    [dx, right(r) - a.x],
    [-dy, a.y - r.y],
    [dy, bottom(r) - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return t1 - t0 > 1e-6;
}

const len = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** How much room a label of these characters needs on its segment, with line showing at both ends. */
export const labelRoom = (label: string, fontSize: number) => (label ? label.length * fontSize * 0.55 + 2 * 22 : 0);

/**
 * The arrow from box `a` to box `b`: its start and its points relative to it, and which segment carries the
 * label. `obstacles` are the shapes it must not cross (not `a`, `b`, or a region either sits in); `room` is
 * what its label needs (labelRoom).
 */
export function arrowRoute(a: Rect, b: Rect, obstacles: readonly Rect[], room: number): Route {
  const hit = (path: Point[]) => obstacles.filter((o) => path.slice(1).some((p, k) => crosses(path[k], p, inflate(o, 2)))).length;
  const candidates: { path: Point[]; label: number }[] = [];

  // Straight, from the facing sides: level across the band two boxes share, else side middle to side middle.
  const sideBySide = b.x >= right(a) || right(b) <= a.x;
  const stacked = b.y >= bottom(a) || bottom(b) <= a.y;
  if (sideBySide && (!stacked || Math.abs(cx(b) - cx(a)) >= Math.abs(cy(b) - cy(a)))) {
    const top = Math.max(a.y, b.y);
    const low = Math.min(bottom(a), bottom(b));
    const toRight = b.x >= right(a);
    const ax = toRight ? right(a) : a.x;
    const bx = toRight ? b.x : right(b);
    if (low - top >= 16) {
      const y = (top + low) / 2;
      candidates.push({ path: [{ x: ax, y }, { x: bx, y }], label: 0 });
    } else candidates.push({ path: [{ x: ax, y: cy(a) }, { x: bx, y: cy(b) }], label: 0 });
  } else if (stacked) {
    const left = Math.max(a.x, b.x);
    const far = Math.min(right(a), right(b));
    const down = b.y >= bottom(a);
    const ay = down ? bottom(a) : a.y;
    const by = down ? b.y : bottom(b);
    if (far - left >= 16) {
      const x = (left + far) / 2;
      candidates.push({ path: [{ x, y: ay }, { x, y: by }], label: 0 });
    } else candidates.push({ path: [{ x: cx(a), y: ay }, { x: cx(b), y: by }], label: 0 });
  } else {
    // Overlapping boxes: centre to centre.
    candidates.push({ path: [{ x: cx(a), y: cy(a) }, { x: cx(b), y: cy(b) }], label: 0 });
  }

  // Around, under or over both and whatever lies between: down (up) from each, across the open stretch.
  const between = union([a, b])!;
  const inLane = (o: Rect) => o.x < right(between) && right(o) > between.x;
  const under = Math.max(bottom(a), bottom(b), ...obstacles.filter((o) => inLane(o) && o.y < bottom(between) + GAP).map(bottom)) + GAP / 2 + 8;
  const over = Math.min(a.y, b.y, ...obstacles.filter((o) => inLane(o) && bottom(o) > between.y - GAP).map((o) => o.y)) - GAP / 2 - 8;
  candidates.push({ path: [{ x: cx(a), y: bottom(a) }, { x: cx(a), y: under }, { x: cx(b), y: under }, { x: cx(b), y: bottom(b) }], label: 1 });
  candidates.push({ path: [{ x: cx(a), y: a.y }, { x: cx(a), y: over }, { x: cx(b), y: over }, { x: cx(b), y: b.y }], label: 1 });

  const fits = (c: { path: Point[]; label: number }) => len(c.path[c.label], c.path[c.label + 1]) >= room;
  const scored = candidates.map((c, k) => ({ c, k, crossings: hit(c.path), fits: fits(c) }));
  // Fewest crossings, then a label that fits, then the earlier (simpler) shape.
  scored.sort((p, q) => p.crossings - q.crossings || Number(q.fits) - Number(p.fits) || p.k - q.k);
  const best = scored[0].c;
  const start = best.path[0];
  return { start, points: best.path.map((p) => [p.x - start.x, p.y - start.y]), labelSegment: best.label };
}

const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

// -------------------------------------------------------------------------------------------------
// The view

export type Viewport = { width: number; height: number };
export type View = { scrollX: number; scrollY: number; zoom: number };

/** What the canvas's own controls cover: the toolbar along the top, the zoom and help buttons at the bottom. */
export const INSETS = { top: 76, right: 24, bottom: 64, left: 24 };

/** The scene rectangle the view shows. */
export function visibleRect(view: View, vp: Viewport): Rect {
  return { x: -view.scrollX + INSETS.left / view.zoom, y: -view.scrollY + INSETS.top / view.zoom, w: (vp.width - INSETS.left - INSETS.right) / view.zoom, h: (vp.height - INSETS.top - INSETS.bottom) / view.zoom };
}

/**
 * The view that shows `r` whole in the area clear of the controls, at most at `maxZoom`: centred across, and from
 * the top down, so a board's title sits just under the toolbar and the drawing grows down the screen.
 */
export function viewFor(r: Rect, vp: Viewport, maxZoom = 1, minZoom = 0.3): View {
  const w = Math.max(1, vp.width - INSETS.left - INSETS.right);
  const h = Math.max(1, vp.height - INSETS.top - INSETS.bottom);
  const pad = 24;
  const zoom = Math.max(minZoom, Math.min(maxZoom, w / (r.w + 2 * pad), h / (r.h + 2 * pad)));
  // screen = (scene + scroll) * zoom: the rectangle's centre across at the clear area's, its top at the area's top.
  const scrollX = (INSETS.left + w / 2) / zoom - cx(r);
  const scrollY = INSETS.top / zoom + pad - r.y;
  return { scrollX, scrollY, zoom };
}

/** The zoom below which a whole board is too small to read, and the view frames the drawing being made instead. */
export const READABLE_ZOOM = 0.62;

/**
 * Where the view goes for a drawing just made (`recent`), on a board whose drawn content is `all` and whose
 * regions are `regions`: nowhere while all of it is already in view; the whole board when it can be shown at a
 * readable size; else the drawing with the region it sits in.
 */
export function followView(current: View, vp: Viewport, all: readonly Rect[], recent: readonly Rect[], regions: readonly Rect[]): View | null {
  const ink = union(recent);
  if (!ink) return null;
  const seen = visibleRect(current, vp);
  const everything = union(all);
  if (everything) {
    const whole = viewFor(everything, vp);
    // The whole board in view and at a size to read: show it whole, without moving when it already is.
    if (whole.zoom >= READABLE_ZOOM) return contains(seen, everything, 4) && current.zoom >= READABLE_ZOOM ? null : whole;
  }
  if (contains(seen, ink, 4) && current.zoom >= READABLE_ZOOM) return null;
  const home = regions.filter((g) => contains(g, ink, 8) || overlaps(g, ink));
  const focus = union([ink, ...home])!;
  const framed = viewFor(focus, vp);
  return framed.zoom >= READABLE_ZOOM * 0.8 ? framed : viewFor(ink, vp);
}
