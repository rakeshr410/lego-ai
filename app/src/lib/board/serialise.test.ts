import { describe, expect, it } from 'vitest';
import { compactElements, fingerprint, freehandHeavy, renderBoard, renderDelta, serialise, unlabelledRatio, type BoardElement, type BoardGraph } from './serialise';

// The whiteboard serialiser on a dozen fixture boards (design section 7): labels, containment,
// edges, inference, freehand, layout, stable ids and deltas. Scenes are built the way Excalidraw
// lays them out: shapes with bound text, arrows with bindings, frames by frameId.

let n = 0;
const el = (partial: Partial<BoardElement> & Pick<BoardElement, 'type'>): BoardElement => ({ id: partial.id ?? `el${++n}`, x: 0, y: 0, width: 0, height: 0, version: 1, ...partial });
/** A shape with its bound label. */
function box(id: string, x: number, y: number, label: string | null = null, type = 'rectangle', w = 120, h = 60, extra: Partial<BoardElement> = {}): BoardElement[] {
  const shape = el({ id, type, x, y, width: w, height: h, ...extra });
  return label === null ? [shape] : [shape, el({ id: `${id}-t`, type: 'text', text: label, x: x + 10, y: y + 20, width: w - 20, height: 20, containerId: id })];
}
function arrow(id: string, from: string | null, to: string | null, points: [number, number][], label: string | null = null, extra: Partial<BoardElement> = {}): BoardElement[] {
  const a = el({ id, type: 'arrow', x: points[0][0], y: points[0][1], width: 10, height: 10, points: points.map(([x, y]) => [x - points[0][0], y - points[0][1]] as const), startBinding: from ? { elementId: from } : null, endBinding: to ? { elementId: to } : null, endArrowhead: 'arrow', ...extra });
  return label === null ? [a] : [a, el({ id: `${id}-t`, type: 'text', text: label, containerId: id, x: 0, y: 0, width: 40, height: 20 })];
}
const text = (id: string, x: number, y: number, t: string, extra: Partial<BoardElement> = {}) => el({ id, type: 'text', text: t, x, y, width: t.length * 7, height: 20, ...extra });
const stroke = (id: string, x: number, y: number) => el({ id, type: 'freedraw', x, y, width: 30, height: 30, pointCount: 40 });

/** The worked example of design section 7: Acme Help at stage s2, minute 6. */
function csaBoard(): BoardElement[] {
  return [
    ...box('gw', 0, 100, 'Chat Gateway'),
    ...box('orch', 200, 100, 'Orchestrator'),
    ...box('llm', 200, -60, 'LLM', 'ellipse'),
    ...box('tr', 400, 100, 'Tool Runner'),
    el({ id: 'F', type: 'frame', name: 'business systems', x: 580, y: 60, width: 160, height: 260 }),
    ...box('pol', 600, 80, 'Policy', 'rectangle', 120, 60, { frameId: 'F' }),
    ...box('bill', 600, 160, 'Billing', 'rectangle', 120, 60, { frameId: 'F' }),
    ...box('idn', 600, 240, 'Identity', 'rectangle', 120, 60, { frameId: 'F' }),
    ...box('unk', 400, 260, null),
    text('note', 210, 180, 'run state in Redis'),
    ...arrow('e1', 'gw', 'orch', [[120, 130], [200, 130]], 'messages'),
    ...arrow('e2', 'orch', 'llm', [[260, 100], [260, 0]], 'prompt + tools'),
    ...arrow('e3', 'llm', 'orch', [[280, 0], [280, 100]], null, { strokeStyle: 'dashed' }),
    ...arrow('e4', 'orch', 'tr', [[320, 130], [400, 130]], 'tool calls'),
    // Unbound at both ends, drawn to the boxes' edges: inferred.
    ...arrow('e5', null, null, [[522, 110], [598, 110]]),
    ...arrow('e6', 'tr', 'bill', [[520, 140], [600, 190]], 'credit'),
    ...arrow('e7', 'tr', 'idn', [[520, 150], [600, 270]]),
    ...arrow('e8', 'llm', 'bill', [[320, -30], [600, 170]], 'apply credit'),
    ...arrow('e9', null, 'tr', [[60, 162], [460, 162]]),
    stroke('s1', 540, 270),
    stroke('s2', 550, 280),
    stroke('s3', 545, 300),
  ];
}

