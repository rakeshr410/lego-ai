import { emit } from '../../../../lego/events/src/bus.ts';
import type { InterviewPage } from './interview.node';
import type { SessionView } from './server/interview/service';

// The room's session as the page around it needs to know it (src/remote/contract.ts): whether one
// is live, said on the page's bus as it starts and ends (`interview.started` / `.ended`, or the
// classroom's `lesson_started` / `lesson_ended`), and how to end it when the reader leaves the page
// mid-way (leaveLive, which the shell calls once the reader confirms). InterviewRoom reports every
// change of its session here.

type Live = { id: string; page: InterviewPage; kind: SessionView['kind']; voice: boolean };

let live: Live | null = null;

const voiceOn = (s: SessionView) => s.mode === 'voice' && !!s.voice && !s.voice.ended;

function say(l: Live, what: 'started' | 'finished' | 'left') {
  const course = l.page.course;
  if (l.kind === 'coach' && course) {
    if (what === 'started') emit('classroom.lesson_started', { playlist: course.playlist, lesson: course.lesson }, 'classroom');
    else emit('classroom.lesson_ended', { playlist: course.playlist, lesson: course.lesson, reason: what }, 'classroom');
    return;
  }
  const at = { system: l.page.system.slug, scope: l.page.scope };
  if (what === 'started') emit('interview.started', { ...at, voice: l.voice }, 'interview');
  else emit('interview.ended', { ...at, reason: what }, 'interview');
}

/** The room's session now (null: the room closed). */
export function sessionChanged(page: InterviewPage, session: SessionView | null) {
  if (session && session.status !== 'finished') {
    const next: Live = { id: session.id, page, kind: session.kind, voice: voiceOn(session) };
    if (live?.id !== session.id) {
      if (live) say(live, 'left');
      say(next, 'started');
    }
    live = next;
    return;
  }
  if (live) say(live, session ? 'finished' : 'left');
  live = null;
}

/** Whether a session is live in the room: leaving the page would leave it open. */
export const isLive = () => live !== null;

/**
 * Ends the live session, as the room's End does: the voice part first (the session refuses to
 * finish while it is live), then the session. `keepalive`, so it lands though the page goes away.
 */
export async function leaveLive(): Promise<void> {
  const l = live;
  if (!l) return;
  live = null;
  const post = (path: string, body: unknown) =>
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => null);
  if (l.voice) await post(`/api/interview/${l.id}/voice`, { action: 'leave', ...(l.kind === 'coach' ? { finish: true } : {}) });
  await post(`/api/interview/${l.id}`, { action: 'finish' });
  say(l, 'left');
}
