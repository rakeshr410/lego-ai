import type { APIRoute } from 'astro';
import { readerOr503, sseResponse, wantsStream } from '../../../lib/server/ask-http';
import { isSameOrigin, json, readJson, tooMany } from '../../../lib/server/http';
import { handle, interviewErrorBody, interviewOff } from '../../../lib/server/interview/http';
import { ID_PATTERN } from '../../../lib/server/interview/sessions';
import type { DrawAnchor, DrawOp } from '../../../lib/server/interview/draw';
import { advance, continueLesson, finish, idle, InterviewError, readSession, removeSession, reply } from '../../../lib/server/interview/service';
import { releaseVoiceFor, settleVoice } from '../../../lib/server/interview/voice';
import { rateLimit } from '../../../lib/server/rate-limit';

export const prerender = false;

// One mock interview session (P3-11). A 404 in a build without PUBLIC_INTERVIEW_ENABLED, and for a
// session that isn't the signed-in reader's.
//
//   GET                                   the session (transcript, stage, clock, feedback)
//   POST {action: "reply", text}          the candidate's message; the interviewer's reply. With
//                                         `Accept: text/event-stream` the reply streams:
//                                           event: delta  {"text": "..."}
//                                           event: done   {turn, session}   both turns saved
//                                           event: error  {error, code, status, retryAfter}
//                                         Checks that fail before Claude is called are plain JSON.
//   POST {action: "continue"}            a coach lesson (docs/coach-mode.md): the coach's next
//                                         move without a message; streams like a reply
//   POST {action: "advance", from}        the next stage (from: the stage index being left)
//   POST {action: "finish"}               ends the session and writes the feedback
//   POST {action: "idle", rung}           the candidate has been quiet rung seconds (20, 35, 60,
//                                         120): a nudge, a rephrased question or a hint offer;
//                                         nothing is advanced on silence
//   DELETE                                deletes the session now
// In a voice session, reply, advance, idle and finish are 409 voice_live while a voice pipeline
// holds the session (its lease, renewed by its turns and heartbeats; stale after a minute), and
// before the first pipeline has attached (the voice speaks first): the candidate speaks, or ends
// the voice part first (POST [id]/voice {action: "leave"}).

const signedIn = async (cookies: Parameters<APIRoute>[0]['cookies']) => {
  const reader = await readerOr503(cookies);
  if (reader instanceof Response) return reader;
  if (!reader) return json({ error: 'Sign in to continue your mock interview.' }, 401);
  return reader;
};

export const GET: APIRoute = async ({ params, cookies }) => {
  const off = interviewOff();
  if (off) return off;
  const id = params.id ?? '';
  if (!ID_PATTERN.test(id)) return json({ error: 'Unknown session' }, 404);
  const reader = await signedIn(cookies);
  if (reader instanceof Response) return reader;
  const limit = await rateLimit(`interview:get:${reader.documentId}`, 120, 60_000);
  if (!limit.ok) return tooMany(limit.retryAfter, 'Too many requests. Give it a minute.');
  return handle('read', async () => {
    // A voice session parked too long ends its voice part here.
    await settleVoice(reader.documentId, id);
    return json({ session: await readSession(reader.documentId, id) });
  });
};

export const POST: APIRoute = async ({ request, url, params, cookies }) => {
  const off = interviewOff();
  if (off) return off;
  if (!isSameOrigin(request, url)) return json({ error: 'Forbidden' }, 403);
  const id = params.id ?? '';
  if (!ID_PATTERN.test(id)) return json({ error: 'Unknown session' }, 404);
  const reader = await signedIn(cookies);
  if (reader instanceof Response) return reader;
  const limit = await rateLimit(`interview:${reader.id}`, 30, 60_000, { failOpen: false });
  if (!limit.ok) return tooMany(limit.retryAfter, 'That’s a lot of messages. Give it a minute.');
  const body = await readJson(request, 16 * 1024);
  const action = body?.action;

  if (action === 'advance') return handle('advance', async () => json({ session: await advance(reader.documentId, id, body?.from) }));
  if (action === 'finish') return handle('finish', async () => json({ session: await finish(reader.documentId, id, { signal: request.signal }) }));
  if (action === 'idle') return handle('idle', async () => json({ session: await idle(reader.documentId, id, body?.rung) }));
  if (action !== 'reply' && action !== 'continue') return json({ error: 'Unknown action' }, 400);

  const text = typeof body?.text === 'string' ? body.text : '';
  const run = (opts: { signal: AbortSignal; onText?: (delta: string) => void; onDraw?: (ops: DrawOp[], anchor: DrawAnchor) => void }) => (action === 'continue' ? continueLesson(reader.documentId, id, opts) : reply(reader.documentId, id, text, opts));
  if (!wantsStream(request)) return handle(action, async () => json(await run({ signal: request.signal })));
  // The stream: `delta` for the words, `draw` for each drawing as its element closes (the room applies it at once), then `done` with the saved turn.
  return sseResponse(request, async (send, signal) => {
    try {
      send('done', await run({ signal, onText: (delta) => send('delta', { text: delta }), onDraw: (ops, anchor) => send('draw', { ops, anchor }) }));
    } catch (err) {
      if (err instanceof InterviewError) send('error', interviewErrorBody(err));
      else {
        console.error('[interview] reply:', err);
        send('error', { error: 'The interviewer couldn’t answer just now. Send your message again.', code: 'upstream', status: 502, retryAfter: null });
      }
    }
  });
};

export const DELETE: APIRoute = async ({ request, url, params, cookies }) => {
  const off = interviewOff();
  if (off) return off;
  if (!isSameOrigin(request, url)) return json({ error: 'Forbidden' }, 403);
  const id = params.id ?? '';
  if (!ID_PATTERN.test(id)) return json({ error: 'Unknown session' }, 404);
  const reader = await signedIn(cookies);
  if (reader instanceof Response) return reader;
  return handle('delete', async () => {
    await releaseVoiceFor(reader.documentId, id);
    await removeSession(reader.documentId, id);
    return json({ deleted: true });
  });
};
