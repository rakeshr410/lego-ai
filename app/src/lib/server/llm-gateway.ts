import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { env, isProduction, serverEnv, type ServerEnv } from './env';
import { entitlementsFor, type Plan } from './entitlements';
import { backoffMs, RetryBudget, sleep } from './retry';
import { Semaphore } from './semaphore';
import { getStore, type Store } from './store';
import t from '../../i18n/messages/api';
import { FLAGS } from '../sd';

// Every Anthropic call goes through here. In order, a call must pass:
//   1. the kill switch: store flag 'ask:enabled' ('on' / 'off', set by scripts/ask-switch.mjs),
//      falling back to ASK_ENABLED; auth and billing errors from Anthropic turn it off;
//   2. the global daily dollar breaker (ASK_DAILY_BUDGET_USD, estimated from each response's usage,
//      or conservatively from the request when a call may have been billed but returned no usage);
//   3. the reader's daily quota (per UTC day, by plan: entitlements.ts);
//   4. a per-process concurrency limit (ASK_MAX_CONCURRENCY) with a short queue;
// then runs with a timeout (ASK_TIMEOUT_MS, the whole call including a streamed answer and any
// retries), bounded retries with jitter for brief overload (ASK_MAX_RETRIES, see "Retries") and
// the request's AbortSignal, and writes one JSON usage line per call (with its
// cache-read ratio; a falling ratio over recent calls raises an alert). Calls either return the
// whole message (createMessage) or stream its text as it is written (streamMessage); both are
// metered from the final message. Quota and spend live in the shared store and fail closed:
// when the store is down, Ask is unavailable rather than unmetered.
//
// Callers other than Ask (the mock interview, P3-11) pass a Lane: their own model, token cap and
// effort, and their own allowance in place of step 3. Steps 1, 2 and 4 apply to every lane: the
// kill switch and the daily dollar breaker cover the whole Anthropic account.

export type ModelPrice = {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  /** Supports output_config.effort. */
  effort: boolean;
  /** Runs the safety classifiers that server-side fallbacks rescue. */
  fallbacks: boolean;
};

/** Models Ask may use, with first-party prices. Cache writes (5-minute TTL) cost 1.25x input. */
export const MODELS: Record<string, ModelPrice> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, effort: true, fallbacks: true },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, effort: true, fallbacks: true },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, effort: true, fallbacks: false },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, effort: true, fallbacks: false },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, effort: false, fallbacks: false },
  // Prompts up to 100K tokens ($0.50 / $2.50 beyond, which agent-lab requests never reach); cache read at the usual 0.1x input.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, effort: true, fallbacks: false },
};
export const DEFAULT_MODEL = 'claude-opus-5';
const CACHE_WRITE = 1.25;

// ---------------------------------------------------------------------------------------
// Provider. Claude is served by Anthropic's API, or by Amazon Bedrock (LLM_PROVIDER=bedrock) from
// BEDROCK_REGION, which puts the model's first token on the same continent as the voice room
// (docs/interview/README.md, "Latency"). Bedrock's Messages endpoint takes the same request with
// three differences handled here: its own model ids (a geo inference profile such as
// `in.anthropic.claude-sonnet-5` keeps inference in India; `global.` routes anywhere), explicit cache
// breakpoints only (no top-level cache_control), and no server-side fallbacks. The bearer token
// (a Bedrock API key) goes where the Anthropic key would.

export type Provider = { kind: 'anthropic' } | { kind: 'bedrock'; region: string; geo: string; endpoint: 'runtime' | 'mantle'; token: string | undefined; modelIds: Record<string, string> };

/** The geo inference profiles Bedrock offers per model (the AWS model cards, 2026-10-24); `global` always exists. */
const BEDROCK_GEOS: Record<string, readonly string[]> = {
  'claude-opus-5': ['us', 'eu', 'in'],
  'claude-opus-5-5': ['us', 'eu'],
  'claude-opus-4-8': ['us', 'eu'],
  'claude-sonnet-5': ['us', 'eu', 'jp', 'in'],
  'claude-haiku-4-5': ['us', 'eu', 'in'],
  'claude-haiku-5-5': ['us', 'eu', 'au', 'jp'],
};

/** The geo profile prefix that keeps inference near `region`. */
export function geoOf(region: string): string {
  if (region.startsWith('us-') || region.startsWith('ca-')) return 'us';
  if (region.startsWith('eu-')) return 'eu';
  if (region.startsWith('ap-south-')) return 'in';
  if (region === 'ap-northeast-1' || region === 'ap-northeast-3') return 'jp';
  if (region === 'ap-southeast-2' || region === 'ap-southeast-4') return 'au';
  return 'global';
}

