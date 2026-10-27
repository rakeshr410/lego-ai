import { getSecret } from 'astro:env/server';
import { z } from 'zod';

// Server settings, read at runtime (process.env in production, .env in dev) and never inlined
// into the bundle. Every setting is declared once, in SETTINGS below, with its type and default;
// serverEnv() returns them parsed and typed, env(name) the raw trimmed string. Build-time settings (PUBLIC_*) are import.meta.env and live elsewhere.
// app/.env.example says what each one does.
//
// A malformed value never takes a dev server down: it falls back (to the default, or into range)
// and is logged once. A production server refuses to serve until every setting is valid and the
// required ones are set (assertProductionConfig, on the first live request), listing every
// problem at once.

type Setting<T> = {
  /** Checks a set value (trimmed, never blank) and converts it. */
  schema: z.ZodType<T, string>;
  /** The value when unset, and when invalid unless `recover` gives a closer one. */
  fallback: T;
  /** What a valid value looks like, for the problem message. */
  expect: string;
  /** A usable value from an invalid one (a number pulled into range). */
  recover?: (raw: string) => T | undefined;
  /** Never echo the value (tokens, keys, URLs that may carry a password). */
  secret?: boolean;
};

const text = (expect = 'text'): Setting<string | undefined> => ({ schema: z.string(), fallback: undefined, expect });
const secret = (): Setting<string | undefined> => ({ schema: z.string(), fallback: undefined, expect: 'a secret', secret: true });
const oneOf = <const T extends readonly [string, ...string[]], F extends T[number] | undefined>(values: T, fallback: F): Setting<T[number] | F> => ({
  schema: z.enum(values),
  fallback,
  expect: `one of ${values.join(', ')}`,
});
/** 'true' or 'false' (any case). */
const flag = (fallback: boolean): Setting<boolean> => ({
  schema: z
    .string()
    .transform((v) => v.toLowerCase())
    .pipe(z.enum(['true', 'false']))
    .transform((v) => v === 'true'),
  fallback,
  expect: 'true or false',
});
/** A whole number in [min, max]; out of range is pulled into it, anything else is the default. */
function int(fallback: number, min: number, max: number): Setting<number> {
  return {
    schema: z.coerce.number<string>().int().min(min).max(max),
    fallback,
    expect: `a whole number from ${min} to ${max}`,
    recover: (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.round(Math.max(min, Math.min(max, n))) : undefined;
    },
  };
}
/** An http(s) URL. */
const httpUrl = (example: string) => z.string().pipe(z.url({ protocol: /^https?$/, error: `a URL like ${example}` }));

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
/** Adaptive-thinking effort levels the gateway's callers may use. */
export const ASK_EFFORTS = ['low', 'medium', 'high'] as const;

