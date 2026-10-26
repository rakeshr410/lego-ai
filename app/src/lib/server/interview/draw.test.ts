import { describe, expect, it } from 'vitest';
import type { BoardGraph } from '../../board/serialise';
import { asideFor } from '../coaching/aside';
import type { Layout } from '../coaching/layout';
import { countWords, drawParser, drawToolBody, drawToolResult, fillPlanned, holdDraw, onBoard, parseDraw, readBack } from './draw';

// The interviewer's and the coach's drawing (draw.ts): the <draw> elements come off the reply
// wherever they stand, their operations are checked against the board the model saw, what cannot
// be drawn is dropped with a numbered reason, and the stream never carries an element but hands
// each one over as it closes.

const graph: BoardGraph = {
  nodes: [
    { id: 'n1', eid: 'a', label: 'Chat Gateway', shape: 'box', frame: null, x: 0, y: 0, w: 1, h: 1 },
    { id: 'n2', eid: 'b', label: null, shape: 'box', frame: null, x: 0, y: 0, w: 1, h: 1 },
  ],
  frames: [],
  edges: [],
  freehand: { count: 0, clusters: [] },
  layout: { direction: 'left-to-right', rows: [['n1', 'n2']] },
};

describe('parseDraw', () => {
  it('takes the element off the reply and keeps operations on boxes the board has, or this drawing adds', () => {
    const reply = 'Right, I’ll put the orchestrator on the board.\n<draw><box label="Agent Orchestrator"/><arrow from="chat gateway" to="Agent Orchestrator" label="turn"/><arrow from="n2" to="Agent Orchestrator"/><arrow from="Billing" to="n1"/><arrow from="n1" to="n1"/></draw>';
    const out = parseDraw(reply, graph, true);
    expect(out.text).toBe('Right, I’ll put the orchestrator on the board.');
    expect(out.ops).toEqual([
      { op: 'box', label: 'Agent Orchestrator' },
      { op: 'arrow', from: 'Chat Gateway', to: 'Agent Orchestrator', label: 'turn' },
      { op: 'arrow', from: 'n2', to: 'Agent Orchestrator' },
    ]);
    expect(out.dropped).toEqual(['arrow from "Billing": no box with that label is on the board', 'arrow from "Chat Gateway" to itself']);
  });

  it('reads elements anywhere in the reply, in order, and leaves the words readable', () => {
    const reply = 'Here is the gateway. <draw><box label="Gateway"/></draw> Every request lands there first.\n<draw><box label="Store" kind="oval"/><arrow from="Gateway" to="Store"/></draw>\nThe store keeps the sessions.';
    const out = parseDraw(reply, null, true, { edit: true, maxOps: 8 });
    expect(out.text).toBe('Here is the gateway. Every request lands there first.\nThe store keeps the sessions.');
    expect(out.ops).toEqual([{ op: 'box', label: 'Gateway' }, { op: 'box', label: 'Store', kind: 'oval' }, { op: 'arrow', from: 'Gateway', to: 'Store' }]);
    // A reply cut off inside an element keeps what it had drawn so far.
    expect(parseDraw('Two parts. <draw><box label="A"/><box label="B"', null, true).ops).toEqual([{ op: 'box', label: 'A' }]);
  });

  it('keeps at most four operations, drops a box the board already has, and nothing without an element', () => {
    const many = `<draw>${Array.from({ length: 6 }, (_, i) => `<box label="B${i}"/>`).join('')}</draw>`;
    const capped = parseDraw(`Go on. ${many}`, graph, true);
    expect(capped.ops).toHaveLength(4);
    expect(capped.dropped).toEqual(['past the cap of 4 operations a reply: the rest were dropped']);
    expect(parseDraw('Go on. <draw><box label="Chat Gateway"/></draw>', graph, true)).toEqual({ text: 'Go on.', ops: [], dropped: ['box "Chat Gateway": already on the board'] });
    expect(parseDraw('Go on.', graph, true)).toEqual({ text: 'Go on.', ops: [], dropped: [] });
    expect(parseDraw('<draw><box label="X"/></draw>', null, true)).toEqual({ text: 'Go on.', ops: [{ op: 'box', label: 'X' }], dropped: [] });
  });

  it('drops the drawing, but not the words, when the stage already has one', () => {
    expect(parseDraw('Noted. <draw><box label="X"/></draw>', graph, false)).toEqual({ text: 'Noted.', ops: [], dropped: [] });
  });

  it('gives the interviewer boxes and arrows only; the coach’s vocabulary needs the edit option', () => {
    const reply = 'Here. <draw><box label="Store" kind="oval" group="Data"/><note text="30 euros a month" near="Store"/><highlight target="Chat Gateway"/><arrow from="Chat Gateway" to="Store" dashed="true" both="true"/></draw>';
    const plain = parseDraw(reply, graph, true);
    expect(plain.ops).toEqual([
      { op: 'box', label: 'Store' },
      { op: 'arrow', from: 'Chat Gateway', to: 'Store' },
    ]);
    expect(plain.dropped).toEqual(['<note>: only boxes and arrows here', '<highlight>: only boxes and arrows here']);
    expect(parseDraw(reply, graph, true, { edit: true, maxOps: 8 }).ops).toEqual([
      { op: 'box', label: 'Store', kind: 'oval', group: 'Data' },
      { op: 'note', text: '30 euros a month', near: 'Store' },
      { op: 'highlight', target: 'Chat Gateway' },
      { op: 'arrow', from: 'Chat Gateway', to: 'Store', dashed: true, both: true },
    ]);
  });

  it('lets the coach rename, erase and clear only what it drew, keeps the renamed box for later operations, and says why the rest went', () => {
    const mine: BoardGraph = { ...graph, nodes: [...graph.nodes, { id: 'n3', eid: 'c', label: 'Policy', shape: 'box', frame: null, x: 0, y: 0, w: 1, h: 1, author: 'coach' }] };
    const reply = '<draw><rename target="Chat Gateway" label="Front door"/><erase target="Chat Gateway"/><rename target="Policy" label="Policy Service"/><arrow from="Policy Service" to="n1"/><erase target="Policy"/><box label="Cache"/><erase target="Cache"/><clear/></draw>';
    const out = parseDraw(reply, mine, true, { edit: true, maxOps: 8 });
    expect(out.ops).toEqual([
      { op: 'rename', target: 'Policy', label: 'Policy Service' },
      { op: 'arrow', from: 'Policy Service', to: 'Chat Gateway' },
      { op: 'box', label: 'Cache' },
      { op: 'erase', target: 'Cache' },
      { op: 'clear' },
    ]);
    expect(out.dropped).toEqual([
      'rename "Chat Gateway": not yours to change (the learner drew it)',
      'erase "Chat Gateway": not yours to erase (the learner drew it)',
      'erase "Policy": no box with that label is on the board',
    ]);
    const many = `<draw>${Array.from({ length: 10 }, (_, i) => `<box label="B${i}"/>`).join('')}</draw>`;
    expect(parseDraw(many, graph, true, { edit: true, maxOps: 8 }).ops).toHaveLength(8);
    // At most six reasons travel back.
    const bad = `<draw>${Array.from({ length: 9 }, (_, i) => `<highlight target="Nope${i}"/>`).join('')}</draw>`;
    expect(parseDraw(bad, graph, true, { edit: true, maxOps: 8 }).dropped).toHaveLength(6);
  });
});

