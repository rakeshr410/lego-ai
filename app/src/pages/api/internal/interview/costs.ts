import type { APIRoute } from 'astro';
import { env } from '../../../../lib/server/env';
import { json } from '../../../../lib/server/http';
import { costsCsv, renderCosts, sessionCosts } from '../../../../lib/server/interview/session-costs';
import { allSessions } from '../../../../lib/server/interview/sessions';
import { bearerMatches } from '../../../../lib/server/interview/voice-token';

export const prerender = false;

// What each session cost, by service, and each person's total (scripts/session-costs.ts --url, and lego-admin's
// pages). Reached only on the private network with `Authorization: Bearer LEGO_AI_SECRET` or LEGO_ADMIN_SECRET;
// anything else is a 404.
//
//   GET ?days=30&reader=<id>&format=text|csv|json&detail=1   (or ?from=<date>&to=<date> for a period)

const READER = /^[a-z0-9]{1,40}$/i;

export const GET: APIRoute = async ({ request, url }) => {
  const auth = request.headers.get('authorization');
  if (!bearerMatches(env('LEGO_AI_SECRET') ?? null, auth) && !bearerMatches(env('LEGO_ADMIN_SECRET') ?? null, auth)) return json({ error: 'Not found' }, 404);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const reader = url.searchParams.get('reader') ?? '';
  if (reader && !READER.test(reader)) return json({ error: 'reader is an id' }, 400);
  try {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) return json({ error: 'from and to are dates.' }, 400);
    const since = from ? new Date(from).toISOString() : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const until = to ? new Date(to).toISOString() : null;
    const report = sessionCosts((await allSessions()).filter((s) => !until || s.startedAt < until), { since, reader: reader || undefined });
    const format = url.searchParams.get('format');
    if (format === 'json') return json(report);
    const body = format === 'csv' ? costsCsv(report.sessions) : renderCosts(report, { detail: url.searchParams.get('detail') === '1' });
    return new Response(`${body}\n`, { headers: { 'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('[interview] costs:', err instanceof Error ? err.message : err);
    return json({ error: 'The interview store is unavailable right now.', code: 'unavailable' }, 503, { 'Retry-After': '5' });
  }
};