const SETTINGS = {
  // Site and proxies
  PUBLIC_ORIGIN: {
    schema: httpUrl('https://arrowbox.example').transform((u) => new URL(u)),
    fallback: undefined,
    expect: 'a URL like https://arrowbox.example',
  } satisfies Setting<URL | undefined>,
  TRUST_PROXY: { ...int(0, 0, 1_000), recover: () => 0 } satisfies Setting<number>,
  CLIENT_IP_HEADER: { ...text('a header name like cf-connecting-ip'), schema: z.string().regex(/^[A-Za-z0-9-]+$/) } satisfies Setting<string | undefined>,
  CSP_REPORT_ONLY: flag(false),
  REDIS_URL: { ...secret(), expect: 'a URL like redis://host:6379' },
  // The main site (lego/web), which owns readers' sessions (lib/server/session.ts)
  /** Where this app reaches the main site on the private network (dev: http://localhost:4321). */
  WEB_INTERNAL_URL: {
    schema: httpUrl('http://web.internal:4321').transform((u) => u.replace(/\/+$/, '')),
    fallback: 'http://localhost:4321',
    expect: 'a URL like http://web.internal:4321',
  } satisfies Setting<string>,
  /** The bearer between this app and the main site, both ways (the main site has the same value). */
  LEGO_AI_SECRET: secret(),
  // The credit ledger (lego-ledger, lib/server/ledger.ts): with both set, sessions spend credits by the minute
  // instead of counting against the month's sessions.
  /** Where this app reaches lego-ledger on the private network (dev: http://localhost:4400). */
  LEDGER_URL: { ...text('a URL like http://ledger.internal:4400'), schema: httpUrl('http://ledger.internal:4400').transform((u) => u.replace(/\/+$/, '')) } satisfies Setting<string | undefined>,
  /** This app's bearer at the ledger (its lego-ai entry in LEDGER_CLIENTS). */
  LEDGER_SECRET: secret(),
  /** lego-admin's bearer here (the staff's usage pages): it reads what each session cost (/api/internal/interview/costs). */
  LEGO_ADMIN_SECRET: secret(),
  // The model gateway (lib/server/llm-gateway.ts), shared with the main site's Ask mode: the same
  // kill switch (ASK_ENABLED or the store flag), daily budget and concurrency cover the interview.
  // With the same REDIS_URL as the main site, the store flag and the day's spend are shared too.
  ANTHROPIC_API_KEY: secret(),
  /**
   * Where Claude is served from (llm-gateway.ts, "Provider"): Anthropic's API, or Amazon Bedrock in
   * BEDROCK_REGION with BEDROCK_API_KEY (a Bedrock API key, sent as the bearer). BEDROCK_GEO picks the
   * geo inference profile (in, us, eu, jp, au, or global; the region's own when unset); BEDROCK_ENDPOINT
   * runtime takes those profiles, mantle the bare model id; BEDROCK_MODEL_IDS names a model's id outright.
   */
  LLM_PROVIDER: oneOf(['anthropic', 'bedrock'], 'anthropic'),
  BEDROCK_REGION: text('an AWS region like ap-south-1'),
  BEDROCK_ENDPOINT: oneOf(['runtime', 'mantle'], 'runtime'),
  BEDROCK_GEO: text('in, us, eu, jp, au or global'),
  BEDROCK_MODEL_IDS: text('model=id pairs, comma-separated'),
  BEDROCK_API_KEY: secret(),
  ASK_ENABLED: flag(false),
  /** Checked against the gateway's model list there (an unknown one falls back to its default). */
  ASK_MODEL: text('a model id'),
  ASK_EFFORT: oneOf(ASK_EFFORTS, 'low'),
  ASK_MAX_TOKENS: int(1500, 256, 8192),
  ASK_DAILY_QUOTA: int(20, 0, 10_000),
  // Questions per day on the paid and staff plans (lib/server/entitlements.ts)
  ASK_DAILY_QUOTA_PRO: int(200, 0, 10_000),
  ASK_DAILY_QUOTA_STAFF: int(500, 0, 10_000),
  ASK_DAILY_BUDGET_USD: { schema: z.coerce.number<string>().min(0), fallback: 20, expect: 'a dollar amount, 0 or more' } satisfies Setting<number>,
  ASK_MAX_CONCURRENCY: int(8, 1, 500),
  ASK_QUEUE_MS: int(5_000, 0, 30_000),
  ASK_TIMEOUT_MS: int(40_000, 5_000, 120_000),
  ASK_MAX_RETRIES: int(2, 0, 5),
  ASK_RETRY_MAX_WAIT_MS: int(5_000, 0, 30_000),
  ASK_CACHE_READ_ALERT: { schema: z.coerce.number<string>().min(0).max(1), fallback: 0.6, expect: 'a fraction from 0 to 1' } satisfies Setting<number>,
  // Mock interview (lib/server/interview/, docs/README.md). Its pages and API exist only in
  // a build with PUBLIC_INTERVIEW_ENABLED=true; these tune and pause it at runtime.
  INTERVIEW_ENABLED: flag(true),
  /**
   * Early access (docs/README.md "Rollout"): readers who may start a mock interview, as
   * emails, comma-separated; with the store's list (scripts/interview-switch.mjs allow) empty too,
   * every signed-in reader may. Staff always may.
   */
  INTERVIEW_ALLOWLIST: text('comma-separated emails'),
  /** The turn-by-turn interviewer (a cheaper model); checked against the gateway's model list. */
  INTERVIEW_MODEL: text('a model id'),
  /** The voice interviewer's turns, when a faster model than INTERVIEW_MODEL is wanted (the spoken reply waits on its first token). */
  INTERVIEW_VOICE_MODEL: text('a model id'),
  /** The one feedback pass at the end (the premium model). */
  INTERVIEW_FEEDBACK_MODEL: text('a model id'),
  INTERVIEW_EFFORT: oneOf(ASK_EFFORTS, 'low'),
  INTERVIEW_MAX_TOKENS: int(700, 256, 4096),
  INTERVIEW_FEEDBACK_MAX_TOKENS: int(4000, 1024, 16_000),
  /** The grader's effort (design section 8: high, passed explicitly; the model's default is medium). */
  INTERVIEW_FEEDBACK_EFFORT: oneOf(ASK_EFFORTS, 'high'),
  INTERVIEW_FEEDBACK_TIMEOUT_MS: int(120_000, 10_000, 300_000),
  /** The per-turn evaluator (design section 8): off leaves the director without a live signal. */
  INTERVIEW_EVALUATOR: flag(true),
  INTERVIEW_EVALUATOR_MODEL: text('a model id'),
  INTERVIEW_EVALUATOR_MAX_TOKENS: int(3000, 256, 8192),
  /**
   * The whiteboard (design section 7): the server reads the candidate's board on every reply. Its
   * two model fallbacks, per stage: label matches the deterministic matcher could not make, and a
   * description of a freehand board (vision), both on the evaluator's model. 0 turns one off.
   */
  INTERVIEW_BOARD_MATCH_CALLS: int(4, 0, 20),
  INTERVIEW_BOARD_VISION_CALLS: int(2, 0, 10),
  /**
   * The voice room's vendors (design decisions 4 and 5; phase 3): Daily carries the audio, Deepgram
   * transcribes, Cartesia speaks. Read by the interview-voice service; declared here so a
   * placeholder or truncated value is caught at startup like the other secrets. Unset until then.
   */
  DAILY_API_KEY: secret(),
  DEEPGRAM_API_KEY: secret(),
  CARTESIA_API_KEY: secret(),
  SARVAM_API_KEY: secret(),
  SMALLEST_API_KEY: secret(),
  INTERVIEW_MONTHLY_SESSIONS: int(3, 0, 1_000),
  /** Drills (a topic's or a section's short interview, docs/README.md) a reader may start per month, text or voice; separate from the whole interviews above. */
  INTERVIEW_MONTHLY_DRILLS: int(30, 0, 10_000),
  /** Coach lessons (docs/coach-mode.md) a reader may start per month. */
  INTERVIEW_COACH_MONTHLY_SESSIONS: int(10, 0, 10_000),
  /** The coach's turn model, when it differs from the interviewer's. */
  INTERVIEW_COACH_MODEL: text('a model id'),
  /** A teaching turn: two or three sentences and up to eight drawing operations; the cap keeps a move short even when the words run on. */
  INTERVIEW_COACH_MAX_TOKENS: int(500, 256, 4096),
  /** The coach draws through a `draw` tool call instead of <draw> elements in its words (coach-mode.md, phase 4): it hears what landed and what was dropped inside the turn, at a second model call per drawing. */
  INTERVIEW_COACH_DRAW_TOOLS: flag(false),
  /** Whether a lesson asks the learner anything (checks, re-asks, draw tasks): off while lessons are tuned, so they teach straight through. */
  INTERVIEW_COACH_QUESTIONS: flag(false),
  /** Whether a lesson's parts marked for it (a pack's asks) are given by the learner first: the coach asks for the list, writes their points in their words, then adds what they left out. Separate from the checks above. */
  INTERVIEW_COACH_ASKS: flag(true),
  /** A 45-minute lesson costs more than an interview (docs/cost-model.md, "Coach mode"). */
  INTERVIEW_COACH_SESSION_BUDGET_USD: { schema: z.coerce.number<string>().min(0), fallback: 4, expect: 'a dollar amount, 0 or more' } satisfies Setting<number>,
  INTERVIEW_MAX_TURNS: int(60, 4, 400),
  INTERVIEW_SESSION_BUDGET_USD: { schema: z.coerce.number<string>().min(0), fallback: 1.5, expect: 'a dollar amount, 0 or more' } satisfies Setting<number>,
  INTERVIEW_DAILY_BUDGET_USD: { schema: z.coerce.number<string>().min(0), fallback: 10, expect: 'a dollar amount, 0 or more' } satisfies Setting<number>,
  INTERVIEW_RETENTION_DAYS: int(30, 1, 365),
  INTERVIEW_OVERTIME_MINUTES: int(15, 0, 60),
  // The voice room (docs/README.md "Voice"; design section 6): the Python interview-voice
  // service and its vendors. Voice sessions are Pro only, with their own monthly quota in sessions
  // and minutes, their own session and daily dollar caps inside the interview's, and a switch
  // (interview:voice:enabled in the store, scripts/interview-switch.mjs voice off).
  INTERVIEW_VOICE_ENABLED: flag(true),
  /** The bearer the voice service presents on /api/internal/interview/*, and the HMAC key of the attach tokens the web mints for it. */
  INTERVIEW_VOICE_SECRET: secret(),
  /** Where the web tier reaches the voice service (Service Connect: http://voice.internal:7860; the dev compose: http://localhost:7860). */
  INTERVIEW_VOICE_URL: text('a URL like http://voice.internal:7860'),
  INTERVIEW_VOICE_MONTHLY_SESSIONS: int(5, 0, 1_000),
  INTERVIEW_VOICE_MONTHLY_MINUTES: int(225, 0, 100_000),
  INTERVIEW_VOICE_MAX_EXCHANGES: int(90, 4, 600),
  INTERVIEW_VOICE_MAX_TOKENS: int(350, 128, 2048),
  /** The speculative start (prefetch.ts): the reply begins on what the voice service has heard before the turn is confirmed. */
  INTERVIEW_VOICE_SPECULATE: flag(true),
  INTERVIEW_VOICE_SESSION_BUDGET_USD: { schema: z.coerce.number<string>().min(0), fallback: 3, expect: 'a dollar amount, 0 or more' } satisfies Setting<number>,
  INTERVIEW_VOICE_DAILY_BUDGET_USD: { schema: z.coerce.number<string>().min(0), fallback: 30, expect: 'a dollar amount, 0 or more' } satisfies Setting<number>,
  /** The vendors' list prices, for the usage the voice service reports in its heartbeats (re-quote before the beta). */
  VOICE_STT_USD_PER_MIN: { schema: z.coerce.number<string>().min(0), fallback: 0.0077, expect: 'a dollar amount, 0 or more' } satisfies Setting<number>,
  VOICE_TTS_USD_PER_1K_CHARS: { schema: z.coerce.number<string>().min(0), fallback: 0.03, expect: 'a dollar amount, 0 or more' } satisfies Setting<number>,
  /**
   * Each service's own price, where it differs from the two above: "stt:flux=0.0077,tts:smallest=0.03,tts:sarvam=0.018",
   * speech to text in USD a minute, the voice in USD per 1,000 characters (re-quote from the vendors' price pages).
   */
  VOICE_RATES: {
    schema: z.string().regex(/^\s*(?:(?:stt|tts):[a-z0-9_-]+\s*=\s*\d+(?:\.\d+)?\s*(?:,\s*|$))*$/i),
    fallback: '',
    expect: 'a list like stt:flux=0.0077,tts:smallest=0.03',
  } satisfies Setting<string>,
  /** Daily's price for a participant's minute in a room (the learner and the voice service are two); re-quote from Daily's plan. */
  DAILY_USD_PER_PARTICIPANT_MIN: { schema: z.coerce.number<string>().min(0), fallback: 0.004, expect: 'a dollar amount, 0 or more' } satisfies Setting<number>,
  /** Daily's REST API (rooms and meeting tokens); a mock in tests. */
  DAILY_API_URL: text('a URL like https://api.daily.co/v1'),
  DAILY_GEO: text('a Daily region like ap-south-1'),
  // Logs and error tracking
  LOG_LEVEL: oneOf(LOG_LEVELS, undefined),
  RELEASE: text(),
  SENTRY_DSN: { schema: httpUrl('https://key@o0.ingest.sentry.io/0'), fallback: undefined, expect: 'a Sentry DSN (https://...)', secret: true } satisfies Setting<
    string | undefined
  >,
  SENTRY_ENVIRONMENT: text(),
};