describe('holdDraw', () => {
  const run = (chunks: string[]) => {
    const out: string[] = [];
    const elements: string[] = [];
    const anchors: number[] = [];
    const sink = holdDraw(
      (d) => out.push(d),
      (b, anchor) => {
        elements.push(b);
        anchors.push(anchor.words);
      },
    );
    for (const c of chunks) sink.onText(c);
    sink.flush();
    return { text: out.join(''), elements, anchors };
  };

  it('forwards the words and holds back the element, however it is chunked, handing each element over as it closes', () => {
    expect(run(['Right, I’ll add it.', '\n<draw><box label="X"/></draw>'])).toEqual({ text: 'Right, I’ll add it.\n', elements: ['<box label="X"/>'], anchors: [4] });
    expect(run(['Right, I’ll add it.\n<dr', 'aw><box la', 'bel="X"/></dr', 'aw>'])).toEqual({ text: 'Right, I’ll add it.\n', elements: ['<box label="X"/>'], anchors: [4] });
    // Cut off inside an element: what there was goes over at the flush, as parseDraw reads it.
    expect(run(['Right, I’ll add it.<', 'd', 'raw><box label="A"/><box la'])).toEqual({ text: 'Right, I’ll add it.', elements: ['<box label="A"/><box la'], anchors: [4] });
    expect(run(['Go. <draw>', '</draw> on.'])).toEqual({ text: 'Go.  on.', elements: [''], anchors: [1] });
  });

  it('keeps the words around inline elements flowing, each element its own event anchored to the words before it (phase 5)', () => {
    const r = run(['Here is the gateway. <draw><box label="Gateway"/></draw> It takes every', ' request.\n<draw><box label="Store"/><arrow from="Gateway" to="Store"/></draw>\nThe store keeps sessions.']);
    expect(r.text).toBe('Here is the gateway.  It takes every request.\n\nThe store keeps sessions.');
    expect(r.elements).toEqual(['<box label="Gateway"/>', '<box label="Store"/><arrow from="Gateway" to="Store"/>']);
    // The voice service holds each drawing until this many words have played.
    expect(r.anchors).toEqual([4, 8]);
    expect(countWords(' Here  is\nthe gateway. ')).toBe(4);
  });

  it('lets other angle brackets through, and releases a held tail that was not a draw', () => {
    expect(run(['a < b and', ' <b>bold</b>']).text).toBe('a < b and <b>bold</b>');
    expect(run(['so <d']).text).toBe('so <d');
    expect(run(['so <dr', 'ill']).text).toBe('so <drill');
    const out: string[] = [];
    const sink = holdDraw((d) => out.push(d));
    sink.onText('plain <draw><box label="X"/></draw> words');
    sink.flush();
    expect(out.join('')).toBe('plain  words');
  });
});

