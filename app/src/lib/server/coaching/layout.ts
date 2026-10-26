import type { DrawOp } from '../interview/draw';
import { BOX_CELLS, CELL, type BoardArrow, type BoardElement } from './schema';

// A lesson's board, as the coach draws it (docs/coaching.md, "Drawing"): the pack names every
// element and arrow by id and places it on a grid, and the coach puts them on the board with
// <place ids="..."/> as it teaches. Here an id becomes the drawing operation the room performs, at
// its place: a region is a labelled panel, a box keeps its kind, size and tone, a note its spot, an
// arrow its words. The board keeps naming elements by label, so the learner's own arrows, the
// matcher and the coach's highlights work on placed elements as on any other.

export type LayoutEntry = (BoardElement & { type: 'element'; slot?: { list: string; n: number } }) | (BoardArrow & { type: 'arrow' });
/** Every element and arrow a lesson's board can show, by id. */
export type Layout = ReadonlyMap<string, LayoutEntry>;

const px = ([x, y]: readonly [number, number]) => ({ x: x * CELL, y: y * CELL });

/** The operation that draws one id (an arrow names its ends by their labels), or why there is none. */
export function placeOp(layout: Layout, id: string): { op: DrawOp } | { error: string } {
  const x = layout.get(id);
  if (!x) return { error: `place "${id}": no such id in this lesson's board plan` };
  if (x.type === 'arrow') {
    const from = layout.get(x.from);
    const to = layout.get(x.to);
    if (from?.type !== 'element' || to?.type !== 'element') return { error: `place "${id}": its ends are not in the board plan` };
    return { op: { op: 'arrow', from: from.label, to: to.label, ...(x.label ? { label: x.label } : {}), ...(x.dashed ? { dashed: true } : {}), ...(x.both ? { both: true } : {}) } };
  }
  const at = px(x.at);
  // A list's line, numbered in the pack's order (a lesson that asks the learner numbers it as written: draw.ts).
  if (x.kind === 'note') return { op: { op: 'note', text: x.slot ? `${x.slot.n}. ${x.label}` : x.label, at, ...(x.slot ? { list: x.slot.list, covers: x.id } : {}) } };
  if (x.kind === 'region') {
    const [w, h] = x.size ?? [20, 10];
    return { op: { op: 'region', label: x.label, at, size: { w: w * CELL, h: h * CELL }, ...(x.tone ? { tone: x.tone } : {}), ...(x.dashed ? { dashed: true } : {}) } };
  }
  const [w, h] = x.size ?? BOX_CELLS;
  return { op: { op: 'box', label: x.label, ...(x.kind !== 'box' ? { kind: x.kind } : {}), at, size: { w: w * CELL, h: h * CELL }, ...(x.tone ? { tone: x.tone } : {}), ...(x.dashed ? { dashed: true } : {}) } };
}

/** The ids a pack's board starts with on a fresh lesson (what it keeps from earlier packs), in an order that draws regions before what sits in them and elements before arrows. */
export function startIds(layout: Layout, keep: readonly string[]): string[] {
  const entries = keep.map((id) => layout.get(id)).filter((x): x is LayoutEntry => !!x);
  const rank = (x: LayoutEntry) => (x.type === 'arrow' ? 2 : x.kind === 'region' ? 0 : 1);
  return entries.sort((a, b) => rank(a) - rank(b)).map((x) => x.id);
}

/** The board plan as the coach reads it: one line per id, in the beat's drawing order, with where it goes. */
export function layoutLine(x: LayoutEntry, layout: Layout): string {
  if (x.type === 'arrow') {
    const name = (id: string) => (layout.get(id) as BoardElement | undefined)?.label ?? id;
    return `${x.id}: arrow ${name(x.from)} -> ${name(x.to)}${x.label ? ` "${x.label}"` : ''}${x.dashed ? ', dashed' : ''}${x.both ? ', both ways' : ''}`;
  }
  const inside = x.in ? ` in ${(layout.get(x.in) as BoardElement | undefined)?.label ?? x.in}` : '';
  return `${x.id}: ${x.kind} "${x.label}"${inside}${x.dashed ? ', dashed' : ''}`;
}
