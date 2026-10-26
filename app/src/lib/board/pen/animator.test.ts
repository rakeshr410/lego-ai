import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labelsAfterBoxes, Pen, typedWidth, type PenElement, type PenHost } from './animator';
import { HOVER_REST_MS, REST_MS, SYNC_MOVE_MS, SYNC_SHAPE_MS } from './timing';
import { VoiceCues } from './cues';

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

  it('puts the board a lesson opens with on at once, with no pen', async () => {
    const h = host();
    const cursor: unknown[] = [];
    const pen = new Pen(h, (c) => cursor.push(c));
    const done = pen.drawElements([...box('a', 'Mock-up'), ...box('b', 'Requirements', 200)], undefined, { keepView: true, instant: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await done).toBe(true);
    expect(h.scene.map((e) => [e.id, e.width, e.text])).toEqual([
      ['a', 100, undefined],
      ['a-t', 80, 'Mock-up'],
      ['b', 100, undefined],
      ['b-t', 80, 'Requirements'],
    ]);
    expect(cursor).toEqual([]);
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

  it("on a voice's cues, draws the outline in the pause and writes each word while it is said", async () => {
    const h = host();
    const pen = new Pen(h, () => {});
    let write: (cue: { words: [number, number][] }) => void = () => {};
    const sync = {
      beforeShape: async () => ({ ms: 600 }),
      beforeLabel: () => new Promise<{ words: [number, number][] }>((r) => (write = r)),
    };
    const done = pen.drawElements(box('a', 'Border box'), sync);
    // The pen is placed (120 ms), waits 120 ms, then the outline takes what the pause leaves after the move.
    await vi.advanceTimersByTimeAsync(240 + 600 + 50);
    expect(h.scene.find((e) => e.id === 'a')!.width).toBe(100);
    expect(h.scene.find((e) => e.id === 'a-t')).toBeUndefined(); // nothing written before the voice says it
    write({ words: [[100, 400], [500, 800]] });
    const text = () => h.scene.find((e) => e.id === 'a-t')?.text ?? '';
    await vi.advanceTimersByTimeAsync(90);
    expect(text()).toBe('');
    await vi.advanceTimersByTimeAsync(160); // halfway through "Border"
    expect(text().length).toBeGreaterThan(1);
    expect(text().length).toBeLessThan(6);
    await vi.advanceTimersByTimeAsync(200); // the gap between the words
    expect(text()).toBe('Border');
    await vi.advanceTimersByTimeAsync(400);
    expect(text()).toBe('Border box');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await done).toBe(true);
  });

  it('keeps each label right after its box, as Excalidraw requires', () => {
    const scene = [
      { id: 't1', containerId: 'b1' },
      { id: 'n' },
      { id: 'b1' },
      { id: 'b2' },
      { id: 't2', containerId: 'b2' },
      { id: 'orphan', containerId: 'gone' },
    ];
    expect(labelsAfterBoxes(scene).map((e) => e.id)).toEqual(['n', 'b1', 't1', 'b2', 't2', 'orphan']);
  });

  it('follows the words it writes, not the box they sit in', () => {
    expect(typedWidth({ id: 't', type: 'text', x: 0, y: 0, width: 340, height: 20, text: 'sixteen chars...', fontSize: 16 })).toBeCloseTo(16 * 16 * 0.6);
    expect(typedWidth({ id: 't', type: 'text', x: 0, y: 0, width: 50, height: 20, text: 'sixteen chars...', fontSize: 16 })).toBe(50);
    expect(typedWidth({ id: 't', type: 'text', x: 0, y: 0, width: 340, height: 20, text: 'fixed', fontSize: 16, autoResize: false })).toBe(340);
  });

  it('hovers under the words the voice talks about, drawing nothing, and leaves when the voice stops', async () => {
    const h = host();
    h.scene = box('a', 'Gateway');
    const cursor: ({ x: number; y: number; drawing: boolean } | null)[] = [];
    const pen = new Pen(h, (c) => cursor.push(c));
    pen.hover(h.scene[1]);
    await vi.advanceTimersByTimeAsync(2000);
    const at = cursor.filter(Boolean) as { x: number; y: number; drawing: boolean }[];
    expect(at.length).toBeGreaterThan(5);
    expect(at.every((c) => !c.drawing)).toBe(true);
    // Under the label (y 15 + 20, in the viewport's doubled scale), drifting left to right along it.
    expect(at.at(-1)!.y).toBeGreaterThanOrEqual((15 + 20) * 2);
    expect(at.at(-1)!.x).toBeGreaterThan(at[0].x);
    expect(h.commits).toEqual([]);
    // The voice goes on: the pen stays; it stops: the pen leaves.
    pen.stay();
    await vi.advanceTimersByTimeAsync(HOVER_REST_MS - 100);
    expect(cursor.at(-1)).not.toBeNull();
    pen.rest();
    await vi.advanceTimersByTimeAsync(REST_MS + 10);
    expect(cursor.at(-1)).toBeNull();
  });

  it('does not hover while a mark is being drawn, and a mark coming takes the pen back', async () => {
    const h = host();
    h.scene = box('a', 'Gateway');
    const cursor: unknown[] = [];
    const pen = new Pen(h, (c) => cursor.push(c));
    const done = pen.drawElements(box('b', 'Store', 200));
    pen.hover(h.scene[1]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await done).toBe(true);
    // Every cursor position came from the drawing of b (x 200 on, doubled in the viewport), none from a's label.
    expect((cursor.filter(Boolean) as { x: number }[]).every((c) => c.x >= 400)).toBe(true);
  });

  it('leaves a mark undrawn when the voice was cut off before it reached it', async () => {
    const h = host();
    const cues = new VoiceCues();
    const pen = new Pen(h, () => {});
    const first = pen.drawElements(box('a', 'Gateway'), cues.sync('r', 0), { keepView: true });
    const second = pen.drawElements(box('b', 'Store', 200), cues.sync('r', 1), { keepView: true });
    cues.receive({ at: 'shape', ref: 'r', i: 0, ms: 400 });
    await vi.advanceTimersByTimeAsync(200);
    cues.receive({ at: 'release' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    const ids = new Set(h.scene.map((e) => e.id));
    expect([...ids].some((id) => id.startsWith('a'))).toBe(true);
    expect([...ids].some((id) => id.startsWith('b'))).toBe(false);
  });
});