describe('the worked example', () => {
  const ids = {};
  const graph = serialise(csaBoard(), ids);
  const out = renderBoard(graph, { version: 14, stage: 's2-one-request' });

  it('names nine nodes, one frame and nine edges, and reads in about 230 tokens', () => {
    expect(out.split('\n')[0]).toBe('<board v="14" stage="s2-one-request" nodes="8" edges="9">');
    expect(out).toContain('n1 "Chat Gateway" [box]');
    expect(out).toContain('n3 "LLM" [oval]');
    expect(out).toContain('n5 "Policy" [box] in F1');
    expect(out).toContain('(unlabelled) [box] below n4');
    expect(out).toContain('"run state in Redis" [note]');
    expect(out).toContain('frames: F1 "business systems": n5 n6 n7');
    expect(out).toContain('e1 n1 -> n2 "messages"');
    expect(out).toContain('e3 n3 -> n2 (dashed)');
    expect(out).toContain('e5 n4 -> n5 (inferred)');
    expect(out).toContain('e9 n1 -> n4 (inferred)');
    expect(out).toContain('free strokes: 3 (1 cluster near n8)');
    expect(out).toMatch(/layout: left-to-right; /);
    expect(out.length / 4).toBeLessThan(330);
    expect(graph.nodes.filter((x) => x.shape !== 'note')).toHaveLength(8);
  });

  it('keeps short ids stable across versions and gives new elements new ones', () => {
    const again = serialise([...csaBoard(), ...box('cache', 400, 400, 'Cache')], ids);
    expect(again.nodes.find((x) => x.eid === 'tr')?.id).toBe(graph.nodes.find((x) => x.eid === 'tr')?.id);
    expect(again.nodes.find((x) => x.eid === 'cache')?.id).toBe(`n${graph.nodes.length + 1}`);
  });
});

describe('labels', () => {
  it('reads bound text, then text inside the shape, then a caption just below, else unlabelled', () => {
    const scene = [
      ...box('a', 0, 0, 'Bound'),
      ...box('b', 200, 0),
      text('bt', 230, 20, 'Inside'),
      ...box('c', 400, 0),
      text('ct', 410, 70, 'Caption'),
      ...box('d', 600, 0),
      text('dt', 610, 100, 'Too far'),
    ];
    const out = renderBoard(serialise(scene), { version: 1 });
    expect(out).toContain('n1 "Bound" [box]');
    expect(out).toContain('n2 "Inside" [box]');
    expect(out).toContain('n3 "Caption" [box]');
    expect(out).toContain('n4 (unlabelled) [box] right of n3');
    expect(out).toContain('"Too far" [note]');
  });

  it('escapes and clips labels', () => {
    const scene = box('a', 0, 0, `<b>${'x'.repeat(100)}`);
    const out = renderBoard(serialise(scene), { version: 1 });
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toContain('x'.repeat(90));
  });
});

describe('containment', () => {
  it('turns a shape enclosing two or more nodes into a frame with its title', () => {
    const scene = [
      ...box('big', 0, 0, null, 'rectangle', 400, 300),
      text('title', 20, 10, 'Business systems'),
      ...box('p', 40, 60, 'Policy'),
      ...box('q', 40, 160, 'Billing'),
      ...box('out', 600, 0, 'Gateway'),
    ];
    const g = serialise(scene);
    expect(g.frames).toEqual([expect.objectContaining({ id: 'F1', kind: 'shape', label: 'Business systems', members: ['n1', 'n2'] })]);
    expect(g.nodes.map((x) => x.label)).toEqual(['Policy', 'Billing', 'Gateway']);
    expect(renderBoard(g, { version: 1 })).toContain('frames: F1 "Business systems": n1 n2');
  });

  it('reports a shared group as G1, and frame members by frameId', () => {
    const scene = [
      ...box('a', 0, 0, 'A', 'rectangle', 120, 60, { groupIds: ['g'] }),
      ...box('b', 200, 0, 'B', 'rectangle', 120, 60, { groupIds: ['g'] }),
      ...box('c', 400, 0, 'C'),
      el({ id: 'fr', type: 'frame', name: null, x: 580, y: -20, width: 200, height: 100 }),
      ...box('d', 600, 0, 'D', 'rectangle', 120, 60, { frameId: 'fr' }),
    ];
    const out = renderBoard(serialise(scene), { version: 2 });
    expect(out).toContain('frames: F1: n4; G1 (group): n1 n2');
    expect(out).toContain('n4 "D" [box] in F1');
  });
});

