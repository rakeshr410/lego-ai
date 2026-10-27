import { env } from './env';

// The credit ledger (lego-ledger, its own service): what each reader holds and spends. This app opens a
// meter when a session starts and charges it by the minute as the session runs; lego sells the credits.
// Without LEDGER_URL and LEDGER_SECRET (a dev server on its own) the ledger is off, and sessions count
// against the month's allowance as before.

const TIMEOUT_MS = 4_000;

export type CreditBalance = { plan: string; monthly: number; paid: number; total: number; period: string; expiresAt: string };
export type CreditMeter = { sessionId: string; rate: number; seconds: number; charged: number; short: number; status: 'open' | 'closed' };
export type MeterResult = { meter: CreditMeter; balance: CreditBalance; secondsLeft: number };
/** What the room shows before a start: the balance, each mode's rate a minute and the least a session costs. */
export type Credits = { balance: CreditBalance; rates: Record<string, number>; minMinutes: number };

export class LedgerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;
  constructor(status: number, code: string, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export const ledgerOn = (): boolean => !!(env('LEDGER_URL') && env('LEDGER_SECRET'));

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const url = env('LEDGER_URL');
  const secret = env('LEDGER_SECRET');
  if (!url || !secret) throw new LedgerError(503, 'off', 'The ledger is not configured.');
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { authorization: `Bearer ${secret}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new LedgerError(503, 'unavailable', `The ledger did not answer: ${(err as Error).message}`);
  }
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new LedgerError(res.status, typeof out.code === 'string' ? out.code : 'unavailable', typeof out.error === 'string' ? out.error : `The ledger answered ${res.status}.`, out);
  return out as T;
}

/** The product a session is priced as: a coach lesson, a drill (a topic or section), or a whole mock interview. */
export const productOf = (s: { kind?: string; scope?: unknown }) => (s.kind === 'coach' ? 'coach' : s.scope ? 'drill' : 'interview');

export const creditsOf = (readerId: string, plan: string): Promise<Credits> => call('GET', `/v1/readers/${encodeURIComponent(readerId)}?plan=${encodeURIComponent(plan)}`);

/** `label`: what the session is (a lesson's title, or the system's name), for the reader's usage page on lego. */
export const openMeter = (p: { sessionId: string; readerId: string; plan: string; product: string; mode: string; label?: string }): Promise<MeterResult> => call('POST', '/v1/meters', p);

export const chargeMeter = (sessionId: string, p: { seconds: number; close?: boolean; waive?: boolean }): Promise<MeterResult> =>
  call('POST', `/v1/meters/${encodeURIComponent(sessionId)}`, { seconds: Math.max(0, Math.round(p.seconds * 10) / 10), ...(p.close ? { close: true } : {}), ...(p.waive ? { waive: true } : {}) });