export type ServerEnvName = keyof typeof SETTINGS;
type ValueOf<S> = S extends Setting<infer T> ? T : never;
/** Every server setting, parsed. */
export type ServerEnv = { -readonly [K in ServerEnvName]: ValueOf<(typeof SETTINGS)[K]> };

/** A setting's raw value, trimmed; blank counts as unset. */
export function env(name: ServerEnvName): string | undefined {
  const v = getSecret(name)?.trim();
  return v ? v : undefined;
}

function read(): { values: ServerEnv; problems: string[] } {
  const values: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [name, s] of Object.entries(SETTINGS) as [ServerEnvName, Setting<unknown>][]) {
    const raw = env(name);
    if (raw === undefined) {
      values[name] = s.fallback;
      continue;
    }
    const parsed = s.schema.safeParse(raw);
    if (parsed.success) {
      values[name] = parsed.data;
      continue;
    }
    const value = s.recover?.(raw) ?? s.fallback;
    values[name] = value;
    const got = s.secret ? '' : ` (got ${JSON.stringify(raw)})`;
    const using = value === undefined ? 'treating it as unset' : `using ${value instanceof URL ? value.href : JSON.stringify(value)}`;
    problems.push(`${name} must be ${s.expect}${got}; ${using}`);
  }
  return { values: values as ServerEnv, problems };
}