describe('edges', () => {
  it('reads direction from the arrowheads and keeps dashes', () => {
    const scene = [
      ...box('a', 0, 0, 'A'),
      ...box('b', 300, 0, 'B'),
      ...arrow('both', 'a', 'b', [[120, 30], [300, 30]], null, { startArrowhead: 'arrow', endArrowhead: 'arrow' }),
      ...arrow('rev', 'a', 'b', [[120, 40], [300, 40]], null, { startArrowhead: 'arrow', endArrowhead: null }),
      ...arrow('line', 'a', 'b', [[120, 50], [300, 50]], 'sync', { type: 'line', endArrowhead: null, strokeStyle: 'dotted' }),
    ];
    const out = renderBoard(serialise(scene), { version: 1 });
    expect(out).toContain('e1 n1 <-> n2');
    expect(out).toContain('e2 n2 -> n1');
    expect(out).toContain('e3 n1 -- n2 "sync" (dashed)');
  });

  it('infers an unbound end from the nearest node within 24 px, and lists the rest as loose', () => {
    const scene = [
      ...box('a', 0, 0, 'A'),
      ...box('b', 300, 0, 'B'),
      ...arrow('near', null, null, [[130, 30], [290, 30]]),
      ...arrow('far', 'a', null, [[120, 50], [200, 200]], 'retries'),
    ];
    const g = serialise(scene);
    expect(g.edges[0]).toMatchObject({ from: 'n1', to: 'n2', inferred: true });
    expect(g.edges[1]).toMatchObject({ from: 'n1', to: null });
    const out = renderBoard(g, { version: 1 });
    expect(out.split('\n')[0]).toContain('edges="1"');
    expect(out).toContain('loose: e2 n1 -> ? "retries"');
  });

  it('never claims an edge from a node to itself', () => {
    const scene = [...box('a', 0, 0, 'A'), ...arrow('self', 'a', 'a', [[10, 10], [20, 20]])];
    expect(serialise(scene).edges[0]).toMatchObject({ from: 'n1', to: null });
  });
});

describe('freehand and fallbacks', () => {
  it('counts strokes, clusters them near nodes, and flags a freehand-heavy or unlabelled board', () => {
    const labelled = [...box('a', 0, 0, 'A'), ...box('b', 300, 0)];
    const strokes = Array.from({ length: 7 }, (_, i) => stroke(`s${i}`, 20 + i * 5, 80 + i * 5));
    const g = serialise([...labelled, ...strokes, stroke('lone', 2000, 2000)]);
    expect(g.freehand).toEqual({ count: 8, clusters: [{ near: 'n1', count: 7 }, { near: null, count: 1 }] });
    expect(freehandHeavy(g)).toBe(true);
    expect(unlabelledRatio(g)).toBe(0.5);
    expect(renderBoard(g, { version: 3 })).toContain('free strokes: 8 (2 clusters near n1)');
    expect(freehandHeavy(serialise(labelled))).toBe(false);
    expect(renderBoard(serialise([]), { version: 0 })).toBe('<board v="0" nodes="0" edges="0">\nnodes: (none)\n</board>');
  });
});

describe('layout', () => {
  it('reads rows left to right, or columns top to bottom', () => {
    const lr = serialise([...box('a', 0, 0, 'A'), ...box('b', 300, 0, 'B'), ...box('c', 600, 0, 'C'), ...box('d', 300, 200, 'D')]);
    expect(lr.layout).toEqual({ direction: 'left-to-right', rows: [['n1', 'n2', 'n3'], ['n4']] });
    const tb = serialise([...box('a', 0, 0, 'A'), ...box('b', 0, 300, 'B'), ...box('c', 0, 600, 'C')]);
    expect(tb.layout).toEqual({ direction: 'top-to-bottom', rows: [['n1', 'n2', 'n3']] });
    expect(renderBoard(lr, { version: 1 })).toContain('layout: left-to-right; n1 n2 n3 | n4');
  });
});