/** `claude-haiku-5-5=global.anthropic.claude-haiku-5-5,…` as a map. */
export function parseModelIds(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const [k, v] = pair.split('=').map((x) => x.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

export function provider(): Provider {
  const s = serverEnv();
  if (s.LLM_PROVIDER !== 'bedrock') return { kind: 'anthropic' };
  const region = s.BEDROCK_REGION ?? 'ap-south-1';
  return {
    kind: 'bedrock',
    region,
    geo: s.BEDROCK_GEO ?? geoOf(region),
    endpoint: s.BEDROCK_ENDPOINT,
    token: env('BEDROCK_API_KEY') ?? process.env.AWS_BEARER_TOKEN_BEDROCK?.trim() ?? undefined,
    modelIds: parseModelIds(s.BEDROCK_MODEL_IDS),
  };
}

type Bedrock = Extract<Provider, { kind: 'bedrock' }>;

export function bedrockBaseUrl(p: Bedrock): string {
  return p.endpoint === 'mantle' ? `https://bedrock-mantle.${p.region}.api.aws/anthropic` : `https://bedrock-runtime.${p.region}.amazonaws.com/anthropic`;
}

/**
 * The id Bedrock knows `model` by: BEDROCK_MODEL_IDS when it names it, else the region's geo profile
 * when the model has one there, else the global profile (the mantle endpoint takes the bare id and
 * routes by region itself).
 */
export function bedrockModelId(model: string, p: Bedrock): string {
  const explicit = p.modelIds[model];
  if (explicit) return explicit;
  if (p.endpoint === 'mantle') return `anthropic.${model}`;
  const geo = p.geo !== 'global' && (BEDROCK_GEOS[model] ?? []).includes(p.geo) ? p.geo : 'global';
  return `${geo}.anthropic.${model}`;
}

/** The model behind a served id (`in.anthropic.claude-sonnet-5` is `claude-sonnet-5`), so it is priced. */
export function canonicalModel(served: string): string {
  return served.replace(/^(?:[a-z]{2}|global|apac)\.anthropic\.|^anthropic\./, '');
}

/** Bedrock's regional (geo) profiles cost a tenth more than the global one and Anthropic's own prices. */
export function pricePremium(p: Provider): number {
  return p.kind === 'bedrock' && p.endpoint === 'runtime' && p.geo !== 'global' ? 1.1 : 1;
}

/** Whether the configured provider has credentials to call with. */
export function hasCredentials(p = provider()): boolean {
  return p.kind === 'bedrock' ? !!p.token : !!env('ANTHROPIC_API_KEY');
}
// Unknown served models (e.g. a server-side fallback) are priced at the most expensive known rate.
const MAX_PRICE: ModelPrice = { input: 10, output: 50, cacheRead: 1, effort: false, fallbacks: false };

type Effort = ServerEnv['ASK_EFFORT'];

// ---------------------------------------------------------------------------------------
// Settings, read per call so an env change takes effect on restart without a rebuild. Their
// types, defaults and ranges are declared in env.ts (SETTINGS).

let warnedModel = '';

/** `model` when the gateway knows its price, else DEFAULT_MODEL (logged once per unknown name). */
export function knownModel(model: string | undefined, setting = 'ASK_MODEL'): string {
  if (!model) return DEFAULT_MODEL;
  if (MODELS[model]) return model;
  if (warnedModel !== model) {
    warnedModel = model;
    console.error(`[ask] ${setting}=${model} is not a known model (${Object.keys(MODELS).join(', ')}); using ${DEFAULT_MODEL}.`);
  }
  return DEFAULT_MODEL;
}

export function config() {
  const s = serverEnv();
  const model = knownModel(s.ASK_MODEL);
  const effort: Effort = s.ASK_EFFORT;
  return {
    enabledByEnv: s.ASK_ENABLED,
    model,
    effort,
    maxTokens: s.ASK_MAX_TOKENS,
    dailyQuota: s.ASK_DAILY_QUOTA,
    dailyBudgetUsd: s.ASK_DAILY_BUDGET_USD,
    maxConcurrency: s.ASK_MAX_CONCURRENCY,
    queueMs: s.ASK_QUEUE_MS,
    timeoutMs: s.ASK_TIMEOUT_MS,
    maxRetries: s.ASK_MAX_RETRIES,
    retryMaxWaitMs: s.ASK_RETRY_MAX_WAIT_MS,
    cacheReadAlert: s.ASK_CACHE_READ_ALERT,
  };
}

// ---------------------------------------------------------------------------------------
// Plans. The reader's plan comes from their session (entitlements.ts decides what it allows);
// a caller that doesn't pass one gets the free allowance.

export type { Plan } from './entitlements';
const quotaFor = (plan: Plan) => entitlementsFor(plan).askDailyQuota;

// ---------------------------------------------------------------------------------------
// Errors

export type AskErrorCode =
  | 'disabled'
  | 'budget'
  | 'quota'
  | 'busy'
  | 'timeout'
  | 'aborted'
  | 'unavailable'
  | 'upstream';

/** Why Ask couldn't answer. `status` and `retryAfter` (seconds) go straight to the HTTP response. */
export class AskError extends Error {
  constructor(
    readonly code: AskErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
    readonly resetsAt?: string,
  ) {
    super(message);
  }
}

// What the reader is told, per code (i18n/messages/api.ts).
const MESSAGES = {
  disabled: 'ask.disabled',
  budget: 'ask.budget',
  quota: 'ask.quota',
  busy: 'ask.busy',
  timeout: 'ask.timeout',
  aborted: 'ask.aborted',
  unavailable: 'ask.unavailable',
  upstream: 'ask.failed',
} as const satisfies Record<AskErrorCode, keyof typeof t.source>;

const fail = (code: AskErrorCode, status: number, retryAfter?: number, resetsAt?: string) =>
  new AskError(code, status, t(MESSAGES[code]), retryAfter, resetsAt);

// ---------------------------------------------------------------------------------------
// Days, keys and store helpers

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const nextUtcMidnight = (now = Date.now()) => new Date(Math.floor(now / DAY_MS + 1) * DAY_MS).toISOString();
const secondsUntil = (iso: string) => Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 1000));

