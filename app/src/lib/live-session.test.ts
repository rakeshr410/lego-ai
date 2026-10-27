import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { on, resetBus, type BusEvent } from '../../../../lego/events/src/bus.ts';
import { isLive, leaveLive, sessionChanged } from './live-session';
import type { InterviewPage } from './interview.node';
import type { SessionView } from './server/interview/service';

// The room's session as the shell needs it (lib/live-session.ts): said on the page's bus as it
// starts and ends, and ended for the reader who leaves the page mid-way.

const page = { system: { slug: 'amazon' }, scope: null } as unknown as InterviewPage;
const lessonPage = { ...page, course: { playlist: 'amazon-storefront', lesson: 'listing' } } as unknown as InterviewPage;
const session = (over: Partial<SessionView> = {}) => ({ id: 's1', status: 'active', kind: 'interview', mode: 'text', ...over }) as unknown as SessionView;

let said: BusEvent[] = [];
beforeEach(() => {
  resetBus();
  said = [];
  on('*', (e) => said.push(e));
});
afterEach(() => sessionChanged(page, null));

const types = () => said.map((e) => `${e.type}:${(e.payload as { reason?: string }).reason ?? ''}`);

describe('sessionChanged', () => {
  it('says an interview started once, and finished when the room finishes it', () => {
    sessionChanged(page, session());
    sessionChanged(page, session());
    expect(isLive()).toBe(true);
    sessionChanged(page, session({ status: 'finished' }));
    expect(isLive()).toBe(false);
    expect(types()).toEqual(['interview.started:', 'interview.ended:finished']);
    expect(said[0].payload).toEqual({ system: 'amazon', scope: null, voice: false });
  });

  it('says a lesson as the classroom’s, and left when the room closes mid-way', () => {
    sessionChanged(lessonPage, session({ kind: 'coach' }));
    sessionChanged(lessonPage, null);
    expect(types()).toEqual(['classroom.lesson_started:', 'classroom.lesson_ended:left']);
    expect(said[1].payload).toEqual({ playlist: 'amazon-storefront', lesson: 'listing', reason: 'left' });
  });
});

describe('leaveLive', () => {
  it('ends the voice call first, then the session, and says the reader left', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    sessionChanged(page, session({ mode: 'voice', voice: { ended: false } } as Partial<SessionView>));
    await leaveLive();
    expect(fetch.mock.calls.map(([path, init]) => [path, JSON.parse((init as RequestInit).body as string), (init as RequestInit).keepalive])).toEqual([
      ['/api/interview/s1/voice', { action: 'leave' }, true],
      ['/api/interview/s1', { action: 'finish' }, true],
    ]);
    expect(isLive()).toBe(false);
    expect(types()).toEqual(['interview.started:', 'interview.ended:left']);
  });

  it('does nothing with no session live', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await leaveLive();
    expect(fetch).not.toHaveBeenCalled();
  });
});
