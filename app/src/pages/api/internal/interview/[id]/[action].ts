import type { APIRoute } from 'astro';
import { sseResponse, wantsStream } from '../../../../../lib/server/ask-http';
import { json, readJson, tooMany } from '../../../../../lib/server/http';
import { interviewConfig } from '../../../../../lib/server/interview/config';
import { handle, interviewErrorBody, interviewOff } from '../../../../../lib/server/interview/http';
import { InterviewError } from '../../../../../lib/server/interview/service';
import { ID_PATTERN } from '../../../../../lib/server/interview/sessions';
import { attachPipeline, pipelineAdvance, pipelineDetach, pipelineHeartbeat, pipelineIdle, pipelinePlayed, pipelineSpeculate, pipelineTurn } from '../../../../../lib/server/interview/voice';
import { bearerMatches } from '../../../../../lib/server/interview/voice-token';
import { rateLimit } from '../../../../../lib/server/rate-limit';

export const prerender = false;

// The interview-voice service's side of a voice session (design section 6, "voice → web"). Reached
// only on the private network with `Authorization: Bearer INTERVIEW_VOICE_SECRET`; everything else
// is a 404, like the public routes in a build without the interview. Every call after attach
// carries the pipeline's epoch; one from an older epoch is 409 stale_epoch and that pipeline stops.
//
//   POST attach     {token, task}                         takes the session: {epoch, seq, stage, say, ...}
//   POST turns      {epoch, seq, text}                    a spoken candidate turn; the reply streams
//                                                         (Accept: text/event-stream): delta, draw {ops, anchor}, done {turn, state}, error
//   POST turns      {epoch, kind: "continue"}             a coach lesson's next move (docs/coach-mode.md),
//                                                         no words from the learner; streams the same way
//   POST turns      {epoch, text, speculative: true}      the turn as heard so far, before it is confirmed:
//                                                         the reply is started on it: {started}
//   POST played     {epoch, spoken}                       the reply was cut off after these words
//   POST advance    {epoch, from}                         the next stage: {say: its opener}
//   POST idle       {epoch, rung}                         silence of rung seconds: {say}
//   POST heartbeat  {epoch, sttSeconds, ttsChars, roomSeconds, stt, tts, degraded}  renews the lease, charges speech and the room: {closed}
//   POST detach     {epoch, reason}                       transport | left | ended | error
//
// Rate limit: 240 calls a minute per session (a heartbeat every 15 s, a turn every few seconds).

const ACTIONS = new Set(['attach', 'turns', 'played', 'advance', 'idle', 'heartbeat', 'detach']);

export const POST: APIRoute = async ({ request, params }) => {
  const off = interviewOff();
  if (off) return off;
  const cfg = interviewConfig();
  if (!cfg.voice.secret || !bearerMatches(cfg.voice.secret, request.headers.get('authorization'))) return json({ error: 'Not found' }, 404);
  const id = params.id ?? '';
  const action = params.action ?? '';
  if (!ID_PATTERN.test(id) || !ACTIONS.has(action)) return json({ error: 'Not found' }, 404);
  const limit = await rateLimit(`interview:voice:${id}`, 240, 60_000, { failOpen: false });
  if (!limit.ok) return tooMany(limit.retryAfter, 'Too many calls for this session.');
  const body = (await readJson(request, 64 * 1024)) ?? {};
  const epoch = Number(body.epoch);
  const call = { epoch: Number.isInteger(epoch) ? epoch : -1 };

  if (action === 'attach') return handle('voice attach', async () => json(await attachPipeline(id, body.token, body.task)));
  if (action === 'played') return handle('voice played', async () => (await pipelinePlayed(id, call, body.spoken), json({ ok: true })));
  if (action === 'advance') return handle('voice advance', async () => json(await pipelineAdvance(id, call, body.from)));
  if (action === 'idle') return handle('voice idle', async () => json(await pipelineIdle(id, call, body.rung)));
  if (action === 'heartbeat') {
    return handle('voice heartbeat', async () => json(await pipelineHeartbeat(id, call, { sttSeconds: Number(body.sttSeconds), ttsChars: Number(body.ttsChars), roomSeconds: Number(body.roomSeconds) || 0, stt: body.stt as string | undefined, tts: body.tts as string | undefined, degraded: Array.isArray(body.degraded) ? (body.degraded as string[]) : [] })));
  }
  if (action === 'detach') return handle('voice detach', async () => (await pipelineDetach(id, call, body.reason), json({ ok: true })));

  const text = typeof body.text === 'string' ? body.text : '';
  if (body.speculative === true) return handle('voice speculate', async () => json(await pipelineSpeculate(id, call, text)));
  const seq = Number(body.seq);
  const turn = { ...call, seq: Number.isInteger(seq) ? seq : -1 };
  const kind = body.kind === 'continue' ? ('continue' as const) : ('speech' as const);
  if (!wantsStream(request)) return handle('voice turn', async () => json(await pipelineTurn(id, turn, text, { signal: request.signal, kind })));
  return sseResponse(request, async (send, signal) => {
    try {
      send('done', await pipelineTurn(id, turn, text, { signal, kind, onText: (delta) => send('delta', { text: delta }), onDraw: (ops, anchor) => send('draw', { ops, anchor }) }));
    } catch (err) {
      if (err instanceof InterviewError) send('error', interviewErrorBody(err));
      else {
        console.error('[interview] voice turn:', err);
        send('error', { error: 'The interviewer couldn’t answer just now.', code: 'upstream', status: 502, retryAfter: null });
      }
    }
  });
};
