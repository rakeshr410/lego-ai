// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionView, VoiceJoin } from '../../pages/api/interview/index';

// A stand-in for the Daily/Pipecat call: it goes live on connect and lets the test say who speaks.
const call = vi.hoisted(() => ({ events: null as null | { onState: (s: string) => void; onSpeaking: (w: string | null) => void; onCaption: (c: unknown) => void }, muted: false }));
vi.mock('../../lib/voice-call', () => ({
  VoiceCall: class {
    constructor(events: typeof call.events) {
      call.events = events;
    }
    async connect() {
      call.events?.onState('live');
    }
    setMuted(m: boolean) {
      call.muted = m;
    }
    async disconnect() {}
  },
}));

import VoiceRoom from './VoiceRoom';

const join: VoiceJoin = { url: 'https://x.daily.co/r', token: 't', expiresAt: new Date(Date.now() + 3_600_000).toISOString() } as VoiceJoin;
const session = {
  id: 's1',
  turns: [
    { role: 'interviewer', stage: 'a', text: 'Let’s design a customer support agent.', at: '2026-10-24T10:00:00Z' },
    { role: 'event', stage: 'a', text: '[stage]', at: '2026-10-24T10:00:01Z' },
    { role: 'candidate', stage: 'a', text: 'Can you see my board?', at: '2026-10-24T10:00:20Z' },
  ],
  voice: { degraded: [], exchangesLeft: 40, ended: false, pausedMs: 0 },
} as unknown as SessionView;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  call.muted = false;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};

describe('VoiceRoom in the call layout (design 17a)', () => {
  it('shows both speakers, who is talking, mute and the transcript', async () => {
    const onHide = vi.fn();
    act(() => root.render(<VoiceRoom sessionId="s1" join={join} session={session} onSession={() => {}} onLeft={() => {}} layout="call" showTranscript onHideTranscript={onHide} />));
    await flush();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Live. Speak when you’re ready.');
    const tiles = host.querySelectorAll('.ivc-tile');
    expect(tiles).toHaveLength(2);

    act(() => call.events?.onSpeaking('interviewer'));
    expect(tiles[0].classList.contains('is-speaking')).toBe(true);
    expect(tiles[0].querySelector('.ivc-wave')?.classList.contains('is-on')).toBe(true);

    // Muting: the button says so, the call is muted, and your wave goes.
    const mute = host.querySelector<HTMLButtonElement>('.ivc-mute')!;
    act(() => mute.click());
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    expect(mute.textContent).toBe('Unmute');
    expect(call.muted).toBe(true);
    expect(tiles[1].querySelector('.ivc-wave')).toBeNull();

    // The saved turns without events, the last one in full; a live caption after them.
    expect([...host.querySelectorAll('.ivc-line')].map((l) => l.textContent)).toEqual(['InterviewerLet’s design a customer support agent.', 'YouCan you see my board?']);
    expect(host.querySelector('.ivc-line.is-last')?.textContent).toContain('Can you see my board?');
    act(() => call.events?.onCaption({ who: 'interviewer', text: 'Yes, I can see a box labelled frontend.', final: false }));
    expect(host.querySelector('.ivc-line.is-last')?.textContent).toContain('Yes, I can see a box');

    act(() => host.querySelector<HTMLButtonElement>('.ivc-close')!.click());
    expect(onHide).toHaveBeenCalledOnce();
  });

  it('leaves the transcript out when it is hidden', async () => {
    act(() => root.render(<VoiceRoom sessionId="s1" join={join} session={session} onSession={() => {}} onLeft={() => {}} layout="call" showTranscript={false} />));
    await flush();
    expect(host.querySelector('.ivc-transcript')).toBeNull();
    expect(host.querySelectorAll('.ivc-tile')).toHaveLength(2);
  });
});
