import { describe, expect, it } from 'vitest';
import { kappaReport, parseRatingsCsv, renderKappa, weightedKappa, type RatingRow } from './kappa';

describe('weighted kappa', () => {
  it('is 1 on perfect agreement, 0.5 on a worked example, negative on reversal, NaN without variance', () => {
    expect(weightedKappa([0, 1, 2, 3, 4], [0, 1, 2, 3, 4])).toBe(1);
    // One disagreement by one step, out of four: observed 1/64, expected 1/32.
    expect(weightedKappa([0, 0, 1, 1], [0, 1, 1, 1])).toBeCloseTo(0.5, 10);
    expect(weightedKappa([0, 1, 2, 3, 4], [4, 3, 2, 1, 0])).toBeLessThan(0);
    expect(weightedKappa([2, 2, 2], [2, 2, 2])).toBeNaN();
    expect(weightedKappa([], [])).toBeNaN();
    expect(() => weightedKappa([1], [])).toThrow();
  });

  it('parses the CSV, skipping the header and refusing ratings outside 0-4', () => {
    const rows = parseRatingsCsv('session,key,rater,rating\ns1, intent ,grader,3\n\ns1,intent,ada,2\n');
    expect(rows).toEqual([
      { session: 's1', key: 'intent', rater: 'grader', rating: 3 },
      { session: 's1', key: 'intent', rater: 'ada', rating: 2 },
    ]);
    expect(() => parseRatingsCsv('s1,k,grader,5')).toThrow(/bad rating/);
  });
});

const study = (sessions: number, drift: (i: number) => number): RatingRow[] => {
  const rows: RatingRow[] = [];
  for (let i = 0; i < sessions; i++) {
    for (const key of ['intent', 'actions', 'handoff']) {
      const g = (i + key.length) % 5;
      rows.push({ session: `s${i}`, key, rater: 'grader', rating: g });
      rows.push({ session: `s${i}`, key, rater: 'ada', rating: Math.max(0, Math.min(4, g + drift(i))) });
      rows.push({ session: `s${i}`, key, rater: 'bob', rating: g });
    }
  }
  return rows;
};

describe('the kappa study', () => {
  it('passes when both humans agree with the grader on at least 20 sessions', () => {
    const r = kappaReport(study(20, () => 0));
    expect(r.raters).toEqual(['grader', 'ada', 'bob']);
    expect(r.grader).toHaveLength(2);
    expect(r.humans).toHaveLength(1);
    expect(r.grader.every((p) => p.kappa === 1 && p.sessions === 20)).toBe(true);
    expect(r.pass).toBe(true);
    expect(renderKappa(r)).toContain('PASS');
  });

  it('fails with too few sessions, a missing second human, or a rater far from the grader', () => {
    expect(kappaReport(study(12, () => 0))).toMatchObject({ pass: false });
    expect(kappaReport(study(12, () => 0)).reasons.join()).toMatch(/12 shared sessions, 20 needed/);
    const oneHuman = study(20, () => 0).filter((r) => r.rater !== 'bob');
    expect(kappaReport(oneHuman).reasons.join()).toMatch(/1 human rater/);
    // ada rates two steps away from the grader on every item: kappa drops below the gate.
    const far = kappaReport(study(20, (i) => (i % 2 ? 2 : -2)));
    const ada = far.grader.find((p) => p.b === 'ada')!;
    expect(ada.kappa).toBeLessThan(0.6);
    expect(far.pass).toBe(false);
    expect(far.reasons.join()).toMatch(/grader vs ada: kappa .* below 0.6/);
    expect(kappaReport([]).reasons[0]).toMatch(/no rows from the grader/);
  });
});
