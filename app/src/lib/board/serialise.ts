// The whiteboard serialiser (docs/README.md "The whiteboard"; design section 7): an
// Excalidraw scene as a small graph and as the text the interviewer and the grader read. Shared by
// the browser (the room computes the fingerprint and compacts the scene it posts) and the server
// (the only side that serialises, keeps the graph and renders the prompt), so it imports nothing.
//
// Nodes are rectangles, ellipses and diamonds; their label is the text bound to them, else a free
// text whose centre is inside them, else a caption just below them, else "(unlabelled)". Free text
// that labels nothing is a note. Frames, shared groups and a shape that encloses two or more
// nodes contain nodes. Arrows are edges by their bindings; an unbound end snaps to the nearest
// node within ENDPOINT_SNAP and is marked inferred; an arrow with a loose end is listed as loose.
// Freehand strokes are counted and clustered, never serialised. Short ids (n1, e1, F1) are stable
// across versions through the `ids` map the caller keeps with the board.

/** A scene element with only what the serialiser reads (the room compacts before posting). */
export type BoardElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  isDeleted?: boolean;
  text?: string;
  /** Frames: their title. */
  name?: string | null;
  containerId?: string | null;
  frameId?: string | null;
  groupIds?: readonly string[];
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  /** Linear elements: points relative to (x, y). Freehand keeps only `pointCount`. */
  points?: readonly (readonly [number, number])[];
  pointCount?: number;
  strokeStyle?: string;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  customData?: Record<string, unknown>;
  /** How it looks (colours, text, corners, what is bound to it): read by no one here, kept so a board loaded again looks as it was drawn. */
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  roundness?: { type: number } | null;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  lineHeight?: number;
  originalText?: string;
  autoResize?: boolean;
  boundElements?: readonly { id: string; type: string }[];
};

export const NODE_TYPES = new Set(['rectangle', 'ellipse', 'diamond']);
export const EDGE_TYPES = new Set(['arrow', 'line']);
/** A caption sits at most this far below a shape; a loose arrow end snaps to a node this close. */
export const CAPTION_GAP = 24;
export const ENDPOINT_SNAP = 24;
/** Rows of the layout are this tall. */
export const ROW_PX = 160;
export const LABEL_MAX = 80;
export const NOTE_MAX = 200;
/** Scenes with more elements than this are refused by the server (design section 7). */
export const MAX_ELEMENTS = 400;
/** A board is freehand-heavy when strokes outnumber nodes and there are at least this many. */
export const FREEHAND_HEAVY_MIN = 6;

export type Shape = 'box' | 'oval' | 'diamond' | 'note';
/** Who drew an element besides the candidate: the interviewer or the coach (the room marks it; draw.ts). */
export type Author = 'interviewer' | 'coach';
export const AUTHORS: readonly Author[] = ['interviewer', 'coach'];
const authorOf = (data: unknown): Author | null => {
  const a = data && typeof data === 'object' ? (data as { author?: unknown }).author : null;
  return typeof a === 'string' && (AUTHORS as readonly string[]).includes(a) ? (a as Author) : null;
};

export type BoardNode = {
  id: string;
  eid: string;
  label: string | null;
  shape: Shape;
  /** The containing frame's short id, if any. */
  frame: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Who drew it: the candidate unless the room marked it. */
  author?: Author;
};
export type BoardFrame = { id: string; eid: string; label: string | null; kind: 'frame' | 'group' | 'shape'; members: string[] };
export type BoardEdge = {
  id: string;
  eid: string;
  /** Short ids, or null for an end that resolved to nothing. */
  from: string | null;
  to: string | null;
  label: string | null;
  direction: 'forward' | 'both' | 'none';
  dashed: boolean;
  /** At least one end was matched by distance, not a binding. */
  inferred: boolean;
};

export type BoardGraph = {
  nodes: BoardNode[];
  frames: BoardFrame[];
  edges: BoardEdge[];
  freehand: { count: number; clusters: { near: string | null; count: number }[] };
  layout: { direction: 'left-to-right' | 'top-to-bottom'; rows: string[][] };
};

