import type { DrawOp, Point, Size } from '../interview/draw';
import type { Layout } from './layout';
import { BOX_CELLS, CELL } from './schema';

// The coach's own drawing in a lesson (docs/coaching.md, "Side notes"): what it sketches or writes beyond
// the board plan, to answer a doubt, goes in a lane to the right of everything the plan can place, so it
// never takes a spot a later part needs. A reply's sketch starts on a fresh row, level with the part last
// placed when the lane above it is free, so the view stays near the lesson; boxes go two to a row with
// room for an arrow's words between them, notes on lines of their own. A note runs on to the right and
// rows run on down into empty board, past anything the plan places.

/** Where the lane starts, in board pixels: its left edge, and the top of the next sketch. */
export type Aside = Point;

/** Cells between the plan's right edge and the lane. */
const MARGIN = 4;
/** Boxes a row, and the cells between them (an arrow and its words). */
const PER_ROW = 2;
const BETWEEN = 8;
/** Cells under a row of boxes (a downward arrow and its words), under a note, and between two sketches. */
const ROW_GAP = 3;
const NOTE_GAP = 1;
const SKETCH_GAP = 2;

export const ASIDE_BOX: Size = { w: BOX_CELLS[0] * CELL, h: BOX_CELLS[1] * CELL };

/** The width a note takes, in cells (as the pack check counts it). */
const noteCells = (text: string) => Math.ceil(text.length * 0.45) + 1;

/** The plan's right edge, in cells: every element it can place, kept or not. */
function rightEdge(layout: Layout): number {
  let right = 0;
  for (const x of layout.values()) {
    if (x.type !== 'element') continue;
    const w = x.kind === 'note' ? noteCells(x.label) : (x.size?.[0] ?? BOX_CELLS[0]);
    right = Math.max(right, x.at[0] + w);
  }
  return right;
}

/**
 * Where this reply's sketch goes, from what earlier replies drew: under the lane's last sketch, and no
 * higher than the part of the plan placed last (a sketch beside the lesson where it stands).
 */
export function asideFor(layout: Layout, earlier: readonly DrawOp[]): Aside {
  const x = (rightEdge(layout) + MARGIN) * CELL;
  let next = CELL;
  let level = CELL;
  for (const o of earlier) {
    if ((o.op !== 'box' && o.op !== 'note' && o.op !== 'region') || !o.at) continue;
    if (o.at.x >= x) next = Math.max(next, o.at.y + (o.op === 'note' ? CELL : (o.size?.h ?? ASIDE_BOX.h)) + SKETCH_GAP * CELL);
    else level = o.at.y;
  }
  return { x, y: Math.max(next, level) };
}

/** The spots of one reply's sketch, in the order it draws. */
export function asidePlacer(start: Aside): { box: () => Point; note: () => Point } {
  let y = start.y;
  let col = 0;
  const newRow = () => {
    if (col > 0) y += ASIDE_BOX.h + ROW_GAP * CELL;
    col = 0;
  };
  return {
    box: () => {
      if (col >= PER_ROW) newRow();
      const at = { x: start.x + col * (BOX_CELLS[0] + BETWEEN) * CELL, y };
      col += 1;
      return at;
    },
    note: () => {
      newRow();
      const at = { x: start.x, y };
      y += (1 + NOTE_GAP) * CELL;
      return at;
    },
  };
}