describe('the draw tool (phase 4)', () => {
  it('reads a call’s input through the same parser, and answers with what landed and why the rest did not', () => {
    const body = drawToolBody({ ops: [{ op: 'box', label: 'Store "A"', kind: 'oval', group: 'Data' }, { op: 'arrow', from: 'Chat Gateway', to: 'Store "A"', label: 'reads', dashed: true }, { op: 'note', text: 'two <copies>', near: 'Store "A"' }, { op: 'erase', target: 'Chat Gateway' }, { op: 'dance' }, { op: 'clear' }, 'junk'] });
    expect(body).toBe('<box label="Store ″A″" kind="oval" group="Data"/><arrow label="reads" from="Chat Gateway" to="Store ″A″" dashed="true"/><note text="two copies" near="Store ″A″"/><erase target="Chat Gateway"/><clear/>');
    const parser = drawParser(graph, { edit: true, maxOps: 8 });
    const ops = parser.element(body);
    expect(ops).toEqual([
      { op: 'box', label: 'Store ″A″', kind: 'oval', group: 'Data' },
      { op: 'arrow', from: 'Chat Gateway', to: 'Store ″A″', label: 'reads', dashed: true },
      { op: 'note', text: 'two copies', near: 'Store ″A″' },
      { op: 'clear' },
    ]);
    expect(drawToolResult(ops, parser.dropped, true)).toBe('Drawn: box Store ″A″; arrow Chat Gateway -> Store ″A″; note; clear. Not drawn: 1. erase "Chat Gateway": not yours to erase (the learner drew it)');
    expect(drawToolResult([], [], true)).toBe('Nothing drawn.');
    expect(drawToolResult([], [], false)).toContain('this move does not draw');
    expect(drawToolBody(null)).toBe('');
    expect(drawToolBody({ ops: 'no' })).toBe('');
  });
});

