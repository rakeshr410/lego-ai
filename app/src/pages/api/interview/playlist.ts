import type { APIRoute } from "astro";
import { readerOr503 } from "../../../lib/server/ask-http";
import { clientIp, json, tooMany } from "../../../lib/server/http";
import { handle, interviewOff } from "../../../lib/server/interview/http";
import { playlistStatus } from "../../../lib/server/interview/service";
import { rateLimit } from "../../../lib/server/rate-limit";

export const prerender = false;

// GET /api/interview/playlist?slug=<playlist>: where the signed-in reader is in a playlist, for its page's start
// card (components/sd/PlaylistView.tsx): {signedIn, current: {lesson, minutes} | null, finished: [lesson slugs]}.

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const GET: APIRoute = async (ctx) => {
  const off = interviewOff();
  if (off) return off;
  const slug = ctx.url.searchParams.get("slug") ?? "";
  if (!SLUG.test(slug)) return json({ error: "Unknown playlist" }, 400);
  const reader = await readerOr503(ctx.cookies);
  if (reader instanceof Response) return reader;
  const limit = await rateLimit(
    `interview:get:${reader?.documentId ?? clientIp(ctx)}`,
    120,
    60_000,
  );
  if (!limit.ok)
    return tooMany(limit.retryAfter, "Too many requests. Give it a minute.");
  if (!reader) return json({ signedIn: false, current: null, finished: [] });
  return handle("playlist", async () =>
    json({
      signedIn: true,
      ...(await playlistStatus(reader.documentId, slug)),
    }),
  );
};
