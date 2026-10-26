import type { APIRoute } from 'astro';
import { env } from '../../../../../lib/server/env';
import { json } from '../../../../../lib/server/http';
import { bearerMatches } from '../../../../../lib/server/interview/voice-token';
import { exportReaderProgress, exportReaderSessions, purgeReaderSessions } from '../../../../../lib/server/interview/service';

export const prerender = false;

// The main site's side of a reader's account (lego/web/src/lib/server/account.ts): their mock
// interview sessions, which live in this app's store. Reached only on the private network with
// `Authorization: Bearer LEGO_AI_SECRET`; anything else is a 404. Answers whether or not the
// interview is in this build (PUBLIC_INTERVIEW_ENABLED), so an account is always deleted whole.
//
//   GET     {sessions: [...], coaching: {<playlist>: ...}}
//                               the reader's sessions and their progress through the coaching
//                               playlists (docs/coaching.md), for the account export
//   DELETE  204                 deletes all of it (account deletion)
//
// `reader` is the Strapi user's documentId.

const READER = /^[a-z0-9]{10,40}$/;

function guard(request: Request, reader: string | undefined): Response | string {
  if (!bearerMatches(env('LEGO_AI_SECRET') ?? null, request.headers.get('authorization'))) return json({ error: 'Not found' }, 404);
  if (!reader || !READER.test(reader)) return json({ error: 'Not found' }, 404);
  return reader;
}

async function run(what: string, body: () => Promise<Response>): Promise<Response> {
  try {
    return await body();
  } catch (err) {
    console.error(`[interview] account ${what}:`, err instanceof Error ? err.message : err);
    return json({ error: 'The interview store is unavailable right now.', code: 'unavailable' }, 503, { 'Retry-After': '5' });
  }
}

export const GET: APIRoute = async ({ request, params }) => {
  const reader = guard(request, params.reader);
  if (reader instanceof Response) return reader;
  return run('export', async () => {
    const [sessions, coaching] = await Promise.all([exportReaderSessions(reader), exportReaderProgress(reader)]);
    return json({ sessions, coaching });
  });
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const reader = guard(request, params.reader);
  if (reader instanceof Response) return reader;
  return run('delete', async () => {
    await purgeReaderSessions(reader);
    return new Response(null, { status: 204 });
  });
};