describe('a lesson move the model drew too little for', () => {
  const layout: Layout = new Map([
    ['tree', { type: 'element', id: 'tree', kind: 'region', label: 'Render tree', at: [0, 0], size: [30, 12] }],
    ['html', { type: 'element', id: 'html', kind: 'box', label: 'html', at: [2, 2] }],
    ['body', { type: 'element', id: 'body', kind: 'box', label: 'body', at: [2, 7] }],
    ['html-body', { type: 'arrow', id: 'html-body', from: 'html', to: 'body', label: 'child' }],
  ] as const) as unknown as Layout;
  const opts = { layout, edit: true, maxOps: 8 };

  it('places what the plan has for the move and the reply left out, after it', () => {
    const reply = parseDraw('The page is a tree. <draw><place ids="tree,html"/></draw> Its root holds the body.', graph, true, opts);
    const filled = fillPlanned(['tree', 'html', 'body', 'html-body'], reply.ops, graph, opts);
    expect(filled.ids).toEqual(['body', 'html-body']);
    expect(filled.ops).toEqual([
      { op: 'box', label: 'body', at: { x: 40, y: 140 }, size: { w: 160, h: 60 } },
      { op: 'arrow', from: 'html', to: 'body', label: 'child' },
    ]);
  });

  it('places nothing already on the board: a region is a frame there, and a label may wrap over lines', () => {
    const board = {
      nodes: [{ id: 'n1', eid: 'e1', label: 'Twitter\nheader', shape: 'box' as const, frame: 'F1', x: 0, y: 0, w: 10, h: 10, author: 'coach' as const }],
      frames: [{ id: 'F1', eid: 'e2', label: 'Render tree', kind: 'frame' as const, members: ['n1'] }],
      edges: [],
      freehand: { count: 0, clusters: [] },
      layout: { direction: 'left-to-right' as const, rows: [] },
    };
    const wrapped = new Map([...layout, ['header', { type: 'element', id: 'header', kind: 'box', label: 'Twitter header', at: [2, 9] }]]) as unknown as Layout;
    const r = parseDraw('<draw><place ids="tree,header,body"/></draw>', board, true, { ...opts, layout: wrapped });
    expect(r.ops.map((o) => ('label' in o ? o.label : o.op))).toEqual(['body']);
  });

  it('places an arrow between boxes an earlier reply drew, and nothing an earlier reply placed', () => {
    const before = parseDraw('<draw><place ids="tree,html,body"/></draw>', null, true, opts).ops;
    const filled = fillPlanned(['html-body'], [], null, opts, before);
    expect(filled.ops.map((o) => o.op)).toEqual(['arrow']);
    expect(fillPlanned(['body', 'html-body'], [], null, opts, [...before, ...filled.ops]).ops).toEqual([]);
  });

  it('reads the reply back with what was placed for it, where its name comes up', () => {
    const reply = 'The page is a tree. <draw><place ids="tree,html"/></draw> Its root holds the body. That is all.';
    expect(readBack(reply, ['body', 'html-body'], layout)).toBe(
      'The page is a tree. <draw><place ids="tree,html"/></draw> Its root holds the body. <draw><place ids="body,html-body"/></draw> That is all.',
    );
    expect(readBack('Nothing named here', ['tree'], layout)).toBe('Nothing named here <draw><place ids="tree"/></draw>');
    expect(readBack(reply, [], layout)).toBe(reply);
  });

  it('reads a <place> written outside <draw> as a drawing, and never says it', () => {
    const r = parseDraw('First the tree. <place ids="tree,html"/> Then more.', graph, true, opts);
    expect(r.text).toBe('First the tree. Then more.');
    expect(r.ops.map((o) => o.op)).toEqual(['region', 'box']);
    const said: string[] = [];
    const bodies: string[] = [];
    const sink = holdDraw((d) => said.push(d), (b) => bodies.push(b));
    for (const d of ['First the tree. <pl', 'ace ids="tree', ',html"/> Then <placeholder> more.']) sink.onText(d);
    sink.flush();
    expect(said.join('')).toBe('First the tree.  Then <placeholder> more.');
    // Any drawing element written bare is read as one: a learner's point noted outside <draw> is never said.
    const noted: string[] = [];
    const held: string[] = [];
    const notes = holdDraw((d) => noted.push(d), (b) => held.push(b));
    for (const d of ['Noted. <no', 'te text="dark mode" covers=""/> What <b>else</b>?']) notes.onText(d);
    notes.flush();
    expect(noted.join('')).toBe('Noted.  What <b>else</b>?');
    expect(held).toEqual(['<note text="dark mode" covers=""/>']);
    expect(parseDraw('Noted. <note text="dark mode"/> What else?', null, true, { edit: true }).text).toBe('Noted. What else?');
    expect(bodies).toEqual(['<place ids="tree,html"/>']);
  });

  it('adds nothing when the reply drew it all, or the boxes are on the board already', () => {
    const all = parseDraw('<draw><place ids="tree,html,body,html-body"/></draw>', graph, true, opts);
    expect(fillPlanned(['tree', 'html', 'body', 'html-body'], all.ops, graph, opts).ops).toEqual([]);
    const board: BoardGraph = { ...graph, nodes: [...graph.nodes, { id: 'n3', eid: 'c', label: 'Render tree', shape: 'box', frame: null, x: 0, y: 0, w: 1, h: 1 }] };
    expect(fillPlanned(['tree'], [], board, opts).ops).toEqual([]);
    expect(fillPlanned(['tree'], [], graph, {}).ops).toEqual([]);
  });

  it('puts the coach’s own drawing in the side notes, right of the plan, level with the part placed last', () => {
    const before = parseDraw('<draw><place ids="tree,html"/></draw>', null, true, opts).ops;
    // The plan's right edge is the tree's (30 cells), the lane 4 cells past it; the html box was placed last, at row 2.
    const aside = asideFor(layout, before);
    expect(aside).toEqual({ x: 680, y: 40 });
    const r = parseDraw(
      '<draw><note text="Why a cursor?"/><box label="Page 2"/><box label="Page 3"/><arrow from="Page 2" to="Page 3" label="next"/><box label="Cursor"/><note text="it does not move" near="Cursor"/></draw>',
      null,
      true,
      { ...opts, aside },
    );
    expect(r.ops).toEqual([
      { op: 'note', text: 'Why a cursor?', at: { x: 680, y: 40 } },
      { op: 'box', label: 'Page 2', at: { x: 680, y: 80 }, size: { w: 160, h: 60 } },
      { op: 'box', label: 'Page 3', at: { x: 1000, y: 80 }, size: { w: 160, h: 60 } },
      { op: 'arrow', from: 'Page 2', to: 'Page 3', label: 'next' },
      { op: 'box', label: 'Cursor', at: { x: 680, y: 200 }, size: { w: 160, h: 60 } },
      { op: 'note', text: 'it does not move', at: { x: 680, y: 320 } },
    ]);
    // The next sketch starts under this one.
    expect(asideFor(layout, [...before, ...r.ops])).toEqual({ x: 680, y: 380 });
  });

  it('places none of the plan in a reply that answers aside, but still opens the board', () => {
    const r = parseDraw('<draw><place ids="body"/><box label="Sketch"/></draw>', null, true, { ...opts, prelude: '<place ids="tree,html"/>', noPlace: true, aside: asideFor(layout, []) });
    expect(r.ops.map((o) => ('label' in o ? o.label : o.op))).toEqual(['Render tree', 'html', 'Sketch']);
    expect(r.dropped[0]).toMatch(/^<place>: this reply answers aside/);
  });

  describe('a numbered list', () => {
    const list = { id: 'fr', x: 100, y: 200, step: 40, slots: 4, chars: 40, items: [{ id: 'a', label: 'newest first' }, { id: 'b', label: 'endless' }] };
    const listed = new Map([
      ...layout,
      ['a', { type: 'element', id: 'a', kind: 'note', label: 'newest first', at: [5, 10], slot: { list: 'fr', n: 1 } }],
      ['b', { type: 'element', id: 'b', kind: 'note', label: 'endless', at: [5, 12], slot: { list: 'fr', n: 2 } }],
    ]) as unknown as Layout;
    const at = (n: number) => ({ x: 100, y: 200 + n * 40 });

    it('numbers the plan’s lines in their order where nothing else does', () => {
      expect(parseDraw('<draw><place ids="b"/></draw>', null, true, { layout: listed, edit: true }).ops).toEqual([{ op: 'note', text: '2. endless', at: { x: 100, y: 240 }, list: 'fr', covers: 'b' }]);
    });

    it('writes the learner’s points as they come, then places the plan’s lines left after them, each once', () => {
      const lists = { plans: [{ ...list, slots: 3 }], earlier: [], capture: 'fr' };
      const said = parseDraw('<draw><note text="2. never shows a tweet twice" covers="b"/><note text="dark mode for night reading"/><note text="again" covers="b"/></draw>', null, true, { layout: listed, edit: true, lists });
      expect(said.ops).toEqual([
        { op: 'note', text: '1. never shows a tweet twice', at: at(0), list: 'fr', learner: true, covers: 'b' },
        { op: 'note', text: '2. dark mode for night reading', at: at(1), list: 'fr', learner: true },
        // One slot is left for the open plan line, so a third point (its line already given) cannot take it.
        { op: 'note', text: 'again' },
      ]);
      const later = { plans: [{ ...list, slots: 3 }], earlier: said.ops };
      const fill = parseDraw('<draw><place ids="b,a"/></draw>', null, true, { layout: listed, edit: true, lists: later });
      expect(fill.ops).toEqual([{ op: 'note', text: '3. newest first', at: at(2), list: 'fr', covers: 'a' }]);
      // The service's safety net places what the reply left out after it, never twice.
      expect(fillPlanned(['a', 'b'], [], null, { layout: listed, edit: true, lists: later }, said.ops).ops).toEqual(fill.ops);
      expect(fillPlanned(['a', 'b'], fill.ops, null, { layout: listed, edit: true, lists: later }, said.ops).ops).toEqual([]);
    });

    it('sends a point past the list’s room to the side notes, and keeps a long one to the line', () => {
      const lists = { plans: [{ ...list, slots: 2, chars: 24 }], earlier: [], capture: 'fr' };
      const r = parseDraw('<draw><note text="it should keep working when the network is slow" covers="a"/><note text="an extra"/></draw>', null, true, { layout: listed, edit: true, lists, aside: { x: 900, y: 20 } });
      expect(r.ops).toEqual([
        { op: 'note', text: '1. it should keep', at: at(0), list: 'fr', learner: true, covers: 'a' },
        { op: 'note', text: 'an extra', at: { x: 900, y: 20 } },
      ]);
    });
  });

  describe('the plan’s parts the learner names', () => {
    const at = (x: number, y: number) => ({ x: x * 20, y: y * 20 });
    it('places each part named where the plan puts it, as theirs, once, and a point beyond the plan in the side notes', () => {
      const r = parseDraw('<draw><note text="the root element" covers="html"/><note text="html again" covers="html"/><note text="the body and the arrow" covers="body, html-body"/><note text="a doctype"/></draw>', null, true, {
        layout,
        edit: true,
        noPlace: true,
        parts: ['html', 'body'],
        aside: { x: 900, y: 20 },
      });
      expect(r.ops).toEqual([
        expect.objectContaining({ op: 'box', label: 'html', at: at(2, 2), covers: 'html', learner: true }),
        // Already given, and an arrow is never the learner's: neither is drawn; a note covering nothing open is an extra.
        { op: 'note', text: 'html again', at: { x: 900, y: 20 }, learner: true },
        expect.objectContaining({ op: 'box', label: 'body', at: at(2, 7), covers: 'body', learner: true }),
        { op: 'note', text: 'a doctype', at: { x: 900, y: 60 }, learner: true },
      ]);
      expect(onBoard(layout, ['tree', 'html', 'body', 'html-body'], r.ops)).toEqual(new Set(['html', 'body']));
    });
  });
});