export const SWITCH_KEY = 'ask:enabled';
export const SWITCH_REASON_KEY = 'ask:enabled:reason';
const quotaKey = (readerId: string, day = utcDay()) => `ask:quota:${readerId}:${day}`;
export const spendKey = (day = utcDay()) => `ask:spend:${day}`;
const YEAR_MS = 365 * DAY_MS;

/** Adds `delta` to an integer counter with compare-and-set (never below 0; used for quota refunds). */
async function addTo(store: Store, key: string, delta: number, ttlMs: number): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const raw = await store.get(key);
    const next = Math.max(0, (Number(raw) || 0) + delta);
    const ok = raw === null ? await store.setNx(key, String(next), ttlMs) : await store.cas(key, raw, String(next), ttlMs);
    if (ok) return next;
  }
  throw new Error(`could not update ${key.split(':').slice(0, 2).join(':')} (contention)`);
}

// ---------------------------------------------------------------------------------------
// Kill switch

const SWITCH_CACHE_MS = 5_000;
let switchCache: { at: number; on: boolean } | null = null;

/** Whether Ask is on: the store flag when set, otherwise ASK_ENABLED. Cached for 5 seconds. */
export async function isEnabled(): Promise<boolean> {
  if (switchCache && Date.now() - switchCache.at < SWITCH_CACHE_MS) return switchCache.on;
  const flag = await (await getStore()).get(SWITCH_KEY);
  const on = flag === 'on' ? true : flag === 'off' ? false : config().enabledByEnv;
  switchCache = { at: Date.now(), on };
  return on;
}

