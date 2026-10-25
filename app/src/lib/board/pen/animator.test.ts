import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pen, typedWidth, type PenElement, type PenHost } from './animator';
import { REST_MS, SYNC_MOVE_MS, SYNC_SHAPE_MS } from './timing';

// The animated pen (animator.ts; coach-mode.md, phase 5): a box grows and its label is typed, marks land in
// order, an abort drops what is left, an erase takes the element and its bindings off, and a hidden tab lands
// everything at once.

type Host = PenHost & { scene: PenElement[]; commits: { history: 'record' | 'skip' }[] };

const host = (): Host => {
  const h: Host = {
    scene: [],
    commits: [],
    getElements: () => h.scene,
    commit: (next, opts) => {
      h.scene = [...next];
      h.commits.push(opts);
    },
    toViewport: (p) => ({ x: p.x * 2, y: p.y * 2 }),
    fit: async () => {},
    fitAll: async () => {},
  };
  return h;
};

const box = (id: string, label: string, x = 0): PenElement[] => [
  { id, type: 'rectangle', x, y: 0, width: 100, height: 50, version: 1 },
  { id: `${id}-t`, type: 'text', x: x + 10, y: 15, width: 80, height: 20, version: 1, text: label, originalText: label, containerId: id, fontSize: 16, textAlign: 'center' },
];

describe('Pen', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }));
  afterEach(() => vi.useRealTimers());

  it('grows a box from its corner, types its label, and leaves the cursor once it rests', async () => {
    const h = host();
    const cursor: unknown[] = [];
    const pen = new Pen(h, (c) => cursor.push(c));
    const done = pen.drawElements(box('a', 'Gateway'));
    expect(pen.isBusy()).toBe(true);
    // Into the shape's growth (the pen is placed, 120 ms, then it waits 120 ms before the first mark): the
    // rectangle is on the board, smaller than it will be, as a frame (not recorded).
    await vi.advanceTimersByTimeAsync(240 + SYNC_SHAPE_MS / 2);
    const growing = h.scene.find((e) => e.id === 'a')!;
    expect(growing.width).toBeGreaterThan(2);
    expect(growing.width).toBeLessThan(100);
    expect(h.commits.every((c) => c.history === 'skip')).toBe(true);
    // Then the label, typed a few characters at a time.
    await vi.advanceTimersByTimeAsync(SYNC_SHAPE_MS / 2 + 150);
    const typing = h.scene.find((e) => e.id === 'a-t')!;
    expect(typing.text!.length).toBeGreaterThan(0);
    expect(typing.text!.length).toBeLessThan(7);
    expect('Gateway'.startsWith(typing.text!)).toBe(true);
    // The label done and the pause after it, but not yet the rest.
    await vi.advanceTimersByTimeAsync(1300);
    expect(await done).toBe(true);
    expect(h.scene.map((e) => [e.id, e.width, e.text]).sort()).toEqual([
      ['a', 100, undefined],
      ['a-t', 80, 'Gateway'],
    ]);
    expect(h.commits.some((c) => c.history === 'record')).toBe(true);
    // The cursor followed the pen in viewport coordinates, drawing, and left after the rest.
    expect(cursor.some((c) => (c as { drawing: boolean } | null)?.drawing)).toBe(true);
    expect(cursor.at(-1)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(REST_MS + 1);
    expect(cursor.at(-1)).toBeNull();
    expect(pen.isBusy()).toBe(false);
  });

  it('lands drawings in order, builds each when its turn comes, and an abort drops what has not started', async () => {
    const h = host();
    const pen = new Pen(h, () => {});
    const order: string[] = [];
    void pen.drawElements(() => {
      order.push('first');
      return box('a', 'A');
    });
    void pen.drawElements(() => {
      order.push('second built when the first is on the board');
      expect(h.scene.some((e) => e.id === 'a' && e.width === 100)).toBe(true);
      return box('b', 'B', 200);
    });
    const third = pen.drawElements(box('c', 'C', 400), undefined, { onStop: (s) => order.push(`third ${s}`) });
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(order).toEqual(['first', 'second built when the first is on the board']);
    pen.abort();
    expect(await third).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(order).toEqual(['first', 'second built when the first is on the board', 'third aborted']);
    expect(h.scene.some((e) => e.id === 'c')).toBe(false);
    // A failing build is reported and the queue goes on.
    const errors: unknown[] = [];
    const pen2 = new Pen(
      h,
      () => {},
      (e) => errors.push(e),
    );
    void pen2.drawElements(() => {
      throw new Error('no such box');
    });
    const ok = pen2.drawElements(box('d', 'D', 600));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errors).toHaveLength(1);
    expect(await ok).toBe(true);
  });

  it('erases an element with its label, unbinds the arrow that pointed at it, clears by id, and pulses a highlight', async () => {
    const h = host();
    const pen = new Pen(h, () => {});
    h.scene = [
      ...box('a', 'A'),
      ...box('b', 'B', 300),
      {
        id: 'e',
        type: 'arrow',
        x: 100,
        y: 25,
        width: 200,
        height: 0,
        version: 1,
        points: [
          [0, 0],
          [200, 0],
        ],
        startBinding: { elementId: 'a' },
        endBinding: { elementId: 'b' },
      },
    ];
    h.scene[0] = {
      ...h.scene[0],
      boundElements: [
        { id: 'a-t', type: 'text' },
        { id: 'e', type: 'arrow' },
      ],
    };
    const hl = pen.highlight('b');
    await vi.advanceTimersByTimeAsync(SYNC_MOVE_MS + 300);
    expect(h.scene.find((e) => e.id === 'b')!.strokeColor).toBe('#e8590c');
    await vi.advanceTimersByTimeAsync(5000);
    await hl;
    expect(h.scene.find((e) => e.id === 'b')!.strokeColor).toBeUndefined();
    const erased = pen.eraseElements(h.scene.filter((e) => e.id === 'a' || e.id === 'a-t'));
    await vi.advanceTimersByTimeAsync(10_000);
    await erased;
    expect(h.scene.map((e) => e.id).sort()).toEqual(['b', 'b-t', 'e']);
    expect(h.scene.find((e) => e.id === 'e')!.startBinding).toBeNull();
    const cleared = pen.clear(() => ['b', 'b-t']);
    await vi.advanceTimersByTimeAsync(10);
    await cleared;
    expect(h.scene.map((e) => e.id)).toEqual(['e']);
  });

  it('lands everything at once while the tab is hidden', async () => {
    vi.stubGlobal('document', { hidden: true });
    try {
      const h = host();
      const pen = new Pen(h, () => {});
      const done = pen.drawElements([...box('a', 'A'), { id: 'n', type: 'text', x: 0, y: 100, width: 100, height: 20, version: 1, text: 'note', originalText: 'note' }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(await done).toBe(true);
      expect(h.scene.map((e) => e.id)).toEqual(['a', 'a-t', 'n']);
      expect(h.scene.find((e) => e.id === 'n')!.text).toBe('note');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('follows the words it writes, not the box they sit in', () => {
    expect(typedWidth({ id: 't', type: 'text', x: 0, y: 0, width: 340, height: 20, text: 'sixteen chars...', fontSize: 16 })).toBeCloseTo(16 * 16 * 0.6);
    expect(typedWidth({ id: 't', type: 'text', x: 0, y: 0, width: 50, height: 20, text: 'sixteen chars...', fontSize: 16 })).toBe(50);
    expect(typedWidth({ id: 't', type: 'text', x: 0, y: 0, width: 340, height: 20, text: 'fixed', fontSize: 16, autoResize: false })).toBe(340);
  });
});
