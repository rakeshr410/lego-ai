import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, render, summarise, type SessionRow } from './cost-report';

const NOW = new Date('2026-11-10T12:00:00Z');
const row = (o: Partial<SessionRow>): SessionRow => ({ mode: 'text', status: 'finished', startedAt: '2026-11-09T10:00:00Z', costUsd: 0.35, system: 'customer-support-agent', readerId: 'r1', ...o });

describe('the cost re-measurement', () => {
  it('counts sessions by day and mode within the window, finished ones against the model', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row({ costUsd: 0.3 + i * 0.02, readerId: `r${i}` })),
      row({ status: 'active', costUsd: 0.1 }),
      row({ mode: 'voice', costUsd: 1.05, startedAt: '2026-11-10T01:00:00Z' }),
      row({ startedAt: '2026-10-01T00:00:00Z', costUsd: 9 }), // outside the window
    ];
    const s = summarise(rows, DEFAULT_MODEL, 14, NOW);
    expect(s.days).toHaveLength(14);
    expect(s.days[0].day).toBe('2026-10-28');
    expect(s.days.at(-1)).toMatchObject({ day: '2026-11-10', voice: { sessions: 1 } });
    expect(s.days.find((d) => d.day === '2026-11-09')!.text.sessions).toBe(6);
    expect(s.modes.text).toMatchObject({ sessions: 6, finished: 5, readers: 5, verdict: 'within' });
    expect(s.modes.text.meanUsd).toBeCloseTo(0.34, 5);
    expect(s.modes.voice).toMatchObject({ sessions: 1, finished: 1, verdict: 'insufficient' });
    expect(s.systems).toEqual({ 'customer-support-agent': 7 });
    expect(s.gate).toBe('pass');
    expect(render(s)).toContain('gate (cost within tolerance of the model, every mode with enough finished sessions): PASS');
  });

  it('fails the gate when a judged mode runs over, and is insufficient with too few finished sessions', () => {
    const over = Array.from({ length: 5 }, () => row({ costUsd: 0.5 }));
    expect(summarise(over, DEFAULT_MODEL, 14, NOW).gate).toBe('fail');
    expect(summarise(over, DEFAULT_MODEL, 14, NOW).modes.text.verdict).toBe('over');
    expect(summarise(over.slice(0, 3), DEFAULT_MODEL, 14, NOW).gate).toBe('insufficient');
    const under = Array.from({ length: 5 }, () => row({ mode: 'voice', costUsd: 0.5 }));
    expect(summarise(under, DEFAULT_MODEL, 14, NOW).modes.voice.verdict).toBe('under');
    expect(summarise([], DEFAULT_MODEL, 14, NOW).modes.text.ratio).toBeNull();
  });
});
