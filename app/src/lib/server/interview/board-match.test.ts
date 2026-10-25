import type { BoardReference, DerivedStage } from '@arrowbox/content-kit';
import { describe, expect, it } from 'vitest';
import type { BoardGraph, BoardNode } from '../../board/serialise';
import { boardTags, coverageText, editSimilarity, matchBoard, parseBoardMatch, parseBoardVision, scoreLabel, sectionsUpTo } from './board-match';

// The board matcher against a reference like the customer-support agent's: components with
// aliases and a guarded one (Billing is reached only through the Tool Runner), the diagrams' edges.

const REF: BoardReference = {
  components: [
    { key: 'chat-gateway', name: 'Chat Gateway', kind: 'service', aliases: ['gateway', 'chat api'], introducedIn: 'csa/one-request', reachableOnlyVia: [], talksTo: [] },
    { key: 'orchestrator', name: 'Agent Orchestrator', kind: 'service', aliases: ['agent loop'], introducedIn: 'csa/one-request', reachableOnlyVia: [], talksTo: [] },
    { key: 'llm', name: 'LLM', kind: 'model', aliases: ['the model'], introducedIn: 'csa/one-request', reachableOnlyVia: [], talksTo: [] },
    { key: 'tool-runner', name: 'Tool Runner', kind: 'service', aliases: [], introducedIn: 'csa/actions', reachableOnlyVia: [], talksTo: [] },
    { key: 'billing', name: 'Billing', kind: 'service', aliases: ['billing system'], introducedIn: 'csa/actions', reachableOnlyVia: ['tool-runner'], talksTo: [] },
    { key: 'policy', name: 'Policy Service', kind: 'service', aliases: [], introducedIn: 'csa/actions', reachableOnlyVia: ['tool-runner'], talksTo: [] },
    { key: 'contact-centre', name: 'Contact Centre', kind: 'people', aliases: ['human agents'], introducedIn: 'csa/human-transfer', reachableOnlyVia: [], talksTo: [] },
  ],
  edges: [
    { from: 'chat-gateway', to: 'orchestrator', label: 'turns', source: 'diagram' },
    { from: 'orchestrator', to: 'llm', label: 'context and tools', source: 'diagram' },
    { from: 'orchestrator', to: 'tool-runner', label: 'tool calls', source: 'diagram' },
    { from: 'tool-runner', to: 'billing', label: 'apply_credit', source: 'diagram' },
    { from: 'tool-runner', to: 'policy', source: 'diagram' },
    { from: 'orchestrator', to: 'contact-centre', source: 'talksTo' },
  ],
};
const C = (key: string) => REF.components.find((c) => c.key === key)!;

const node = (id: string, label: string | null, x = 0): BoardNode => ({ id, eid: `e-${id}`, label, shape: 'box', frame: null, x, y: 0, w: 120, h: 60 });
const graph = (nodes: BoardNode[], edges: { from: string | null; to: string | null; direction?: 'forward' | 'both' | 'none' }[], free = 0): BoardGraph => ({
  nodes,
  frames: [],
  edges: edges.map((e, i) => ({ id: `e${i + 1}`, eid: `ex${i}`, from: e.from, to: e.to, label: null, direction: e.direction ?? 'forward', dashed: false, inferred: false })),
  freehand: { count: free, clusters: [] },
  layout: { direction: 'left-to-right', rows: [] },
});
const SECTIONS = ['csa/opening', 'csa/one-request', 'csa/actions'];