/**
 * The server settings, parsed and typed, with defaults filled in. Read per call (cheap), so tests
 * and a restarted server see the current environment.
 */
export const serverEnv = (): ServerEnv => read().values;

/** Settings that are set but invalid, one message each (secret values are never included). */
export const settingProblems = (): string[] => read().problems;

/**
 * A production build (import.meta.env.PROD is fixed at build time, so `node dist/server/entry.mjs`
 * counts even without NODE_ENV) or a server started with NODE_ENV=production.
 */
export const isProduction = () => import.meta.env.PROD || process.env.NODE_ENV === 'production';

/** TRUST_PROXY as a hop count; 0 (or unset, or not a number) means no proxy is trusted. */
export const trustProxyHops = (): number => serverEnv().TRUST_PROXY;

/** The public site origin (PUBLIC_ORIGIN), or null in dev when it isn't set. */
export const publicOrigin = (): URL | null => serverEnv().PUBLIC_ORIGIN ?? null;

/** Cookies get Secure (and the __Host- prefix) whenever the site is served over https. */
export const secureCookies = () => publicOrigin()?.protocol === 'https:';

/** The main site on the private network (http://localhost:4321 in dev), without a trailing slash. */
export const webInternalUrl = (): string => serverEnv().WEB_INTERNAL_URL;

