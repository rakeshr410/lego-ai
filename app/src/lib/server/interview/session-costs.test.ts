import { describe, expect, it } from 'vitest';
import { costsCsv, renderCosts, sessionCosts, type CostSession } from './session-costs';

// What each session cost by service, and each person's total (scripts/session-costs.ts).

const session = (over: Partial<CostSession>): CostSession => ({
  id: 'a'.repeat(24),
  readerId: 'r1',
  system: 'frontend-foundations',
  status: 'finished',
  startedAt: '2026-10-26T10:00:00.000Z',
  updatedAt: '2026-10-26T10:30:00.000Z',
  costUsd: 0,
  ...over,
});

describe('session costs', () => {
  const sessions = [
    session({ id: 'b'.repeat(24), kind: 'coach', mode: 'voice', course: { lesson: 'news-feed' }, learnerName: 'Rakesh', costUsd: 1.1, spend: { 'claude reply': 0.6, 'stt flux': 0.2, 'tts smallest': 0.25, 'daily room': 0.05 } }),
    // From before the lines were kept: all of it unsplit.
    session({ id: 'c'.repeat(24), startedAt: '2026-10-25T09:00:00.000Z', updatedAt: '2026-10-25T09:10:00.000Z', costUsd: 0.3 }),
    session({ id: 'd'.repeat(24), readerId: 'r2', startedAt: '2026-10-26T11:00:00.000Z', updatedAt: '2026-10-26T11:20:00.000Z', costUsd: 0.4, spend: { 'claude reply': 0.3, 'claude feedback': 0.1 } }),
    session({ id: 'e'.repeat(24), startedAt: '2026-09-01T00:00:00.000Z', costUsd: 9 }),
  ];

  it('groups each session by service, newest first, and totals each person, the costliest first', () => {
    const r = sessionCosts(sessions, { since: '2026-10-01T00:00:00.000Z' });
    expect(r.sessions.map((s) => s.id[0])).toEqual(['d', 'b', 'c']);
    expect(r.sessions[1]).toMatchObject({ what: 'lesson news-feed', mode: 'voice', minutes: 30, totalUsd: 1.1, name: 'Rakesh' });
    expect(r.sessions[1].groups).toEqual({ claude: 0.6, stt: 0.2, tts: 0.25, room: 0.05, unsplit: 0 });
    expect(r.sessions[2].groups.unsplit).toBeCloseTo(0.3, 6);
    expect(r.sessions[0].groups.claude).toBeCloseTo(0.4, 6);
    expect(r.people.map((p) => [p.readerId, p.sessions, Number(p.totalUsd.toFixed(2)), p.name])).toEqual([
      ['r1', 2, 1.4, 'Rakesh'],
      ['r2', 1, 0.4, null],
    ]);
    expect(sessionCosts(sessions, { since: '2026-10-01T00:00:00.000Z', reader: 'r2' }).sessions).toHaveLength(1);
  });

  it('renders a table, with the lines on --detail, and a CSV', () => {
    const r = sessionCosts(sessions, { since: '2026-10-01T00:00:00.000Z' });
    const text = renderCosts(r, { detail: true });
    expect(text).toContain('lesson news-feed');
    expect(text).toContain('tts smallest');
    expect(text).toContain('People (2), 3 sessions, $1.80 in all');
    const csv = costsCsv(r.sessions).split('\n');
    expect(csv[0]).toBe('started,session,reader,name,what,mode,status,minutes,total_usd,claude_usd,stt_usd,tts_usd,room_usd,unsplit_usd');
    expect(csv).toHaveLength(4);
  });
});
