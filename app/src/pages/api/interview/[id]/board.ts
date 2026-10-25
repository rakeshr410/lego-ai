import type { APIRoute } from 'astro';
import { readerOr503 } from '../../../../lib/server/ask-http';
import { isSameOrigin, json, readJson, tooMany } from '../../../../lib/server/http';
import { BOARD_MAX_BYTES } from '../../../../lib/server/interview/board';
import { handle, interviewOff } from '../../../../lib/server/interview/http';
import { saveSessionBoard } from '../../../../lib/server/interview/service';
import { ID_PATTERN } from '../../../../lib/server/interview/sessions';
import { rateLimit } from '../../../../lib/server/rate-limit';

export const prerender = false;

// The session's whiteboard (design section 7). The room posts the compacted scene when it settles
// (at most one save per 5 s), with the version it built on; the server serialises it and answers
// only {version, fingerprint}: the matcher's coverage never leaves the server.
//
//   POST {baseVersion, fingerprint, elements}   the next version; 409 with the server's scene
//                                               {version, fingerprint, elements} when baseVersion
//                                               is stale (two tabs); 400 on a bad scene
//   POST {version, fingerprint}                 the room's parting beacon: acknowledged, nothing saved

export const POST: APIRoute = async ({ request, url, params, cookies }) => {
  const off = interviewOff();
  if (off) return off;
  if (!isSameOrigin(request, url)) return json({ error: 'Forbidden' }, 403);
  const id = params.id ?? '';
  if (!ID_PATTERN.test(id)) return json({ error: 'Unknown session' }, 404);
  const reader = await readerOr503(cookies);
  if (reader instanceof Response) return reader;
  if (!reader) return json({ error: 'Sign in to continue your mock interview.' }, 401);
  // One save per 5 s per session, with room for the beacon and a retry after a conflict.
  const limit = await rateLimit(`interview:board:${id}`, 20, 60_000, { failOpen: false });
  if (!limit.ok) return tooMany(limit.retryAfter, 'The board is saving too often. Give it a moment.');
  const body = await readJson(request, BOARD_MAX_BYTES);
  if (!body) return json({ error: 'Send the board as JSON.', code: 'invalid' }, 400);
  return handle('board', async () => json(await saveSessionBoard(reader.documentId, id, body)));
};