/** Turns Ask off everywhere until someone turns it back on (scripts/ask-switch.mjs on). */
export async function tripSwitch(reason: string) {
  switchCache = { at: Date.now(), on: false };
  console.error(JSON.stringify({ level: 'alert', event: 'ask_kill_switch_tripped', reason, at: new Date().toISOString() }));
  try {
    const store = await getStore();
    await store.set(SWITCH_KEY, 'off', YEAR_MS);
    await store.set(SWITCH_REASON_KEY, `${new Date().toISOString()} auto: ${reason}`, YEAR_MS);
  } catch (err) {
    console.error('[ask] could not store the kill switch:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------------------
// Status and admission

export type AskStatus = {
  enabled: boolean;
  /** Why Ask is off: paused by an operator or by an error, the daily budget, or the store is down. */
  reason?: 'disabled' | 'budget' | 'unavailable';
  limit: number;
  remaining: number;
  /** When today's quota and budget reset (next UTC midnight). */
  resetsAt: string;
};

const budgetMicros = () => Math.round(config().dailyBudgetUsd * 1e6);
const spentMicros = async (store: Store) => Number(await store.get(spendKey())) || 0;

const limitFor = (plan: Plan) => quotaFor(plan);

/** Ask's state when it can't be checked (the store is down or too slow): off, nothing left. */
export function unavailableStatus(_readerId: string | null, plan: Plan = 'free'): AskStatus {
  return { enabled: false, reason: 'unavailable', limit: limitFor(plan), remaining: 0, resetsAt: nextUtcMidnight() };
}

/** Ask's state for a reader on `plan` (or for anyone, with null), without counting anything. */
export async function askStatus(readerId: string | null, plan: Plan = 'free'): Promise<AskStatus> {
  const resetsAt = nextUtcMidnight();
  const limit = limitFor(plan);
  try {
    const store = await getStore();
    const used = readerId ? Number(await store.get(quotaKey(readerId))) || 0 : 0;
    const remaining = Math.max(0, limit - used);
    if (!(await isEnabled())) return { enabled: false, reason: 'disabled', limit, remaining, resetsAt };
    if ((await spentMicros(store)) >= budgetMicros()) return { enabled: false, reason: 'budget', limit, remaining, resetsAt };
    if (isProduction() && !hasCredentials()) return { enabled: false, reason: 'unavailable', limit, remaining, resetsAt };
    return { enabled: true, limit, remaining, resetsAt };
  } catch (err) {
    console.error('[ask] status unavailable:', (err as Error).message);
    return unavailableStatus(readerId, plan);
  }
}

/** Throws the AskError a call would get right now (switch, budget, quota), without counting. */
export async function checkAdmission(readerId: string, plan: Plan = 'free') {
  const s = await askStatus(readerId, plan);
  if (!s.enabled) throw fail(s.reason ?? 'unavailable', 503, s.reason === 'budget' ? secondsUntil(s.resetsAt) : 300, s.resetsAt);
  if (s.remaining <= 0) throw fail('quota', 429, secondsUntil(s.resetsAt), s.resetsAt);
}

/**
 * Throws when no call of any lane may go out right now: the kill switch is off, the global daily
 * budget is spent, the store is down, or production has no API key. Counts nothing.
 */
export async function checkGateway() {
  const s = await askStatus(null);
  if (!s.enabled) throw fail(s.reason ?? 'unavailable', 503, s.reason === 'budget' ? secondsUntil(s.resetsAt) : 300, s.resetsAt);
}

/** One call counted against an allowance; refunded when nothing was billed. */
export type Reservation = { refund(): Promise<void> };

/** Counts one question against the reader's quota, or throws. Refund it if nothing was billed. */
async function reserve(readerId: string, plan: Plan): Promise<Reservation> {
  await checkAdmission(readerId, plan);
  const resetsAt = nextUtcMidnight();
  const key = quotaKey(readerId);
  let used: number;
  try {
    used = await (await getStore()).incr(key, 2 * DAY_MS);
  } catch (err) {
    console.error('[ask] quota store unavailable:', (err as Error).message);
    throw fail('unavailable', 503, 60);
  }
  if (used > quotaFor(plan)) throw fail('quota', 429, secondsUntil(resetsAt), resetsAt);
  let refunded = false;
  return {
    async refund() {
      if (refunded) return;
      refunded = true;
      await addTo(await getStore(), key, -1, 2 * DAY_MS).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------------------
// Concurrency: a per-process semaphore with a short, bounded queue.

const slots = new Semaphore(
  () => config().maxConcurrency,
  () => config().maxConcurrency * 4,
  { busy: () => fail('busy', 503, 5), aborted: () => fail('aborted', 499) },
);

// ---------------------------------------------------------------------------------------
// Anthropic client

let client: Anthropic | null = null;
let clientKey: string | undefined;

/** The provider's endpoint and credential, as one string: a change makes a new client. */
function clientIdentity(p: Provider): { apiKey: string | undefined; baseURL: string | undefined; key: string } {
  const apiKey = p.kind === 'bedrock' ? p.token : env('ANTHROPIC_API_KEY');
  const baseURL = p.kind === 'bedrock' ? bedrockBaseUrl(p) : undefined;
  return { apiKey, baseURL, key: `${baseURL ?? ''}|${apiKey ?? ''}` };
}

function anthropic(timeoutMs: number): Anthropic {
  const { apiKey, baseURL, key } = clientIdentity(provider());
  // Production needs an explicit key; in dev the SDK may fall back to its own credentials.
  if (!apiKey && isProduction()) throw fail('unavailable', 503, 300);
  if (!client || clientKey !== key) {
    // Retries are the gateway's own (below), not the SDK's: see "Retries".
    client = new Anthropic({ apiKey: apiKey || undefined, baseURL, maxRetries: 0, timeout: timeoutMs });
    clientKey = key;
  }
  return client;
}

/** Replaces the Anthropic client (tests only). */
export function setAnthropicClient(c: Anthropic | null) {
  client = c;
  clientKey = c ? clientIdentity(provider()).key : undefined;
}

/**
 * The Messages namespace a call goes through: the beta one on Anthropic's API (server-side
 * fallbacks are a beta), the plain one on Bedrock, whose endpoint is the GA Messages API (the
 * request's effort and caching are GA there; nothing in it needs the beta query).
 */
function messagesOf(c: Anthropic, p: Provider): Anthropic['beta']['messages'] {
  return p.kind === 'bedrock' ? (c.messages as unknown as Anthropic['beta']['messages']) : c.beta.messages;
}

/** The request as Bedrock takes it: its model id, explicit cache breakpoints only, no server-side fallbacks. */
export function forBedrock<B extends { model: string }>(body: B, p: Bedrock): B {
  const out = { ...body } as Record<string, unknown>;
  delete out.betas;
  delete out.fallbacks;
  delete out.cache_control;
  out.model = bedrockModelId(body.model, p);
  return out as unknown as B;
}

// ---------------------------------------------------------------------------------------
// Cost

type UsageLike = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** Estimated USD for one usage record on `model`. */
export function costOf(model: string, u: UsageLike): number {
  const p = MODELS[model] ?? MAX_PRICE;
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.cache_creation_input_tokens ?? 0) * p.input * CACHE_WRITE +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.output_tokens ?? 0) * p.output) /
    1e6
  );
}

type Iteration = UsageLike & { type?: string; model?: string };

/** Cost of a response: per iteration when present (a declined hop plus its fallback), else total. */
export function responseCost(requested: string, msg: Pick<Anthropic.Beta.BetaMessage, 'model' | 'usage'>): number {
  const its = (msg.usage as { iterations?: Iteration[] | null }).iterations;
  if (its?.length) return its.reduce((sum, it) => sum + costOf(it.type === 'fallback_message' && it.model ? it.model : requested, it), 0);
  return costOf(canonicalModel(msg.model || requested), msg.usage);
}

const CHARS_PER_TOKEN = 3; // fewer than the ~4 of English prose, so estimates err high

/** Characters of text in a request's system prompt and messages (strings and text blocks). */
function textLength(v: unknown): number {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + textLength(x), 0);
  if (v && typeof v === 'object') {
    const o = v as { text?: unknown; content?: unknown };
    return textLength(o.text) + textLength(o.content);
  }
  return 0;
}

/**
 * A conservative cost for a call that may have been billed but returned no usage (a timeout, the
 * reader leaving, or the connection dropping after the request went out): the prompt estimated
 * from its text, all of it at the uncached input price, plus every allowed output token.
 */
export function estimateCost(
  model: string,
  params: Pick<MessageParams, 'system' | 'messages'>,
  maxTokens: number,
  started?: UsageLike | null,
): number {
  // A stream that got as far as message_start reported its exact input (cached and not).
  if (started) return costOf(model, { ...started, output_tokens: maxTokens });
  const input = Math.ceil((textLength(params.system) + textLength(params.messages)) / CHARS_PER_TOKEN);
  return costOf(model, { input_tokens: input, output_tokens: maxTokens });
}

let alertedBudgetDay = '';

/** Records a call's cost: the global and lane daily totals, then the lane's own onSpend. */
async function charge(usd: number, lane: Lane | undefined) {
  if (!(usd > 0)) return;
  await recordSpend(usd, lane?.spendKey);
  if (lane?.onSpend) {
    await lane.onSpend(usd).catch((err) => console.error(`[${lane.name}] could not charge the call:`, (err as Error).message));
  }
}

async function recordSpend(usd: number, laneKey?: string) {
  if (!(usd > 0)) return;
  try {
    const store = await getStore();
    // A lane's own daily total, for its own budget; the global total below counts it too.
    if (laneKey) await store.incrByFloat(laneKey, usd * 1e6, 3 * DAY_MS);
    // Micro-dollars, fractional, added atomically (INCRBYFLOAT in Redis).
    const total = await store.incrByFloat(spendKey(), usd * 1e6, 3 * DAY_MS);
    if (total >= budgetMicros() && alertedBudgetDay !== utcDay()) {
      alertedBudgetDay = utcDay();
      console.error(
        JSON.stringify({ level: 'alert', event: 'ask_daily_budget_reached', spentUsd: total / 1e6, budgetUsd: config().dailyBudgetUsd }),
      );
    }
  } catch (err) {
    console.error('[ask] could not record spend:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------------------
// Prompt-cache health. Every topic's instructions and document are one cached prefix that all its
// readers share, and follow-up questions in a note read the earlier turns from the cache too. A
// change that quietly breaks the prefix (a timestamp or per-reader text before the breakpoint)
// multiplies input cost by up to 10x, so the share of prompt tokens read from the cache over this
// process's recent calls is watched, and a drop below ASK_CACHE_READ_ALERT logs an alert.

const CACHE_WINDOW = 100;
const CACHE_MIN_CALLS = 20;
const CACHE_ALERT_EVERY_MS = 15 * 60 * 1000;
const cacheWindow: { read: number; total: number }[] = [];
let cacheAlertAt = 0;

/** The share of one call's prompt tokens read from the cache (0 when it had none). */
export function cacheReadRatio(u: UsageLike): number {
  const read = u.cache_read_input_tokens ?? 0;
  const total = (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0);
  return total > 0 ? read / total : 0;
}

/** Token-weighted cache-read share over the recent calls, and how many calls that covers. */
export function recentCacheReadRatio(): { ratio: number; calls: number } {
  let read = 0;
  let total = 0;
  for (const c of cacheWindow) {
    read += c.read;
    total += c.total;
  }
  return { ratio: total > 0 ? read / total : 0, calls: cacheWindow.length };
}

/** Forgets the recent calls (tests only). */
export function resetCacheWindow() {
  cacheWindow.length = 0;
  cacheAlertAt = 0;
}

function trackCache(u: UsageLike) {
  const read = u.cache_read_input_tokens ?? 0;
  cacheWindow.push({ read, total: (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0) });
  if (cacheWindow.length > CACHE_WINDOW) cacheWindow.shift();
  const { ratio, calls } = recentCacheReadRatio();
  const threshold = config().cacheReadAlert;
  if (calls < CACHE_MIN_CALLS || ratio >= threshold || Date.now() - cacheAlertAt < CACHE_ALERT_EVERY_MS) return;
  cacheAlertAt = Date.now();
  console.error(
    JSON.stringify({ level: 'alert', event: 'ask_cache_read_ratio_low', ratio: Number(ratio.toFixed(3)), threshold, calls, at: new Date().toISOString() }),
  );
}

// ---------------------------------------------------------------------------------------
// Error mapping

const retryAfterOf = (err: InstanceType<typeof Anthropic.APIError>, fallback: number) => {
  const h = err.headers?.get?.('retry-after');
  const n = h ? Number(h) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(300, Math.ceil(n)) : fallback;
};

type Mapped = { error: AskError; trip?: string };

/** The message inside an API error body ({ error: { message } }), else the error's own. */
function apiErrorMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const inner = body?.error?.message;
  return typeof inner === 'string' ? inner : err.message;
}

/** Maps an SDK error to what the reader gets, and whether it must turn Ask off. */
export function mapError(err: unknown, aborted: { client: boolean; deadline: boolean }): Mapped {
  if (err instanceof AskError) return { error: err };
  if (aborted.client) return { error: fail('aborted', 499) };
  if (err instanceof Anthropic.APIConnectionTimeoutError || aborted.deadline) return { error: fail('timeout', 504, 5) };
  if (err instanceof Anthropic.APIUserAbortError) return { error: fail('timeout', 504, 5) };
  if (err instanceof Anthropic.APIConnectionError) return { error: fail('upstream', 503, 10) };
  if (err instanceof Anthropic.APIError) {
    const type = err.type ?? '';
    // Only the error's class and type decide, never its text: a 400 can echo strings a caller chose
    // (an agent lab's tool_use ids, schema keys), and a regex over them would let anyone turn the
    // whole account off (R3-M1). An exhausted credit balance that comes as a 400 is just refused.
    // The reason stored and logged carries no message text either.
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || type === 'billing_error') {
      return { error: fail('unavailable', 503, 300), trip: `${err.status ?? 'no status'} ${type || 'error'} (request ${err.requestID ?? 'unknown'})` };
    }
    if (err instanceof Anthropic.RateLimitError) return { error: fail('busy', 503, retryAfterOf(err, 20)) };
    if (err.status === 529 || type === 'overloaded_error') return { error: fail('busy', 503, retryAfterOf(err, 30)) };
    // A stream that fails part way reports its error as an event, with no HTTP status.
    if ((err.status ?? 0) >= 500 || type === 'api_error') return { error: fail('busy', 503, retryAfterOf(err, 15)) };
    // 400/404/413/422: our request is wrong (a bug or a bad ASK_MODEL). Not the reader's fault.
    return { error: fail('upstream', 502) };
  }
  return { error: fail('upstream', 502) };
}

// Failures that happen before a request can reach Anthropic: the name didn't resolve, the network
// or host is unreachable, the connection was refused or timed out, or TLS never came up.
const PRE_SEND_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const PRE_SEND_SYSCALLS = new Set(['connect', 'getaddrinfo']);
const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;

/**
 * Whether a connection error may have come after the request went out (a reset, "socket hang up",
 * "other side closed", "terminated"), so Anthropic may have billed it. Refused connections, DNS,
 * unreachable networks and TLS failures never sent anything. Walks the cause chain the SDK and
 * fetch wrap them in (APIConnectionError → TypeError "fetch failed" → the socket error). Unknown
 * causes count as sent, to err toward the budget.
 */
export function connectionMayHaveSent(err: unknown): boolean {
  const seen = new Set<unknown>();
  const preSend = (e: unknown): boolean => {
    if (!e || typeof e !== 'object' || seen.has(e) || seen.size > 16) return false;
    seen.add(e);
    const { code, syscall, cause, errors } = e as { code?: unknown; syscall?: unknown; cause?: unknown; errors?: unknown };
    if (typeof code === 'string' && (PRE_SEND_CODES.has(code) || TLS_CODE.test(code))) return true;
    if (typeof syscall === 'string' && PRE_SEND_SYSCALLS.has(syscall)) return true;
    return preSend(cause) || (Array.isArray(errors) && errors.some(preSend));
  };
  return !preSend(err);
}

// ---------------------------------------------------------------------------------------
// Retries. Anthropic answers 529 (overloaded) and the odd 5xx when it is briefly short of
// capacity; one more try a moment later usually works. The SDK's own retry is off because it
// honours any Retry-After (a 30 s one held readers for 33 s in the load test) and can't see the
// gateway's deadline. Here a call is retried only when all of these hold:
//   - the failure is transient and wasn't billed: a 529, 5xx, 408 or 409 error response, or a
//     connection that never came up (never a 429: retrying adds load to an org that is already
//     rate limited, and the reader gets a 503 + Retry-After at once);
//   - nothing was streamed yet (no message_start), so the reader never sees text twice;
//   - fewer than ASK_MAX_RETRIES retries so far;
//   - the wait (Retry-After if Anthropic sent one, plus full-jitter backoff) is at most
//     ASK_RETRY_MAX_WAIT_MS, and at least half of ASK_TIMEOUT_MS is still left after it;
//   - the per-process retry budget allows it: one retry a second plus one per five calls, over
//     10 s (Finagle's defaults). Enough for a brief overload at any traffic; in a real outage it
//     caps the extra load retries put on Anthropic instead of tripling it.

const RETRY_BASE_MS = 500;
const retryBudget = new RetryBudget({ ratio: 0.2, minPerWindow: 10, windowMs: 10_000 });

/** Why a retryable failure wasn't retried, for the usage line. */
export type RetryDenied = 'attempts' | 'wait' | 'deadline' | 'budget' | 'streamed';

/** Whether a failure is transient and certainly unbilled, so the same request may be sent again. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof AskError) return false;
  if (err instanceof Anthropic.APIUserAbortError || err instanceof Anthropic.APIConnectionTimeoutError) return false;
  if (err instanceof Anthropic.APIConnectionError) return !connectionMayHaveSent(err);
  if (!(err instanceof Anthropic.APIError)) return false;
  const hint = err.headers?.get?.('x-should-retry');
  if (hint === 'false') return false;
  if (err instanceof Anthropic.RateLimitError || err.status === 429) return false;
  const status = err.status ?? 0;
  // A stream that fails before message_start reports overload as an error event with no status.
  return hint === 'true' || status === 408 || status === 409 || status >= 500 || err.type === 'overloaded_error' || err.type === 'api_error';
}

/** Anthropic's Retry-After in ms, when it sent one. */
function retryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof Anthropic.APIError)) return undefined;
  const ms = Number(err.headers?.get?.('retry-after-ms') ?? NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const s = Number(err.headers?.get?.('retry-after') ?? NaN);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : undefined;
}

