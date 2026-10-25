// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterviewPage } from '../../lib/interview.node';
import type { SessionView } from '../../pages/api/interview/index';
import InterviewFeedback, { firstOpen, minutesUsed, splitSummary } from './InterviewFeedback';

const stage = (key: string, title: string, sections: string[]) => ({ key, kind: 'requirements' as const, title, minutes: 7, goal: '', sections });

const page = {
  system: { slug: 'customer-support-agent', name: 'Agentic', icon: null },
  scope: 'system',
  topic: null,
  section: null,
  full: true,
  title: 'Design a customer support agent',
  summary: '',
  minutes: 21,
  feedbackMinutes: 5,
  stages: [stage('scope', 'Problem, scope and requirements', ['problem']), stage('flow', 'Request flow', ['flow']), stage('tradeoffs', 'Trade-offs and summary', ['summary'])],
  sections: [
    { key: 'problem', title: 'The problem in one message', topic: 't', href: '/systems/x#problem' },
    { key: 'flow', title: 'Request flow', topic: 't', href: '/systems/x#flow' },
    { key: 'summary', title: 'Architecture summary', topic: 't', href: null },
  ],
  derived: true,
  dimensions: [
    { key: 'structure', title: 'Structure', description: null },
    { key: 'safety', title: 'Safety', description: null },
  ],
  readFirst: [],
  checklist: [],
  drills: [],
} as unknown as InterviewPage;

const session = (over: Partial<SessionView> = {}): SessionView =>
  ({
    id: 's1',
    system: 'customer-support-agent',
    scope: null,
    status: 'finished',
    startedAt: '2026-10-24T10:00:00.000Z',
    plannedMinutes: 21,
    endsAt: '2026-10-24T10:26:00.000Z',
    stageIndex: 0,
    stageStartedAt: '2026-10-24T10:00:00.000Z',
    turns: [
      { role: 'interviewer', stage: 'scope', text: 'Hello', at: '2026-10-24T10:00:10.000Z' },
      { role: 'candidate', stage: 'scope', text: 'Can you see my board?', at: '2026-10-24T10:02:05.000Z' },
    ],
    turnsLeft: 10,
    mode: 'voice',
    voice: null,
    stagePausedMs: 0,
    closed: null,
    feedbackNote: null,
    planChanged: false,
    feedback: {
      summary: 'Too early to judge — the requirements stage never got going. The traffic question went unanswered.',
      stages: [{ key: 'scope', rating: 1, strengths: ['Checked the board first.'], improvements: ['Answer scope first.', 'State targets.'] }],
      dimensions: [
        { key: 'structure', rating: 1, note: 'Only a generic pair.' },
        { key: 'safety', rating: 0, note: 'Nothing on money.' },
      ],
      nextSteps: ['Open with one crisp scope message.', 'Give a traffic number.'],
      at: '2026-10-24T10:03:00.000Z',
      sections: [{ key: 'problem', rating: 1 }],
      weakAreas: ['problem'],
      notCovered: ['flow', 'summary'],
      items: [{ id: 'i1', section: 'problem', text: '~7,200 chats a day', verdict: 'missing', note: 'A volume grounds the design.', quote: '' }],
    },
    ...over,
  }) as SessionView;

describe('the feedback helpers', () => {
  it('splits the summary after its first sentence', () => {
    expect(splitSummary('One thing. Then two.')).toEqual({ head: 'One thing.', rest: 'Then two.' });
    expect(splitSummary('Only one')).toEqual({ head: 'Only one', rest: '' });
  });

  it('counts minutes from the start to the last turn, less parked time', () => {
    expect(minutesUsed(session())).toBe(2);
    expect(minutesUsed(session({ voice: { pausedMs: 60_000 } as SessionView['voice'] }))).toBe(1);
    expect(minutesUsed(session({ turns: [] }))).toBe(0);
  });

  it('opens the weakest stage reached, and none when nothing was reached', () => {
    expect(firstOpen([{ key: 'a', rating: 3 }, { key: 'b', rating: 1 }, { key: 'c', rating: 1 }])).toBe('b');
    expect(firstOpen([{ key: 'a', rating: 0 }])).toBeNull();
  });
});

describe('InterviewFeedback', () => {
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
  });

  const render = (s: SessionView, props: Partial<Parameters<typeof InterviewFeedback>[0]> = {}) =>
    act(() =>
      root.render(<InterviewFeedback page={page} session={s} transcript={<div data-testid="log">log</div>} deleting={false} error="" onDelete={() => {}} onRetry={() => {}} {...props} />),
    );

  it('shows the verdict, the stages reached, the open stage and the topics not covered', () => {
    render(session());
    const text = host.textContent ?? '';
    expect(host.querySelector('h1')?.textContent).toBe('Design a customer support agent');
    expect(host.querySelector('.ivf-verdict__head')?.textContent).toBe('Too early to judge — the requirements stage never got going.');
    expect(host.querySelector('.ivf-ring__chart')?.getAttribute('aria-label')).toBe('1 of 3 stages reached');
    expect(text).toContain('~2');
    // The reached stage is open: what went well, what to work on, and the checkpoint with its link.
    expect(host.querySelector('#ivf-stage')?.textContent).toContain('Checked the board first.');
    expect(host.querySelector('.ivf-check__title')?.textContent).toBe('~7,200 chats a day');
    expect(host.querySelector<HTMLAnchorElement>('.ivf-check__read')?.getAttribute('href')).toBe('/systems/x#problem');
    // Unreached stages are not buttons; the not-covered topics are tags.
    expect(host.querySelectorAll('button.ivf-track__btn')).toHaveLength(1);
    expect([...host.querySelectorAll('.ivf-tag:not(.ivf-tag--solid)')].map((e) => e.textContent)).toEqual(['Request flow', 'Architecture summary']);
    // A skill not reached gets the dashed meter.
    expect(host.querySelectorAll('.ivf-meter__none')).toHaveLength(1);
    expect(host.querySelector('[data-testid="log"]')).toBeNull();
  });

  it('opens the transcript, ticks practice steps and wires delete and retry', () => {
    const onDelete = vi.fn();
    const onRetry = vi.fn();
    render(session(), { onDelete, onRetry });
    const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!;
    act(() => button('View transcript').click());
    expect(host.querySelector('[data-testid="log"]')).not.toBeNull();
    const box = host.querySelector<HTMLInputElement>('.ivf-practise input')!;
    act(() => box.click());
    expect(box.checked).toBe(true);
    expect(host.querySelector('.ivf-card__head .ivf-count')?.textContent).toBe('1 / 2');
    expect(JSON.parse(localStorage.getItem('interview:practised:s1') ?? '[]')).toEqual([0]);
    act(() => button('Delete session').click());
    act(() => button('Retry this interview').click());
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('says why when there is no feedback', () => {
    render(session({ feedback: null, feedbackNote: 'The session was too short to grade.' }));
    expect(host.textContent).toContain('The session was too short to grade.');
    expect(host.querySelector('.ivf-verdict')).toBeNull();
  });
});
