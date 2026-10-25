import type { AstroCookies } from 'astro';
import { FLAGS } from '../sd';
import { within } from './deadline';
import { json } from './http';
import t from '../../i18n/messages/api';
import { AskError } from './llm-gateway';
import { getReader, type Reader } from './session';

// Response helpers shared by the Ask routes.

/**
 * With the build's Ask flag off (PUBLIC_ASK_ENABLED, until a later release) the Ask API does not
 * exist, whatever ASK_ENABLED or the store's switch say: a 404, like any unknown route, before
 * anything else is read or checked.
 */
export const askOff = () => (FLAGS.ask ? null : json({ error: 'Not found' }, 404));

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ID = /^[a-z0-9]{10,40}$/;

/** A 503 for when the CMS or the store can't be reached. */
export function unavailable(what: string, err: unknown): Response {
  console.error(`[ask] ${what}:`, (err as Error).message);
  return json({ error: t('notes.unavailable'), code: 'unavailable' }, 503, { 'Retry-After': '30' });
}

/**
 * The signed-in reader, null when signed out, or a 503 when sessions can't be checked. With
 * `left` (a request budget's time remaining), a 503 too when they can't be checked in time; a
 * recently verified reader is still answered from the store (session.ts, getReader's waitMs).
 */
export async function readerOr503(cookies: AstroCookies, left?: () => number): Promise<Reader | null | Response> {
  try {
    return left ? await within(getReader(cookies, { waitMs: left() / 2 }), left(), 'the session check') : await getReader(cookies);
  } catch (err) {
    return unavailable('could not check the session', err);
  }
}

/** What the reader is told about an AskError (the body of its response or stream event). */
export const askErrorBody = (err: AskError) => ({
  error: err.message,
  code: err.code,
  status: err.status,
  retryAfter: err.retryAfter ?? null,
  resetsAt: err.resetsAt ?? null,
});

/** An AskError as JSON, with Retry-After when there is one. */
export function askErrorResponse(err: AskError): Response {
  const headers: Record<string, string> = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
  return json(askErrorBody(err), err.status, headers);
}

// ---------------------------------------------------------------------------------------
// Server-sent events

/** How often an open stream sends a comment, so proxies don't close it while Claude thinks. */
export const SSE_PING_MS = 15_000;

export type SseSend = (event: string, data: unknown) => void;

/**
 * A text/event-stream response that runs `produce`, which sends events with `send`. The signal
 * passed to produce aborts when the client goes away (the request's signal, or the response
 * stream being cancelled, whichever the server notices first) so upstream work stops with it.
 * Events sent after the client has gone are dropped.
 */
export function sseResponse(request: Request, produce: (send: SseSend, signal: AbortSignal) => Promise<void>): Response {
  const gone = new AbortController();
  const leave = () => gone.abort();
  request.signal.addEventListener('abort', leave, { once: true });
  const enc = new TextEncoder();
  let ping: ReturnType<typeof setInterval> | undefined;
  let open = true;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (!open || gone.signal.aborted) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          open = false;
        }
      };
      const send: SseSend = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      ping = setInterval(() => write(': ping\n\n'), SSE_PING_MS);
      write(': open\n\n');
      try {
        await produce(send, gone.signal);
      } finally {
        clearInterval(ping);
        request.signal.removeEventListener('abort', leave);
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            /* already closed by the client */
          }
        }
      }
    },
    cancel() {
      open = false;
      clearInterval(ping);
      gone.abort();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform: a compressing proxy would buffer the stream.
      'Cache-Control': 'private, no-store, no-transform',
      // nginx and similar proxies buffer responses unless told not to.
      'X-Accel-Buffering': 'no',
    },
  });
}

/** Whether the client asked for the answer as a stream of server-sent events. */
export const wantsStream = (request: Request) => (request.headers.get('accept') ?? '').includes('text/event-stream');