export type IdMap = Record<string, string>;

/** Every string in the graph the model reads, escaped for the tagged prompt. */
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

// ---------------------------------------------------------------------------------------
// Fingerprint and compaction

/** FNV-1a over `id:version` of the live elements, in id order: the same scene gives the same print. */
export function fingerprint(elements: readonly Pick<BoardElement, 'id' | 'version' | 'isDeleted'>[]): string {
  const parts = elements
    .filter((e) => !e.isDeleted)
    .map((e) => `${e.id}:${e.version}`)
    .sort();
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

const COLOR = /^(#[0-9a-fA-F]{3,8}|transparent)$/;
const WORD = /^[a-z-]{1,16}$/;

/** The room's own marks besides the author (a group, a region, a highlight ring): strings and booleans only. */
function flags(data: unknown): Record<string, unknown> {
  const d = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof d.group === 'string') out.group = d.group.slice(0, 60);
  for (const k of ['region', 'highlight'] as const) if (d[k] === true) out[k] = true;
  return out;
}

/** Copies how an element looks onto its compact form, checked, so a reload draws it the same. */
function look(e: Record<string, unknown>, c: BoardElement) {
  for (const k of ['strokeColor', 'backgroundColor'] as const) if (typeof e[k] === 'string' && COLOR.test(e[k])) c[k] = e[k];
  for (const k of ['fillStyle', 'textAlign', 'verticalAlign'] as const) if (typeof e[k] === 'string' && WORD.test(e[k])) c[k] = e[k];
  for (const k of ['strokeWidth', 'roughness', 'opacity', 'fontSize', 'fontFamily', 'lineHeight'] as const) if (typeof e[k] === 'number' && Number.isFinite(e[k])) c[k] = e[k];
  if (typeof e.autoResize === 'boolean') c.autoResize = e.autoResize;
  const r = e.roundness as { type?: unknown } | null | undefined;
  if (r && typeof r.type === 'number') c.roundness = { type: r.type };
  if (c.type === 'text' && typeof e.originalText === 'string') c.originalText = e.originalText.slice(0, 1000);
  if (Array.isArray(e.boundElements))
    c.boundElements = e.boundElements
      .filter((b): b is { id: string; type: string } => !!b && typeof b === 'object' && typeof (b as { id?: unknown }).id === 'string' && typeof (b as { type?: unknown }).type === 'string')
      .slice(0, 32)
      .map((b) => ({ id: b.id, type: b.type }));
}

/**
 * The scene reduced to what the serialiser reads and how each element looks, deleted elements
 * dropped, freehand reduced to its box and point count. Unknown element types are kept by id, type
 * and box only (so the fingerprint still covers them). The room loads a board again from this
 * copy, so its colours, label sizes and bindings come back as they were drawn.
 */
export function compactElements(raw: readonly unknown[]): BoardElement[] {
  const out: BoardElement[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const e = r as Record<string, unknown>;
    if (e.isDeleted === true) continue;
    const id = str(e.id);
    const type = str(e.type);
    if (!id || !type) continue;
    const c: BoardElement = { id, type, x: num(e.x), y: num(e.y), width: num(e.width), height: num(e.height), version: num(e.version, 1) };
    if (type === 'text' && typeof e.text === 'string') c.text = e.text.slice(0, 1000);
    if ((type === 'frame' || type === 'magicframe') && typeof e.name === 'string') c.name = e.name.slice(0, 200);
    if (typeof e.containerId === 'string') c.containerId = e.containerId;
    if (typeof e.frameId === 'string') c.frameId = e.frameId;
    if (Array.isArray(e.groupIds) && e.groupIds.length) c.groupIds = e.groupIds.filter((g): g is string => typeof g === 'string').slice(0, 8);
    if (EDGE_TYPES.has(type)) {
      const bind = (b: unknown) => (b && typeof b === 'object' && typeof (b as { elementId?: unknown }).elementId === 'string' ? { elementId: (b as { elementId: string }).elementId } : null);
      c.startBinding = bind(e.startBinding);
      c.endBinding = bind(e.endBinding);
      const pts = Array.isArray(e.points) ? e.points : [];
      c.points = pts.filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2).map((p) => [num(p[0]), num(p[1])] as const);
      if (typeof e.startArrowhead === 'string') c.startArrowhead = e.startArrowhead;
      if (typeof e.endArrowhead === 'string') c.endArrowhead = e.endArrowhead;
    }
    if (type === 'freedraw') c.pointCount = Array.isArray(e.points) ? e.points.length : 0;
    if (typeof e.strokeStyle === 'string' && e.strokeStyle !== 'solid') c.strokeStyle = e.strokeStyle;
    const author = authorOf(e.customData);
    if (author) c.customData = { author, ...flags(e.customData) };
    look(e, c);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Geometry

type Box = { x: number; y: number; w: number; h: number };
const boxOf = (e: BoardElement): Box => ({ x: Math.min(e.x, e.x + e.width), y: Math.min(e.y, e.y + e.height), w: Math.abs(e.width), h: Math.abs(e.height) });
const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const inside = (p: { x: number; y: number }, b: Box, pad = 0) => p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
const contains = (outer: Box, inner: Box) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const overlapX = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** The absolute endpoints of a linear element. */
function ends(e: BoardElement): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const pts = e.points?.length ? e.points : [[0, 0] as const];
  const first = pts[0];
  const last = pts[pts.length - 1];
  return { start: { x: e.x + first[0], y: e.y + first[1] }, end: { x: e.x + last[0], y: e.y + last[1] } };
}

// ---------------------------------------------------------------------------------------
// Serialisation

/** Hands out the next short id for a prefix, keeping the ones already in the map. */
function shortIds(ids: IdMap) {
  const next: Record<string, number> = {};
  for (const v of Object.values(ids)) {
    const m = /^([a-zA-Z]+)(\d+)$/.exec(v);
    if (m) next[m[1]] = Math.max(next[m[1]] ?? 0, Number(m[2]));
  }
  return (eid: string, prefix: string) => {
    const have = ids[eid];
    if (have && have.startsWith(prefix)) return have;
    const n = (next[prefix] ?? 0) + 1;
    next[prefix] = n;
    ids[eid] = `${prefix}${n}`;
    return ids[eid];
  };
}

/**
 * The graph of a scene. `ids` maps Excalidraw ids to short ids and is extended in place, so the
 * same box keeps its name from one version to the next.
 */
export function serialise(elements: readonly BoardElement[], ids: IdMap = {}): BoardGraph {
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const short = shortIds(ids);
  const texts = live.filter((e) => e.type === 'text' && (e.text ?? '').trim());
  const usedText = new Set<string>();

  // Shapes, and which of them contain others (frames of the "shape" kind).
  const shapes = live.filter((e) => NODE_TYPES.has(e.type));
  const shapeBoxes = new Map(shapes.map((s) => [s.id, boxOf(s)]));
  const enclosing = new Set<string>();
  for (const s of shapes) {
    const b = shapeBoxes.get(s.id)!;
    const within = shapes.filter((o) => o !== s && contains(b, shapeBoxes.get(o.id)!) && (b.w * b.h) > (shapeBoxes.get(o.id)!.w * shapeBoxes.get(o.id)!.h));
    if (within.length >= 2) enclosing.add(s.id);
  }

  const labelOf = (e: BoardElement): string | null => {
    const b = boxOf(e);
    const bound = texts.find((t) => t.containerId === e.id);
    if (bound) {
      usedText.add(bound.id);
      return clip(bound.text!, LABEL_MAX);
    }
    if (enclosing.has(e.id)) return null;
    const insideText = texts.find((t) => !t.containerId && !usedText.has(t.id) && inside(centre(boxOf(t)), b));
    if (insideText) {
      usedText.add(insideText.id);
      return clip(insideText.text!, LABEL_MAX);
    }
    const caption = texts.find((t) => {
      if (t.containerId || usedText.has(t.id)) return false;
      const tb = boxOf(t);
      return overlapX(tb, b) && tb.y >= b.y + b.h - 2 && tb.y <= b.y + b.h + CAPTION_GAP;
    });
    if (caption) {
      usedText.add(caption.id);
      return clip(caption.text!, LABEL_MAX);
    }
    return null;
  };

  // Enclosing shapes label themselves first, so a title inside the big box is not taken by a small one.
  const frameLabels = new Map<string, string | null>();
  for (const s of shapes.filter((x) => enclosing.has(x.id))) {
    const b = boxOf(s);
    const bound = texts.find((t) => t.containerId === s.id);
    let label: string | null = null;
    if (bound) {
      usedText.add(bound.id);
      label = clip(bound.text!, LABEL_MAX);
    } else {
      // A title: free text inside the shape, not inside any of the shapes it contains.
      const title = texts.find((t) => !t.containerId && !usedText.has(t.id) && inside(centre(boxOf(t)), b) && !shapes.some((o) => o !== s && !enclosing.has(o.id) && inside(centre(boxOf(t)), shapeBoxes.get(o.id)!)));
      if (title) {
        usedText.add(title.id);
        label = clip(title.text!, LABEL_MAX);
      }
    }
    frameLabels.set(s.id, label);
  }

  const nodes: BoardNode[] = [];
  for (const s of shapes) {
    if (enclosing.has(s.id)) continue;
    const b = shapeBoxes.get(s.id)!;
    nodes.push({ id: short(s.id, 'n'), eid: s.id, label: labelOf(s), shape: s.type === 'ellipse' ? 'oval' : s.type === 'diamond' ? 'diamond' : 'box', frame: null, x: b.x, y: b.y, w: b.w, h: b.h, ...(authorOf(s.customData) ? { author: authorOf(s.customData)! } : {}) });
  }
  // Edge labels are claimed before notes, so an arrow's text is never a note.
  const edgesRaw = live.filter((e) => EDGE_TYPES.has(e.type));
  const edgeLabel = new Map<string, string>();
  for (const e of edgesRaw) {
    const t = texts.find((x) => x.containerId === e.id);
    if (t) {
      usedText.add(t.id);
      edgeLabel.set(e.id, clip(t.text!, LABEL_MAX));
    }
  }
  // Free text that labels nothing is a note.
  for (const t of texts) {
    if (usedText.has(t.id) || t.containerId) continue;
    const b = boxOf(t);
    nodes.push({ id: short(t.id, 'n'), eid: t.id, label: clip(t.text!, NOTE_MAX), shape: 'note', frame: null, x: b.x, y: b.y, w: b.w, h: b.h, ...(authorOf(t.customData) ? { author: authorOf(t.customData)! } : {}) });
  }
  const nodeByEid = new Map(nodes.map((n) => [n.eid, n]));

  // Frames: Excalidraw frames, enclosing shapes, shared groups (two or more nodes).
  const frames: BoardFrame[] = [];
  const member = (frameId: string, nodeIds: string[]) => {
    for (const nid of nodeIds) {
      const n = nodes.find((x) => x.id === nid);
      if (n && !n.frame) n.frame = frameId;
    }
  };
  for (const f of live.filter((e) => e.type === 'frame' || e.type === 'magicframe')) {
    const members = nodes.filter((n) => byId.get(n.eid)?.frameId === f.id).map((n) => n.id);
    const fid = short(f.id, 'F');
    frames.push({ id: fid, eid: f.id, label: f.name ? clip(f.name, LABEL_MAX) : null, kind: 'frame', members });
    member(fid, members);
  }
  for (const s of shapes.filter((x) => enclosing.has(x.id))) {
    const b = shapeBoxes.get(s.id)!;
    const members = nodes.filter((n) => !n.frame && contains(b, { x: n.x, y: n.y, w: n.w, h: n.h })).map((n) => n.id);
    const fid = short(s.id, 'F');
    frames.push({ id: fid, eid: s.id, label: frameLabels.get(s.id) ?? null, kind: 'shape', members });
    member(fid, members);
  }
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.frame) continue;
    for (const g of byId.get(n.eid)?.groupIds ?? []) groups.set(g, [...(groups.get(g) ?? []), n.id]);
  }
  for (const [g, members] of groups) {
    if (members.length < 2 || members.some((m) => nodes.find((n) => n.id === m)?.frame)) continue;
    const fid = short(g, 'G');
    frames.push({ id: fid, eid: g, label: null, kind: 'group', members });
    member(fid, members);
  }
  const frameByEid = new Map(frames.map((f) => [f.eid, f]));

  // Edges.
  const resolveBound = (b: { elementId: string } | null | undefined): string | null => {
    if (!b) return null;
    return nodeByEid.get(b.elementId)?.id ?? frameByEid.get(b.elementId)?.id ?? null;
  };
  const nearest = (p: { x: number; y: number }): string | null => {
    let best: { id: string; d: number } | null = null;
    for (const n of nodes) {
      if (n.shape === 'note') continue;
      const b = { x: n.x, y: n.y, w: n.w, h: n.h };
      if (!inside(p, b, ENDPOINT_SNAP)) continue;
      const d = dist(p, centre(b));
      if (!best || d < best.d) best = { id: n.id, d };
    }
    return best?.id ?? null;
  };
  const edges: BoardEdge[] = [];
  for (const e of edgesRaw) {
    const { start, end } = ends(e);
    let inferred = false;
    let from = resolveBound(e.startBinding);
    let to = resolveBound(e.endBinding);
    if (!from) {
      from = nearest(start);
      if (from) inferred = true;
    }
    if (!to) {
      to = nearest(end);
      if (to) inferred = true;
    }
    if (from && to && from === to) to = null;
    const headAtEnd = e.type === 'arrow' ? e.endArrowhead !== null && e.endArrowhead !== undefined ? true : e.startArrowhead ? false : true : !!e.endArrowhead;
    const headAtStart = !!e.startArrowhead;
    const direction: BoardEdge['direction'] = headAtEnd && headAtStart ? 'both' : headAtEnd || headAtStart ? 'forward' : 'none';
    if (direction === 'forward' && headAtStart && !headAtEnd) [from, to] = [to, from];
    edges.push({ id: short(e.id, 'e'), eid: e.id, from, to, label: edgeLabel.get(e.id) ?? null, direction, dashed: e.strokeStyle === 'dashed' || e.strokeStyle === 'dotted', inferred });
  }

  // Freehand: counted and clustered.
  const strokes = live.filter((e) => e.type === 'freedraw');
  const clusters: { cx: number; cy: number; count: number }[] = [];
  for (const s of strokes) {
    const c = centre(boxOf(s));
    const hit = clusters.find((k) => dist({ x: k.cx, y: k.cy }, c) < 120);
    if (hit) {
      hit.cx = (hit.cx * hit.count + c.x) / (hit.count + 1);
      hit.cy = (hit.cy * hit.count + c.y) / (hit.count + 1);
      hit.count++;
    } else clusters.push({ cx: c.x, cy: c.y, count: 1 });
  }
  const nearNode = (p: { x: number; y: number }): string | null => {
    let best: { id: string; d: number } | null = null;
    for (const n of nodes) {
      const d = dist(p, centre({ x: n.x, y: n.y, w: n.w, h: n.h }));
      if (d <= 200 && (!best || d < best.d)) best = { id: n.id, d };
    }
    return best?.id ?? null;
  };

  // Layout: rows by y band, dominant direction from the spread of the node centres.
  const placed = nodes.filter((n) => n.shape !== 'note');
  const xs = placed.map((n) => n.x + n.w / 2);
  const ys = placed.map((n) => n.y + n.h / 2);
  const spread = (v: number[]) => (v.length ? Math.max(...v) - Math.min(...v) : 0);
  const direction = spread(xs) >= spread(ys) ? 'left-to-right' : 'top-to-bottom';
  const bands = new Map<number, BoardNode[]>();
  for (const n of placed) {
    const key = direction === 'left-to-right' ? Math.round((n.y + n.h / 2) / ROW_PX) : Math.round((n.x + n.w / 2) / ROW_PX);
    bands.set(key, [...(bands.get(key) ?? []), n]);
  }
  const rows = [...bands.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list.sort((a, b) => (direction === 'left-to-right' ? a.x - b.x : a.y - b.y)).map((n) => n.id));

  return {
    nodes,
    frames,
    edges,
    freehand: { count: strokes.length, clusters: clusters.map((k) => ({ near: nearNode({ x: k.cx, y: k.cy }), count: k.count })) },
    layout: { direction, rows },
  };
}