export type RetryPlan = { retry: true; waitMs: number } | { retry: false; denied?: RetryDenied };

/**
 * Whether to send a failed call again, and after how long. `retries` is how many retries have
 * already been made, `leftMs` the time left before the call's deadline, `streamed` whether any
 * of the answer had started to arrive.
 */
export function planRetry(
  err: unknown,
  { retries, leftMs, streamed }: { retries: number; leftMs: number; streamed: boolean },
  cfg: Pick<ReturnType<typeof config>, 'maxRetries' | 'retryMaxWaitMs' | 'timeoutMs'>,
  budget: Pick<RetryBudget, 'tryRetry'> = retryBudget,
  random: () => number = Math.random,
): RetryPlan {
  if (!isRetryable(err)) return { retry: false };
  if (streamed) return { retry: false, denied: 'streamed' };
  if (retries >= cfg.maxRetries) return { retry: false, denied: 'attempts' };
  const waitMs = (retryAfterMs(err) ?? 0) + backoffMs(retries + 1, { baseMs: RETRY_BASE_MS, capMs: cfg.retryMaxWaitMs }, random);
  if (waitMs > cfg.retryMaxWaitMs) return { retry: false, denied: 'wait' };
  if (leftMs - waitMs < cfg.timeoutMs / 2) return { retry: false, denied: 'deadline' };
  if (!budget.tryRetry()) return { retry: false, denied: 'budget' };
  return { retry: true, waitMs };
}

