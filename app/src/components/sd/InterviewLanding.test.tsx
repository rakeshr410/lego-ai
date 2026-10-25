// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterviewPage } from '../../lib/interview.node';

const stage = (key: string, kind: string, title: string) => ({ key, kind, title, minutes: 7, goal: '', sections: [] });

const page = {
  system: { slug: 'customer-support-agent', name: 'Customer support agent', icon: null },
  scope: 'system',
  topic: null,
  section: null,
  full: true,
  title: 'Design a customer support agent',
  summary: 'A 45-minute interview.',
  minutes: 45,
  feedbackMinutes: 3,
  stages: [stage('a', 'requirements', 'Problem'), stage('b', 'deep-dive', 'State'), stage('c', 'wrap-up', 'Trade-offs')],
  sections: [],
  derived: true,
  dimensions: [
    { key: 'req', title: 'Requirements', description: null },
    { key: 'safety', title: 'Safety', description: null },
  ],
  readFirst: [{ title: 'Understand the system', href: '/systems/x/understand' }],
  checklist: ['A board to draw on, or paper'],
  drills: [
    { topic: 'understand', section: null, title: 'Understand the system', minutes: 13, href: '/i?topic=understand' },
    { topic: 'understand', section: 'problem', title: 'The problem in one message', minutes: 7, href: '/i?topic=understand&section=problem' },
    { topic: 'develop', section: null, title: 'Develop the design', minutes: 13, href: '/i?topic=develop' },
  ],
} as unknown as InterviewPage;

const overview = (voiceRemaining: number) => ({
  signedIn: true,
  status: { enabled: true, remaining: 3, limit: 3, drillsRemaining: 5, drillLimit: 5, resetsAt: '2026-11-01T00:00:00Z', retentionDays: 30, consentVersion: 'c1' },
  voice: { enabled: true, remaining: voiceRemaining, limit: 5, topups: 0, minutesLeft: 200, resetsAt: '2026-11-01T00:00:00Z', consentVersion: 'v1' },
  current: null,
  past: [],
  page: null,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};

describe('the landing helpers', () => {
  it('ticks each stage start, not the end', async () => {
    const { timeline } = await import('./InterviewLanding');
    expect(timeline(page).ticks).toEqual([0, 7, 14, 21]);
    expect(timeline(page).stages.map((s) => s.group)).toEqual(['understand', 'develop', 'evaluate', 'feedback']);
  });

  it('groups the drills by topic', async () => {
    const { drillGroups } = await import('./InterviewLanding');
    expect(drillGroups(page.drills).map((g) => [g.topic.title, g.sections.map((s) => s.title)])).toEqual([
      ['Understand the system', ['The problem in one message']],
      ['Develop the design', []],
    ]);
  });
});

describe('InterviewLanding', () => {
  it('lays out the tiles, the skills, the drills and the start card', async () => {
    const { default: InterviewLanding } = await import('./InterviewLanding');
    act(() => root.render(<InterviewLanding page={page} action={<p>body</p>} usage="Uses 1 of your 5 voice sessions this month · 2 left." />));
    expect(host.querySelector('h1')?.textContent).toBe('Design a customer support agent');
    expect(host.querySelectorAll('.ivl-tile')).toHaveLength(4);
    expect(host.querySelector('.ivl-tiles')?.getAttribute('style')).toContain('7fr 7fr 7fr 3fr');
    expect([...host.querySelectorAll('.ivl-chips li')].map((e) => e.textContent)).toEqual(['Requirements', 'Safety']);
    expect([...host.querySelectorAll('.ivl-drill__title')].map((e) => e.textContent)).toEqual(['Understand the system', 'Develop the design']);
    expect(host.querySelector('.ivl-start__title')?.textContent).toBe('Full interview · 3 stages');
    expect(host.querySelector('.ivl-start__usage')?.textContent).toContain('2 left');
    expect(host.querySelector('.ivl-start__body')?.textContent).toBe('body');
  });

  it('ticks off "Get ready" and keeps it in the browser', async () => {
    const { default: InterviewLanding } = await import('./InterviewLanding');
    act(() => root.render(<InterviewLanding page={page} action={null} />));
    const boxes = host.querySelectorAll<HTMLInputElement>('.ivl-ready input');
    expect(boxes).toHaveLength(2);
    act(() => boxes[1].click());
    expect(host.querySelector('.ivl-ready .ivl-count')?.textContent).toBe('1 / 2');
    expect(JSON.parse(localStorage.getItem('interview:ready:customer-support-agent') ?? '[]')).toEqual(['have:A board to draw on, or paper']);
  });
});

describe('the start card in a voice build', () => {
  it('shows the consent in the card and starts only once agreed', async () => {
    vi.stubEnv('PUBLIC_INTERVIEW_VOICE_ENABLED', 'true');
    const fetch = vi.fn(async () => new Response(JSON.stringify(overview(2)), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const { default: InterviewApp } = await import('./InterviewApp');
    act(() => root.render(<InterviewApp page={page} />));
    await flush();
    const body = host.querySelector('.ivl-start__body')!;
    expect(body.textContent).toContain('Before we start');
    expect(host.querySelector('.ivl-start__usage')?.textContent).toBe('Uses 1 of your 5 voice sessions this month · 2 left.');
    const go = body.querySelector<HTMLButtonElement>('.iv-start--go')!;
    expect(go.textContent).toContain('Check my microphone and start');
    expect(go.disabled).toBe(true);
    const agree = [...body.querySelectorAll('label')].find((l) => l.textContent?.includes('I understand and agree'))!.querySelector('input')!;
    act(() => agree.click());
    expect(go.disabled).toBe(false);
    // There is no typed start in a voice build.
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Start interview'))).toBe(false);
  });

  it('says why when the month’s voice sessions are used', async () => {
    vi.stubEnv('PUBLIC_INTERVIEW_VOICE_ENABLED', 'true');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(overview(0)), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const { default: InterviewApp } = await import('./InterviewApp');
    act(() => root.render(<InterviewApp page={page} />));
    await flush();
    expect(host.querySelector('.ivl-start__usage')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.iv-start')?.disabled).toBe(true);
    expect(host.querySelector('.ivl-start__body')?.textContent).toContain('You’ve used this month’s 5 voice sessions');
  });
});
