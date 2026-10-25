import { FLAGS } from '../../sd';
import { json } from '../http';
import { InterviewError } from './service';

// Response helpers for the interview routes (pages/api/interview/).

/** The body of an InterviewError's response or stream event. */
export const interviewErrorBody = (err: InterviewError) => ({
  error: err.message,
  code: err.code,
  status: err.status,
  retryAfter: err.retryAfter ?? null,
  ...err.detail,
});

export function interviewErrorResponse(err: InterviewError): Response {
  return json(interviewErrorBody(err), err.status, err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {});
}

/**
 * With the build's interview flag off (PUBLIC_INTERVIEW_ENABLED) the API does not exist: a 404,
 * like any unknown route, so nothing about the unreleased feature is exposed.
 */
export const interviewOff = () => (FLAGS.interview ? null : json({ error: 'Not found' }, 404));

/** Runs a route body, turning an InterviewError into its response and anything else into a 503. */
export async function handle(what: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof InterviewError) return interviewErrorResponse(err);
    console.error(`[interview] ${what}:`, err instanceof Error ? err.message : err);
    return json({ error: 'Mock interviews are unavailable right now. Try again in a moment.', code: 'unavailable' }, 503, { 'Retry-After': '30' });
  }
}