// ---------------------------------------------------------------------------------------
// The call

/**
 * A caller other than Ask, with its own settings and allowance (the mock interview, P3-11). The
 * kill switch, the global daily budget and the concurrency limit still apply.
 */
export type Lane = {
  /** For logs, e.g. 'interview'. */
  name: string;
  /** A model id from MODELS (an unknown one falls back to DEFAULT_MODEL). */
  model: string;
  maxTokens: number;
  effort: Effort;
  /** The whole call's deadline; ASK_TIMEOUT_MS when unset. */
  timeoutMs?: number;
  /** Structured output: the reply is JSON matching this schema (output_config.format). */
  format?: Anthropic.Beta.BetaJSONOutputFormat;
  /** Counts the call against the lane's own allowance (in place of the reader's Ask quota), or throws an AskError. */
  reserve(): Promise<Reservation>;
  /** A store key the call's cost is also added to (micro-dollars), for the lane's own daily budget. */
  spendKey?: string;
  /**
   * Told every call's cost as it is recorded, before the call returns or throws: the actual cost of
   * a reply, and the same conservative estimate the budgets get for a call cut off after it went
   * out (a timeout, the reader leaving). Not called for a call that cost nothing. The mock
   * interview charges its session with it, so a stopped or failed call still counts.
   */
  onSpend?(usd: number): Promise<void>;
  /**
   * A client used in place of the Anthropic one, for this lane's calls only: the agent labs' fake
   * provider (agent-labs/fake-model.ts) in dev and tests. Every guard still applies.
   */
  client?: Anthropic;
};

