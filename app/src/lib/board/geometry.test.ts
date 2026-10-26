import { describe, expect, it } from 'vitest';
import { arrowRoute, bottom, crosses, followView, freeSpot, labelRoom, nextBoxSpot, noteSpot, overlaps, right, viewFor, visibleRect, type Rect } from './geometry';

// Where the model's drawings land and how the view follows them (geometry.ts).

const box = (x: number, y: number, w = 160, h = 64): Rect => ({ x, y, w, h });
const at = (r: { start: { x: number; y: number }; points: [number, number][] }) => r.points.map(([x, y]) => [r.start.x + x, r.start.y + y]);

describe('placing what the model did not place', () => {
  it('puts the next box beside the last one, and under everything once that spot is taken', () => {
    const a = box(0, 0);
    expect(nextBoxSpot({ w: 160, h: 64 }, [a], [a])).toEqual({ x: 200, y: 0 });
    // A region drawn to the right of the row: the box goes under everything instead of on top of it.
    const region = { x: 180, y: -40, w: 600, h: 300 };
    const spot = nextBoxSpot({ w: 160, h: 64 }, [a], [a, region]);
    expect(overlaps({ ...spot, w: 160, h: 64 }, region)).toBe(false);
    expect(overlaps({ ...spot, w: 160, h: 64 }, a)).toBe(false);
  });

  it('never stacks two notes on the same spot under a box', () => {
    const near = box(0, 0);
    const size = { w: 300, h: 20 };
    const first = noteSpot(size, near, [near]);
    const second = noteSpot(size, near, [near, { ...first, ...size }]);
    const third = noteSpot(size, near, [near, { ...first, ...size }, { ...second, ...size }]);
    const notes = [first, second, third].map((p) => ({ ...p, ...size }));
    for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) expect(overlaps(notes[i], notes[j])).toBe(false);
  });

  it('falls back to a free row under everything', () => {
    const taken = [box(0, 0, 400, 400)];
    const p = freeSpot({ w: 160, h: 64 }, taken, [{ x: 10, y: 10 }]);
    expect(p.y).toBeGreaterThanOrEqual(400);
  });
});

describe('arrows', () => {
  it('runs level between boxes side by side, from facing side to facing side', () => {
    const r = arrowRoute(box(0, 0), box(300, 20), [], 0);
    expect(at(r)).toEqual([
      [160, 42],
      [300, 42],
    ]);
  });

  it('meets a box in another row on its facing side, not at its corner height', () => {
    const r = arrowRoute(box(0, 0), box(0, 200), [], 0);
    expect(at(r)).toEqual([
      [80, 64],
      [80, 200],
    ]);
  });

  it('goes around a box in its way', () => {
    const a = box(0, 0);
    const mid = box(220, 0);
    const b = box(440, 0);
    const r = arrowRoute(a, b, [mid], 0);
    const pts = at(r).map(([x, y]) => ({ x, y }));
    expect(pts.length).toBe(4);
    for (let k = 1; k < pts.length; k++) expect(crosses(pts[k - 1], pts[k], mid)).toBe(false);
    expect(r.labelSegment).toBe(1);
  });

  it('takes the long way when the gap is too short for its label to show line at both ends', () => {
    const a = box(0, 0);
    const b = box(200, 0);
    const room = labelRoom('settled by', 16);
    expect(room).toBeGreaterThan(40);
    const r = arrowRoute(a, b, [], room);
    const pts = at(r);
    expect(pts.length).toBe(4);
    const [p, q] = [pts[r.labelSegment], pts[r.labelSegment + 1]];
    expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeGreaterThanOrEqual(room);
    // A label that fits keeps the straight arrow.
    expect(arrowRoute(a, box(400, 0), [], room).points.length).toBe(2);
  });
});

describe('the view', () => {
  const vp = { width: 1000, height: 700 };

  it('shows a rectangle whole, clear of the toolbar, never closer than 1:1', () => {
    const r = { x: 100, y: 100, w: 400, h: 200 };
    const v = viewFor(r, vp);
    expect(v.zoom).toBe(1);
    const seen = visibleRect(v, vp);
    expect(seen.x).toBeLessThanOrEqual(r.x);
    expect(seen.y).toBeLessThanOrEqual(r.y);
    expect(right(seen)).toBeGreaterThanOrEqual(right(r));
    expect(bottom(seen)).toBeGreaterThanOrEqual(bottom(r));
    // Centred across, at the top of the area under the toolbar (a lone title is not left in the middle).
    expect(seen.x + seen.w / 2).toBeCloseTo(r.x + r.w / 2);
    expect(r.y - seen.y).toBe(24);
  });

  it('stays put while the drawing is in view, and frames the whole board when it fits readably', () => {
    const all = [box(0, 0), box(300, 0)];
    const v = viewFor({ x: 0, y: 0, w: 460, h: 64 }, vp);
    expect(followView(v, vp, all, [all[1]], [])).toBeNull();
    const far = box(1100, 0);
    const next = followView(v, vp, [...all, far], [far], []);
    expect(next).not.toBeNull();
    const seen = visibleRect(next!, vp);
    expect(seen.x).toBeLessThanOrEqual(0);
    expect(right(seen)).toBeGreaterThanOrEqual(1260);
  });

  it('frames the drawing with its region when the whole board is too big to read', () => {
    const region = { x: 3000, y: 0, w: 700, h: 400 };
    const ink = box(3100, 100);
    const all = [box(0, 0), region, ink];
    const v = viewFor(box(0, 0), vp);
    const next = followView(v, vp, all, [ink], [region])!;
    const seen = visibleRect(next, vp);
    expect(seen.x).toBeLessThanOrEqual(region.x);
    expect(right(seen)).toBeGreaterThanOrEqual(right(region));
    expect(seen.x).toBeGreaterThan(160);
  });
});
