import type { APIRoute } from 'astro';
import { readerOr503 } from '../../../../lib/server/ask-http';
import { isSameOrigin, json, readJson, tooMany } from '../../../../lib/server/http';
import { handle, interviewOff } from '../../../../lib/server/interview/http';
import { ID_PATTERN } from '../../../../lib/server/interview/sessions';
import { joinVoice, leaveVoice } from '../../../../lib/server/interview/voice';
import { rateLimit } from '../../../../lib/server/rate-limit';

export const prerender = false;

// The voice part of a voice session (design section 6), for the room.
//
//   POST {action: "join"}    a meeting token for the session's Daily room (and a pipeline if none
//                            holds the session: after a reload, a dropped line, a deploy):
//                            {session, join: {url, token, expiresAt}}
//   POST {action: "leave"}   ends the voice part; the session goes on in text until the feedback

export const POST: APIRoute = async ({ request, url, params, cookies }) => {
  const off = interviewOff();
  if (off) return off;
  if (!isSameOrigin(request, url)) return json({ error: 'Forbidden' }, 403);
  const id = params.id ?? '';
  if (!ID_PATTERN.test(id)) return json({ error: 'Unknown session' }, 404);
  const reader = await readerOr503(cookies);
  if (reader instanceof Response) return reader;
  if (!reader) return json({ error: 'Sign in to continue your mock interview.' }, 401);
  const limit = await rateLimit(`interview:voice-room:${reader.id}`, 20, 60_000, { failOpen: false });
  if (!limit.ok) return tooMany(limit.retryAfter, 'Too many attempts. Give it a minute.');
  const body = await readJson(request, 4 * 1024);
  const action = body?.action;
  if (action === 'join') return handle('voice join', async () => json(await joinVoice(reader.documentId, id)));
  if (action === 'leave') return handle('voice leave', async () => json({ session: await leaveVoice(reader.documentId, id) }));
  return json({ error: 'Unknown action' }, 400);
};