export type CallMeta = {
  readerId: string;
  /** The reader's plan, for their daily quota (free when not given). */
  plan?: Plan;
  /** e.g. "instagram/email-and-password-login", for logs. */
  topic: string;
  /** Extra fields for the usage log (e.g. the grounding version). */
  log?: Record<string, unknown>;
  /** The HTTP request's signal: a reader who leaves stops the call. */
  signal?: AbortSignal;
  /** Another caller's settings and allowance; Ask's when unset. */
  lane?: Lane;
};

export type MessageParams = Omit<
  Anthropic.Beta.MessageCreateParamsNonStreaming,
  'model' | 'max_tokens' | 'output_config' | 'betas' | 'fallbacks' | 'stream'
>;

export type CallResult = { message: Anthropic.Beta.BetaMessage; costUsd: number; model: string };

/** The full request for the configured model: its cap, effort, output format and server-side fallbacks. */
export function requestBody(
  params: MessageParams,
  cfg: Pick<ReturnType<typeof config>, 'model' | 'maxTokens' | 'effort'> & { format?: Anthropic.Beta.BetaJSONOutputFormat },
) {
  const m = MODELS[cfg.model] ?? MODELS[DEFAULT_MODEL];
  const output = { ...(m.effort ? { effort: cfg.effort } : {}), ...(cfg.format ? { format: cfg.format } : {}) };
  return {
    ...params,
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    ...(Object.keys(output).length ? { output_config: output } : {}),
    // If a safety classifier declines, retry server-side on Anthropic's recommended fallback model.
    ...(m.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  } satisfies Anthropic.Beta.MessageCreateParamsNonStreaming;
}

type Body = ReturnType<typeof requestBody>;
type RequestOptions = { signal: AbortSignal; timeout: number; maxRetries: number };
/** What a call saw before it ended: a stream's message_start usage (exact input tokens). */
type Seen = { started?: UsageLike; firstTextAt?: number };
type Exec = (c: Anthropic, body: Body, opts: RequestOptions, seen: Seen) => Promise<Anthropic.Beta.BetaMessage>;

export const readerHash = (readerId: string) => createHash('sha256').update(`ask:${readerId}`).digest('base64url').slice(0, 16);

function logCall(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event: 'ask_call', ts: new Date().toISOString(), ...fields }));
}

/** Sends one message through every guard. Throws AskError; never a raw SDK error. */
export function createMessage(params: MessageParams, meta: CallMeta): Promise<CallResult> {
  return guarded(params, meta, (c, body, opts) => messagesOf(c, provider()).create(body, opts));
}

/**
 * Streams one message through every guard, handing each piece of answer text to onText as it
 * arrives, and resolves with the final message once the stream completes (the only point at
 * which usage is known and anything should be saved). Aborting meta.signal aborts the upstream
 * request. Throws AskError; never a raw SDK error.
 */
export function streamMessage(params: MessageParams, meta: CallMeta, onText: (delta: string) => void): Promise<CallResult> {
  return guarded(params, meta, (c, body, opts, seen) => {
    const stream = messagesOf(c, provider()).stream(body, opts);
    stream.on('streamEvent', (event) => {
      if (event.type === 'message_start') seen.started = event.message.usage;
    });
    stream.on('text', (delta) => {
      seen.firstTextAt ??= Date.now();
      onText(delta);
    });
    return stream.finalMessage();
  });
}

/** The settings a call runs with: Ask's, or its lane's. */
function callConfig(lane: Lane | undefined) {
  const cfg = config();
  if (!lane) return cfg;
  return {
    ...cfg,
    model: knownModel(lane.model, `${lane.name} model`),
    maxTokens: lane.maxTokens,
    effort: lane.effort,
    timeoutMs: lane.timeoutMs ?? cfg.timeoutMs,
    format: lane.format,
  };
}