describe('scoring a label against a component', () => {
  it('takes the name, the key and an alias, case and punctuation aside', () => {
    expect(scoreLabel('Chat Gateway', C('chat-gateway'))).toEqual({ score: 1, how: 'name' });
    expect(scoreLabel('Orchestrator', C('orchestrator'))).toEqual({ score: 1, how: 'key' });
    expect(scoreLabel('CHAT  gateway!', C('chat-gateway'))).toEqual({ score: 1, how: 'name' });
    expect(scoreLabel('Agent loop', C('orchestrator'))).toEqual({ score: 0.9, how: 'alias' });
  });
  it('accepts a token overlap, a near-miss spelling and a synonym, and nothing else', () => {
    expect(scoreLabel('Gateway (chat)', C('chat-gateway'))).toEqual({ score: 0.8, how: 'tokens' });
    expect(scoreLabel('Tool Runer', C('tool-runner'))).toEqual({ score: 0.7, how: 'edit' });
    expect(scoreLabel('Payments', C('billing'))).toEqual({ score: 0.75, how: 'synonym' });
    expect(scoreLabel('Postgres', C('billing'))).toBeNull();
    expect(scoreLabel('', C('billing'))).toBeNull();
  });
  it('measures edit similarity with transpositions as one edit', () => {
    expect(editSimilarity('billing', 'billing')).toBe(1);
    expect(editSimilarity('bililng', 'billing')).toBeCloseTo(1 - 1 / 7);
    expect(editSimilarity('', 'x')).toBe(0);
  });
});

describe('matching a board', () => {
  it('matches each component once, lists what is missing by now and what the articles do not name', () => {
    const g = graph([node('n1', 'Chat Gateway'), node('n2', 'orchestrator'), node('n3', 'Agent Orchestrator'), node('n4', 'Weather API'), node('n5', null)], []);
    const cov = matchBoard(g, REF, { expectedSections: SECTIONS.slice(0, 2) });
    expect(cov.matched.map((m) => [m.node, m.key, m.how])).toEqual([
      ['n1', 'chat-gateway', 'name'],
      ['n2', 'orchestrator', 'key'],
    ]);
    // Expected by the one-request section: the LLM; the tool runner and billing come later.
    expect(cov.missing).toEqual(['llm']);
    expect(cov.extra).toEqual([{ node: 'n4', label: 'Weather API' }]);
    expect(cov.unlabelledRatio).toBe(0.2);
    expect(cov.freehandHeavy).toBe(false);
  });

  it('reads the arrows: drawn as the articles draw them, drawn where no article does, and the guarded ones first', () => {
    const g = graph(
      [node('n1', 'Chat Gateway'), node('n2', 'Agent Orchestrator'), node('n3', 'LLM'), node('n4', 'Tool Runner'), node('n5', 'Billing'), node('n6', 'Weather')],
      [
        { from: 'n1', to: 'n2' },
        { from: 'n3', to: 'n5' }, // the model calls billing: never in the articles, and billing is guarded
        { from: 'n2', to: 'n6' },
        { from: 'n4', to: 'n2', direction: 'none' }, // an undirected line counts both ways
        { from: 'n6', to: null },
      ],
    );
    const cov = matchBoard(g, REF, { expectedSections: SECTIONS });
    expect(cov.edges.matched).toEqual([
      { from: 'chat-gateway', to: 'orchestrator' },
      { from: 'tool-runner', to: 'orchestrator' },
    ]);
    expect(cov.edges.unexpected).toEqual([{ from: 'llm', to: 'billing', rule: 'reachableOnlyVia' }]);
    // The tool runner and billing are both drawn but not connected; the LLM and the orchestrator too.
    expect(cov.edges.missing).toEqual([
      { from: 'orchestrator', to: 'llm' },
      { from: 'tool-runner', to: 'billing' },
    ]);
    expect(cov.missing).toEqual(['policy']);
  });

  it('takes the model fallback’s answers at a lower score, for known nodes and components only', () => {
    const g = graph([node('n1', 'Thinky'), node('n2', 'Weather')], []);
    const cov = matchBoard(g, REF, { expectedSections: SECTIONS.slice(0, 2), modelMatches: { n1: 'llm', n2: 'no-such', n9: 'billing' } });
    expect(cov.matched).toEqual([{ node: 'n1', key: 'llm', score: 0.6, how: 'model' }]);
    expect(cov.extra).toEqual([{ node: 'n2', label: 'Weather' }]);
  });

  it('flags a board that is mostly strokes', () => {
    const cov = matchBoard(graph([node('n1', 'LLM')], [], 9), REF, { expectedSections: [] });
    expect(cov.freehandHeavy).toBe(true);
  });
});

