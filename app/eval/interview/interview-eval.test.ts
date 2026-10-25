import { describe, expect, it } from 'vitest';
import { GOLDENS } from './goldens';
import { evalOptions, hintedCredits, mae, replay, score } from './interview-eval';

// The interview eval, offline (design section 8): every golden replays through the director onto
// its labelled rows, the labelled tags aggregate to the labelled statuses, a tag that quotes the
// interviewer is never credited, and the ratings computed from the labelled verdicts are within
// the MAE gate of the reviewer's. The live gates (the real evaluator and grader) run in
// `npm run eval:interview` with INTERVIEW_EVAL_MODE=live.

const opts = evalOptions({});
const replays = GOLDENS.map(replay);

describe('the goldens', () => {
  it('cover every case the design requires that the text room can show', () => {
    const kinds = new Set(GOLDENS.map((g) => g.kind));
    for (const k of ['strong', 'weak', 'mixed', 'stuck-recovers', 'confidently-wrong', 'hinted', 'asked', 'injection', 'declined', 'last-stage', 'mid-sentence-advance', 'board-only', 'board-and-words', 'concept-strong', 'concept-weak']) expect(kinds.has(k as never), k).toBe(true);
    expect(new Set(GOLDENS.map((g) => g.id)).size).toBe(GOLDENS.length);
  });

  it.each(replays.map((r) => [r.golden.id, r] as const))('%s: the director lands on the labelled rows', (_, r) => {
    for (const d of r.director) expect(`${d.row}:${d.move}`, `turn ${d.seq} expected rows ${d.expectedRows.join('|')} ${d.expectedMove ?? ''}`).toMatch(new RegExp(`^(${d.expectedRows.join('|')}):${d.expectedMove ?? '.*'}$`));
    if (r.golden.ends) expect(r.ended).toBe(true);
    else expect(r.ended).toBe(false);
  });

  it.each(replays.map((r) => [r.golden.id, r] as const))('%s: the labelled tags aggregate to the labelled statuses', (_, r) => {
    expect(r.statuses.filter((s) => !s.ok)).toEqual([]);
  });

  it('rates sections from the labelled verdicts within the MAE gate, exactly on most', () => {
    const pairs = replays.flatMap((r) => r.ratings);
    expect(mae(pairs)).toBeLessThanOrEqual(opts.maxSectionMae);
    const off = replays.flatMap((r) => r.ratings.filter((x) => x.expected !== x.actual).map((x) => `${r.golden.id} ${x.section}: expected ${x.expected} got ${x.actual}`));
    expect(off).toEqual([]);
  });

  it('never credits words the interviewer said first', () => {
    const hinted = GOLDENS.find((g) => g.kind === 'hinted')!;
    expect(hintedCredits(hinted)).toBe(0);
    // The same words, asked about rather than stated, are credited.
    const asked = replay(GOLDENS.find((g) => g.kind === 'asked')!);
    expect(asked.ledger.entries[1].tags).toHaveLength(1);
  });

  it('never advances on "let’s move on" inside a sentence, and never loops on the last stage', () => {
    const mid = replays.find((r) => r.golden.kind === 'mid-sentence-advance')!;
    expect(mid.director.every((d) => d.move !== 'advance_stage' && d.move !== 'end_interview')).toBe(true);
    const last = replays.find((r) => r.golden.kind === 'last-stage')!;
    expect(last.director[last.director.length - 1].move).toBe('end_interview');
  });

  it('reads a board as partial evidence that never advances, and words on the same board as words', () => {
    const only = replays.find((r) => r.golden.kind === 'board-only')!;
    // The drawing: partial for the drawable items it shows, nothing covered, and the interviewer reads it with the first turn only.
    expect(only.ledger.entries.b1.source).toBe('board');
    expect(only.ledger.entries.b1.tags.length).toBeGreaterThanOrEqual(2);
    expect(only.ledger.entries.b1.tags.every((t) => t.status === 'partial' && t.quote === '')).toBe(true);
    expect(only.ledger.entries.b2).toBeUndefined();
    expect(only.statuses.filter((s) => s.actual === 'covered')).toEqual([]);
    expect(only.director.every((d) => d.move !== 'advance_stage' && d.move !== 'end_interview')).toBe(true);
    const first = only.turns.find((t) => t.role === 'candidate')!;
    expect(first.meta?.boardDelta).toMatch(/^<board v="1" stage="s2-one-request"/);
    expect(first.meta?.boardDelta).toContain('"Tool Runner"');
    expect(first.meta?.boardCoverage?.matched.map((m) => m.key)).toEqual(expect.arrayContaining(['gateway', 'orchestrator', 'llm', 'tool-runner', 'policy', 'billing']));
    expect(only.boardSnapshots).toHaveLength(1);
    // The words make the same items covered; the board's partials never demote them.
    const both = replays.find((r) => r.golden.kind === 'board-and-words')!;
    expect(both.statuses.filter((s) => s.n <= 2).map((s) => s.actual)).toEqual(['covered', 'covered']);
    expect(both.ledger.entries.b1.tags.every((t) => t.status === 'partial')).toBe(true);
  });

  it('treats an injection as words: no advance, no credit', () => {
    const r = replays.find((r) => r.golden.kind === 'injection')!;
    expect(r.director[0].move).toBe('ask');
    expect(r.ledger.entries[1].tags).toEqual([]);
    expect(r.ratings.map((x) => x.actual)).toEqual([1, 0]);
  });
});

describe('score', () => {
  it('computes precision, recall and the wrong false-positive rate over (item, status) pairs', () => {
    const s = score([
      { predicted: [{ item: 'a', status: 'covered' }, { item: 'b', status: 'wrong' }], expected: [{ item: 'a', status: 'covered' }, { item: 'c', status: 'partial' }] },
      { predicted: [{ item: 'd', status: 'wrong' }], expected: [{ item: 'd', status: 'wrong' }] },
    ]);
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.recall).toBeCloseTo(2 / 3);
    expect(s.wrongFalsePositive).toBeCloseTo(0.5);
  });

  it('credits an optional label for precision only, and a group of near-duplicate items once', () => {
    const s = score([
      // One required label and one optional alternate, both given: 2 hits of 2 predicted, 1 of 1 required.
      { predicted: [{ item: 'a', status: 'covered' }, { item: 'x', status: 'partial' }], expected: [{ item: 'a', status: 'covered' }, { item: 'x', status: 'partial', optional: true }] },
      // Two labels in one group: giving either is the whole group recalled, giving both is still one.
      { predicted: [{ item: 'b', status: 'covered' }], expected: [{ item: 'b', status: 'covered', group: 'g' }, { item: 'c', status: 'covered', group: 'g' }] },
      { predicted: [], expected: [{ item: 'b', status: 'covered', group: 'g' }, { item: 'c', status: 'covered', group: 'g' }] },
    ]);
    expect(s.precision).toBe(1);
    expect(s.expected).toBe(3);
    expect(s.recall).toBeCloseTo(2 / 3);
  });
});