async function guarded(params: MessageParams, meta: CallMeta, exec: Exec): Promise<CallResult> {
  const { lane } = meta;
  const cfg = callConfig(lane);
  const prov = provider();
  const started = Date.now();
  const base = { reader: readerHash(meta.readerId), topic: meta.topic, model: cfg.model, ...(lane ? { lane: lane.name } : {}), ...(prov.kind === 'bedrock' ? { provider: 'bedrock', region: prov.region } : {}), ...meta.log };
  let reservation: Reservation | null = null;
  let release: (() => void) | null = null;
  let sent = false;
  let attempts = 0;
  let retryDenied: RetryDenied | undefined;
  let seen: Seen = {};
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Ask's own calls need a build with Ask in it (PUBLIC_ASK_ENABLED); its routes are 404s
    // without it, so this is only a backstop. Other lanes don't depend on Ask's build flag.
    if (!lane && !FLAGS.ask) throw fail('unavailable', 503, 300);
    if (lane) {
      await checkGateway();
      reservation = await lane.reserve();
    } else reservation = await reserve(meta.readerId, meta.plan ?? 'free');
    release = await slots.acquire(cfg.queueMs, meta.signal);
    const c = lane?.client ?? anthropic(cfg.timeoutMs);
    // One deadline for the whole call, retries and the waits before them included.
    const deadlineAt = Date.now() + cfg.timeoutMs;
    timer = setTimeout(() => deadline.abort(), cfg.timeoutMs);
    const signal = meta.signal ? AbortSignal.any([meta.signal, deadline.signal]) : deadline.signal;
    const body = prov.kind === 'bedrock' && !lane?.client ? forBedrock(requestBody(params, cfg), prov) : requestBody(params, cfg);
    retryBudget.recordCall();
    let message: Anthropic.Beta.BetaMessage;
    for (;;) {
      // A reader already gone by now would make the SDK throw without sending anything.
      if (meta.signal?.aborted) throw fail('aborted', 499);
      seen = {};
      sent = true;
      attempts++;
      try {
        message = await exec(c, body, { signal, timeout: Math.max(1, deadlineAt - Date.now()), maxRetries: 0 }, seen);
        break;
      } catch (err) {
        if (meta.signal?.aborted || deadline.signal.aborted) throw err;
        const plan = planRetry(err, { retries: attempts - 1, leftMs: deadlineAt - Date.now(), streamed: !!seen.started }, cfg);
        if (!plan.retry) {
          retryDenied = plan.denied;
          throw err;
        }
        // Only unbilled failures are retried, so nothing of this attempt can be billed.
        sent = false;
        await sleep(plan.waitMs, signal);
      }
    }
    const costUsd = responseCost(cfg.model, message) * pricePremium(prov);
    await charge(costUsd, lane);
    const u = message.usage;
    trackCache(u);
    logCall({
      ...base,
      servedModel: message.model,
      messageId: message.id,
      requestId: (message as { _request_id?: string | null })._request_id ?? undefined,
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadRatio: Number(cacheReadRatio(u).toFixed(3)),
      costUsd: Number(costUsd.toFixed(6)),
      latencyMs: Date.now() - started,
      ...(seen.firstTextAt ? { firstTokenMs: seen.firstTextAt - started } : {}),
      // What the output tokens were: block types, and the text's size (a reply far smaller than its
      // output tokens spent them on something else).
      blocks: message.content.map((b) => b.type).join(','),
      textChars: message.content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0),
      stopReason: message.stop_reason,
      attempts,
      outcome: 'ok',
    });
    return { message, costUsd, model: message.model || cfg.model };
  } catch (err) {
    const mapped = mapError(err, { client: !!meta.signal?.aborted, deadline: deadline.signal.aborted });
    // Error responses aren't billed, so the question goes back to the reader. A request cut off
    // by a timeout or by the reader leaving may still be billed, so it keeps counting.
    const mayBeBilled = sent && (mapped.error.code === 'timeout' || mapped.error.code === 'aborted');
    if (reservation && !mayBeBilled) await reservation.refund();
    if (mapped.trip) await tripSwitch(mapped.trip);
    const api = err instanceof Anthropic.APIError ? err : null;
    // An error response (it has a status) isn't billed, and neither is a connection that never
    // came up. A timeout, the reader leaving, or a connection dropped after the request went out
    // may have been, with no usage to show for it: count a conservative estimate toward the budget.
    const dropped = err instanceof Anthropic.APIConnectionError && connectionMayHaveSent(err);
    const noUsage = sent && typeof api?.status !== 'number' && (mayBeBilled || dropped);
    const estimatedCostUsd = noUsage ? estimateCost(cfg.model, params, cfg.maxTokens, seen.started) : 0;
    await charge(estimatedCostUsd, lane);
    logCall({
      ...base,
      latencyMs: Date.now() - started,
      outcome: mapped.error.code,
      ...(noUsage ? { estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)) } : {}),
      status: api?.status,
      errorType: api?.type ?? undefined,
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
      // The API's own words name the offending field; they never carry the request's content.
      ...(api?.status === 400 ? { errorMessage: apiErrorMessage(api).slice(0, 300) } : {}),
      requestId: api?.requestID,
      ratelimitRemaining: api?.headers?.get?.('anthropic-ratelimit-requests-remaining') ?? undefined,
      attempts,
      retryDenied,
    });
    const stopped = !!meta.signal?.aborted || deadline.signal.aborted; // e.g. while waiting to retry
    if (!(err instanceof AskError) && !api && !stopped) console.error('[ask] unexpected error:', err);
    throw mapped.error;
  } finally {
    clearTimeout(timer);
    release?.();
  }
}