describe('what the interviewer and the ledger get', () => {
  const g = graph([node('n1', 'Chat Gateway'), node('n2', 'Agent Orchestrator'), node('n3', 'LLM'), node('n4', 'Billing'), node('n5', 'Weather')], [{ from: 'n1', to: 'n2' }, { from: 'n3', to: 'n4' }]);
  const cov = matchBoard(g, REF, { expectedSections: SECTIONS });

  it('renders the coverage as questions, by component name, never as verdicts', () => {
    const text = coverageText(cov, REF);
    expect(text.startsWith('<board-questions>')).toBe(true);
    expect(text).toContain('Not on the board yet, though the design should have it by now: Tool Runner, Policy Service.');
    expect(text).toContain('Arrows worth a question (the articles never draw them): LLM -> Billing.');
    expect(text).toContain('Boxes the articles do not name: n5 "Weather".');
    expect(text).not.toContain('missing');
    expect(coverageText(matchBoard(graph([node('n1', 'Chat Gateway')], []), REF, { expectedSections: [] }), REF)).toBe('');
  });

  it('gives partial evidence for drawable items the board shows, and nothing for the rest', () => {
    const stage = {
      key: 's2',
      items: [
        { id: 'a', text: 'Names the main components: Chat Gateway, Agent Orchestrator, LLM, Tool Runner, Billing', weight: 'core', section: 'csa/one-request', drawable: true },
        { id: 'b', text: 'Explains the main flow: Chat Gateway -> Agent Orchestrator (turns); Agent Orchestrator -> LLM (context and tools)', weight: 'core', section: 'csa/one-request', drawable: true },
        { id: 'c', text: 'Explains the main flow: Agent Orchestrator -> Tool Runner (tool calls); Tool Runner -> Billing', weight: 'core', section: 'csa/one-request', drawable: true },
        { id: 'd', text: 'Says Chat Gateway and LLM matter', weight: 'supporting', section: 'csa/one-request' },
      ],
    } as unknown as DerivedStage;
    // Four of five components drawn (80%); one of two flow arrows (50%); none of the second flow.
    expect(boardTags(stage, REF, cov)).toEqual([
      { item: 'a', status: 'partial', conf: 0.6, quote: '' },
      { item: 'b', status: 'partial', conf: 0.6, quote: '' },
    ]);
  });

  it('lists the sections up to the current one across stages', () => {
    const stages = [{ sections: ['a', 'b'] }, { sections: ['c', 'd'] }] as unknown as DerivedStage[];
    expect(sectionsUpTo(stages, 1, 'c')).toEqual(['a', 'b', 'c']);
    expect(sectionsUpTo(stages, 0, 'a')).toEqual(['a']);
    expect(sectionsUpTo(stages, 5, 'zz')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('parses the fallbacks’ answers and drops what it cannot place', () => {
    const msg = (text: string, stop_reason = 'end_turn') => ({ stop_reason, content: [{ type: 'text', text }] }) as never;
    expect(parseBoardMatch(msg('{"matches":[{"node":"n5","key":"llm"},{"node":"n5","key":"nope"},{"node":"n7","key":"llm"}]}'), [{ node: 'n5' }], REF)).toEqual({ n5: 'llm' });
    expect(parseBoardMatch(msg('nonsense'), [{ node: 'n5' }], REF)).toBeNull();
    expect(parseBoardMatch(msg('{"matches":[]}', 'max_tokens'), [], REF)).toBeNull();
    expect(parseBoardVision(msg('  Three boxes, two arrows.  '))).toBe('Three boxes, two arrows.');
    expect(parseBoardVision(msg('x'.repeat(700))))!.toHaveLength(600);
    expect(parseBoardVision(msg('', 'refusal'))).toBeNull();
  });
});
