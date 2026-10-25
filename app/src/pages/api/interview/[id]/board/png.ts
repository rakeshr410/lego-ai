import type { APIRoute } from 'astro';
import { readerOr503 } from '../../../../../lib/server/ask-http';
import { BodyTooLarge, isSameOrigin, json, tooMany } from '../../../../../lib/server/http';
import { PNG_MAX_BYTES } from '../../../../../lib/server/interview/board';
import { handle, interviewOff } from '../../../../../lib/server/interview/http';
import { saveSessionBoardPng } from '../../../../../lib/server/interview/service';
import { ID_PATTERN } from '../../../../../lib/server/interview/sessions';
import { rateLimit } from '../../../../../lib/server/rate-limit';

export const prerender = false;

// A PNG of the board, rendered by the room (design section 7; the server has no renderer). Body:
// the image (image/png), at most PNG_MAX_BYTES; ?stage=<key>&version=<n>. Once per stage at the
// stage change, at most PNG_MAX_PER_SESSION per session, for the final grader; or ?stage=current,
// overwritten, when the board is mostly freehand, for the vision fallback.

export const POST: APIRoute = async ({ request, url, params, cookies }) => {
  const off = interviewOff();
  if (off) return off;
  if (!isSameOrigin(request, url)) return json({ error: 'Forbidden' }, 403);
  const id = params.id ?? '';
  if (!ID_PATTERN.test(id)) return json({ error: 'Unknown session' }, 404);
  const stage = url.searchParams.get('stage') ?? '';
  if (!/^[a-z0-9-]{1,40}$/.test(stage)) return json({ error: 'Unknown stage', code: 'invalid' }, 400);
  const version = Number(url.searchParams.get('version'));
  if (!Number.isInteger(version) || version < 0) return json({ error: 'Which board version?', code: 'invalid' }, 400);
  const reader = await readerOr503(cookies);
  if (reader instanceof Response) return reader;
  if (!reader) return json({ error: 'Sign in to continue your mock interview.' }, 401);
  const limit = await rateLimit(`interview:board-png:${id}`, 12, 60_000, { failOpen: false });
  if (!limit.ok) return tooMany(limit.retryAfter, 'Too many board images. Give it a moment.');
  if (!request.headers.get('content-type')?.includes('image/png')) return json({ error: 'Send the board as image/png.', code: 'invalid' }, 400);
  let png: Buffer;
  try {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > PNG_MAX_BYTES) throw new BodyTooLarge();
    png = Buffer.from(await request.arrayBuffer());
    if (png.byteLength > PNG_MAX_BYTES) throw new BodyTooLarge();
  } catch {
    return json({ error: `A board image is at most ${PNG_MAX_BYTES / 1024} KB.`, code: 'invalid' }, 413);
  }
  return handle('board-png', async () => json(await saveSessionBoardPng(reader.documentId, id, stage, png, version)));
};