// Values that are clearly not real secrets: .env.example leftovers and the like.
const PLACEHOLDER = /tobemodified|changeme|change-me|placeholder|example|your[-_]|^x+$|^test$/i;

/** Why a secret's value is unusable, or null if it looks real. */
export function secretProblem(name: ServerEnvName, minLength: number): string | null {
  const v = env(name);
  if (!v) return `${name} is not set`;
  if (PLACEHOLDER.test(v)) return `${name} is a placeholder value`;
  if (v.length < minLength) return `${name} is shorter than ${minLength} characters`;
  return null;
}

/** Everything a production server can't run with, or [] when the config is good. */
export function productionProblems(): string[] {
  const { values, problems } = read();
  const out = problems.map((p) => p.replace(/; (using|treating) .*$/, ''));
  const origin = values.PUBLIC_ORIGIN;
  if (!env('PUBLIC_ORIGIN')) out.push('PUBLIC_ORIGIN is required');
  else if (origin && origin.protocol !== 'https:' && origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') {
    out.push('PUBLIC_ORIGIN must use https in production');
  }
  if (!env('REDIS_URL')) out.push('REDIS_URL is required (sessions and rate limits are shared across instances)');
  if (!values.TRUST_PROXY && !values.CLIENT_IP_HEADER) {
    // Without one, per-IP rate limits either see only the proxy's address or a client-chosen one.
    out.push('set TRUST_PROXY (proxies in front, >= 1) or CLIENT_IP_HEADER so rate limits see client IPs');
  }
  // No silent fallback to a localhost main site, and no placeholder or truncated bearer.
  if (!env('WEB_INTERNAL_URL')) out.push('WEB_INTERNAL_URL is required (the main site on the private network)');
  const bearer = secretProblem('LEGO_AI_SECRET', 32);
  if (bearer) out.push(bearer);
  for (const optional of ['ANTHROPIC_API_KEY', 'BEDROCK_API_KEY', 'DAILY_API_KEY', 'DEEPGRAM_API_KEY', 'CARTESIA_API_KEY', 'SARVAM_API_KEY', 'SMALLEST_API_KEY'] as const) {
    const p = env(optional) ? secretProblem(optional, 20) : null;
    if (p) out.push(p);
  }
  if (env('LEDGER_URL') || env('LEDGER_SECRET')) {
    const p = secretProblem('LEDGER_SECRET', 32);
    if (p) out.push(p);
    if (!env('LEDGER_URL')) out.push('LEDGER_URL is required with LEDGER_SECRET');
  }
  // The voice service's bearer is set with its URL, and real (the internal routes refuse every call without it).
  if (env('INTERVIEW_VOICE_URL') || env('INTERVIEW_VOICE_SECRET')) {
    const p = secretProblem('INTERVIEW_VOICE_SECRET', 32);
    if (p) out.push(p);
    if (!env('INTERVIEW_VOICE_URL')) out.push('INTERVIEW_VOICE_URL is required with INTERVIEW_VOICE_SECRET');
  }
  return out;
}

let checked = false;

/**
 * Fails fast on settings production can't run without, naming every problem; in dev, logs any
 * invalid setting once instead. Called on the first live request.
 */
export function assertProductionConfig() {
  if (checked) return;
  if (!isProduction()) {
    for (const p of settingProblems()) console.warn(`[env] ${p} (see app/.env.example)`);
    checked = true;
    return;
  }
  const problems = productionProblems();
  if (problems.length) throw new Error(`Invalid production config (see app/.env.example): ${problems.join('; ')}`);
  checked = true;
}