describe('fingerprint and compaction', () => {
  it('changes with any element version and ignores order and deleted elements', () => {
    const a = csaBoard();
    const f = fingerprint(a);
    expect(f).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint([...a].reverse())).toBe(f);
    expect(fingerprint([...a, { id: 'gone', version: 3, isDeleted: true }])).toBe(f);
    expect(fingerprint(a.map((e) => (e.id === 'gw' ? { ...e, version: 2 } : e)))).not.toBe(f);
  });

  it('keeps only what the serialiser reads', () => {
    const raw = [
      { id: 'r', type: 'rectangle', x: 1, y: 2, width: 3, height: 4, version: 5, strokeColor: '#000', roughness: 1, seed: 42, isDeleted: false, customData: { author: 'interviewer', other: 1 } },
      { id: 'd', type: 'freedraw', x: 0, y: 0, width: 9, height: 9, version: 1, points: [[0, 0], [1, 1], [2, 2]], pressures: [1, 1, 1] },
      { id: 'gone', type: 'ellipse', isDeleted: true, version: 9 },
      { id: 'a', type: 'arrow', x: 0, y: 0, width: 1, height: 1, version: 2, points: [[0, 0], [50, 0]], startBinding: { elementId: 'r', focus: 0, gap: 1 }, endBinding: null, endArrowhead: 'arrow', strokeStyle: 'solid' },
      'junk',
      { type: 'rectangle' },
    ];
    expect(compactElements(raw)).toEqual([
      { id: 'r', type: 'rectangle', x: 1, y: 2, width: 3, height: 4, version: 5, customData: { author: 'interviewer' } },
      { id: 'd', type: 'freedraw', x: 0, y: 0, width: 9, height: 9, version: 1, pointCount: 3 },
      { id: 'a', type: 'arrow', x: 0, y: 0, width: 1, height: 1, version: 2, startBinding: { elementId: 'r' }, endBinding: null, points: [[0, 0], [50, 0]], endArrowhead: 'arrow' },
    ]);
  });
});

describe('deltas', () => {
  const ids = {};
  const before = serialise(csaBoard(), ids);

  it('lists additions, relabels, removals and moves by stable id', () => {
    const scene = csaBoard()
      .filter((e) => e.id !== 'e3')
      .map((e) => (e.id === 'orch-t' ? { ...e, text: 'Agent Orchestrator' } : e.id === 'gw' || e.id === 'gw-t' ? { ...e, y: e.y + 40 } : e));
    const after = serialise([...scene, ...box('cache', 400, 400, 'Cache'), ...arrow('e10', 'tr', 'cache', [[460, 160], [460, 400]], 'reads')], ids);
    const { text, full } = renderDelta(before, after, { from: 14, version: 15, stage: 's2' });
    expect(full).toBe(false);
    expect(text.split('\n')[0]).toBe('<board-delta from="14" v="15" stage="s2">');
    expect(text).toContain('~ n2 "Agent Orchestrator" [box] (was "Orchestrator")');
    expect(text).toContain('+ n10 "Cache" [box]');
    expect(text).toContain('+ e10 n4 -> n10 "reads"');
    expect(text).toContain('- e3');
    expect(text).toContain('moved: n1');
    expect(text).not.toContain('n3 "LLM"');
  });

  it('says so when nothing changed, and sends the whole board when the delta would be longer', () => {
    expect(renderDelta(before, serialise(csaBoard(), ids), { from: 14, version: 14 }).text).toContain('(no change)');
    const empty: BoardGraph = { nodes: [], frames: [], edges: [], freehand: { count: 0, clusters: [] }, layout: { direction: 'left-to-right', rows: [] } };
    const { text, full } = renderDelta(before, empty, { from: 14, version: 15 });
    expect(full).toBe(true);
    expect(text.startsWith('<board v="15"')).toBe(true);
  });
});
