import { describe, expect, it } from 'vitest';
import type { BoardGraph } from '../../board/serialise';
import { countWords, drawParser, drawToolBody, drawToolResult, holdDraw, parseDraw } from './draw';

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