// ---------------------------------------------------------------------------------------
// Text

/** Where an unlabelled node sits relative to the nearest labelled one. */
function placeOf(n: BoardNode, graph: BoardGraph): string {
  const c = centre({ x: n.x, y: n.y, w: n.w, h: n.h });
  let best: { n: BoardNode; d: number } | null = null;
  for (const o of graph.nodes) {
    if (o === n || !o.label || o.shape === 'note') continue;
    const d = dist(c, centre({ x: o.x, y: o.y, w: o.w, h: o.h }));
    if (!best || d < best.d) best = { n: o, d };
  }
  if (!best) return '';
  const oc = centre({ x: best.n.x, y: best.n.y, w: best.n.w, h: best.n.h });
  const dx = c.x - oc.x;
  const dy = c.y - oc.y;
  const rel = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right of' : 'left of') : dy > 0 ? 'below' : 'above';
  return ` ${rel} ${best.n.id}`;
}

const quote = (s: string) => `"${escape(s)}"`;

function nodeText(n: BoardNode, graph: BoardGraph): string {
  const label = n.label ? quote(n.label) : '(unlabelled)';
  const place = n.label ? '' : placeOf(n, graph);
  return `${n.id} ${label} [${n.shape}]${n.author ? ` (${n.author})` : ''}${n.frame ? ` in ${n.frame}` : ''}${place}`;
}

function edgeText(e: BoardEdge): string {
  const arrow = e.direction === 'both' ? '<->' : e.direction === 'none' ? '--' : '->';
  const marks = [e.dashed ? 'dashed' : '', e.inferred ? 'inferred' : ''].filter(Boolean);
  return `${e.id} ${e.from ?? '?'} ${arrow} ${e.to ?? '?'}${e.label ? ` ${quote(e.label)}` : ''}${marks.length ? ` (${marks.join(', ')})` : ''}`;
}

export const isLoose = (e: BoardEdge) => !e.from || !e.to;

/** Whether the strokes drown the shapes: nothing to read but a picture. */
export const freehandHeavy = (g: BoardGraph) => g.freehand.count >= FREEHAND_HEAVY_MIN && g.freehand.count > g.nodes.filter((n) => n.shape !== 'note').length;
/** The share of shapes without a readable label. */
export function unlabelledRatio(g: BoardGraph): number {
  const shapes = g.nodes.filter((n) => n.shape !== 'note');
  return shapes.length ? shapes.filter((n) => !n.label).length / shapes.length : 0;
}

/** The whole board as the model reads it (about 230 tokens for a nine-node board). */
export function renderBoard(graph: BoardGraph, attrs: { version: number; stage?: string }): string {
  const shapes = graph.nodes.filter((n) => n.shape !== 'note').length;
  const lines = [`<board v="${attrs.version}"${attrs.stage ? ` stage="${escape(attrs.stage)}"` : ''} nodes="${shapes}" edges="${graph.edges.filter((e) => !isLoose(e)).length}">`];
  if (graph.nodes.length) lines.push(`nodes: ${graph.nodes.map((n) => nodeText(n, graph)).join('; ')}`);
  else lines.push('nodes: (none)');
  if (graph.frames.length) lines.push(`frames: ${graph.frames.map((f) => `${f.id}${f.label ? ` ${quote(f.label)}` : f.kind === 'group' ? ' (group)' : ''}: ${f.members.join(' ') || '(empty)'}`).join('; ')}`);
  const bound = graph.edges.filter((e) => !isLoose(e));
  const loose = graph.edges.filter(isLoose);
  if (bound.length) lines.push(`edges: ${bound.map(edgeText).join('; ')}`);
  if (loose.length) lines.push(`loose: ${loose.map(edgeText).join('; ')}`);
  if (graph.layout.rows.length > 1 || graph.layout.rows[0]?.length > 1) lines.push(`layout: ${graph.layout.direction}; ${graph.layout.rows.map((r) => r.join(' ')).join(' | ')}`);
  if (graph.freehand.count) {
    const near = graph.freehand.clusters.filter((c) => c.near);
    lines.push(`free strokes: ${graph.freehand.count} (${graph.freehand.clusters.length} cluster${graph.freehand.clusters.length === 1 ? '' : 's'}${near.length ? ` near ${[...new Set(near.map((c) => c.near))].join(', ')}` : ''})`);
  }
  lines.push('</board>');
  return lines.join('\n');
}

/**
 * What changed from one graph to the next, keyed by Excalidraw id: added (+), removed (-), changed
 * (~: label, shape, frame or endpoints), pure moves on one line. The full board when the delta
 * would be longer than it.
 */
export function renderDelta(prev: BoardGraph, next: BoardGraph, attrs: { from: number; version: number; stage?: string }): { text: string; full: boolean } {
  const full = renderBoard(next, attrs);
  const lines: string[] = [];
  const moved: string[] = [];
  const prevNodes = new Map(prev.nodes.map((n) => [n.eid, n]));
  const nextNodes = new Map(next.nodes.map((n) => [n.eid, n]));
  for (const n of next.nodes) {
    const p = prevNodes.get(n.eid);
    if (!p) lines.push(`+ ${nodeText(n, next)}`);
    else if (p.label !== n.label || p.shape !== n.shape || p.frame !== n.frame) lines.push(`~ ${nodeText(n, next)}${p.label !== n.label ? ` (was ${p.label ? quote(p.label) : '(unlabelled)'})` : ''}`);
    else if (Math.abs(p.x - n.x) > 1 || Math.abs(p.y - n.y) > 1) moved.push(n.id);
  }
  for (const p of prev.nodes) if (!nextNodes.has(p.eid)) lines.push(`- ${p.id}${p.label ? ` ${quote(p.label)}` : ''}`);
  const prevFrames = new Map(prev.frames.map((f) => [f.eid, f]));
  const nextFrames = new Map(next.frames.map((f) => [f.eid, f]));
  for (const f of next.frames) {
    const p = prevFrames.get(f.eid);
    const text = `${f.id}${f.label ? ` ${quote(f.label)}` : ''}: ${f.members.join(' ') || '(empty)'}`;
    if (!p) lines.push(`+ ${text}`);
    else if (p.label !== f.label || p.members.join(' ') !== f.members.join(' ')) lines.push(`~ ${text}`);
  }
  for (const p of prev.frames) if (!nextFrames.has(p.eid)) lines.push(`- ${p.id}`);
  const prevEdges = new Map(prev.edges.map((e) => [e.eid, e]));
  const nextEdges = new Map(next.edges.map((e) => [e.eid, e]));
  for (const e of next.edges) {
    const p = prevEdges.get(e.eid);
    if (!p) lines.push(`+ ${edgeText(e)}`);
    else if (p.from !== e.from || p.to !== e.to || p.label !== e.label || p.direction !== e.direction || p.dashed !== e.dashed) lines.push(`~ ${edgeText(e)}`);
  }
  for (const p of prev.edges) if (!nextEdges.has(p.eid)) lines.push(`- ${p.id}`);
  if (moved.length) lines.push(`moved: ${moved.join(' ')}`);
  if (next.freehand.count !== prev.freehand.count) lines.push(`free strokes: ${next.freehand.count} (was ${prev.freehand.count})`);
  const body = lines.length ? lines.join('\n') : '(no change)';
  const text = `<board-delta from="${attrs.from}" v="${attrs.version}"${attrs.stage ? ` stage="${escape(attrs.stage)}"` : ''}>\n${body}\n</board-delta>`;
  return text.length > full.length ? { text: full, full: true } : { text, full: false };
}
