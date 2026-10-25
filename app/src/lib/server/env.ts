import { getSecret } from 'astro:env/server';
import { z } from 'zod';
import { FLAGS } from '../flags';

// Server settings, read at runtime (process.env in production, .env in dev) and never inlined
// into the bundle. Every setting is declared once, in SETTINGS below, with its type and default;
// web/.env.example says what each one does. serverEnv() returns them parsed and typed, env(name)
// the raw trimmed string. Build-time settings (PUBLIC_*) are import.meta.env and live elsewhere.
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
/** Razorpay's two modes; a key id starts with rzp_<mode>_ and must match BILLING_MODE. */
export const BILLING_MODES = ['test', 'live'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
const RAZORPAY_KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]+$/;
/** The Razorpay API; only test mode may be pointed anywhere else (a mock). */
export const RAZORPAY_API = 'https://api.razorpay.com';
/** Google's OAuth endpoints, by the path lib/server/google.ts adds (/auth, /token). */
export const GOOGLE_OAUTH = 'https://accounts.google.com/o/oauth2/v2';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Adaptive-thinking effort levels Ask may use. */
export const ASK_EFFORTS = ['low', 'medium', 'high'] as const;
/** Where the agent labs' live model comes from: Anthropic, or the fake provider (dev and tests only). */
export const AGENT_LAB_PROVIDERS = ['anthropic', 'fake'] as const;

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
  // Strapi (accounts, Ask notes)
  STRAPI_URL: {
    schema: httpUrl('http://cms.internal:1337').transform((u) => u.replace(/\/+$/, '')),
    fallback: 'http://localhost:1337',
    expect: 'a URL like http://cms.internal:1337',
  } satisfies Setting<string>,
  STRAPI_SERVER_TOKEN: secret(),
  STRAPI_CONTENT_TOKEN: secret(),
  // Registration
  TURNSTILE_SITE_KEY: text(),
  TURNSTILE_SECRET_KEY: secret(),
  SIGNUP_DAILY_CAP: { ...int(0, 0, 1_000_000), recover: () => 0 } satisfies Setting<number>,
  // Sign-in and sign-up calls to Strapi (bcrypt-bound) in flight per web process, and how long one may take
  AUTH_MAX_CONCURRENCY: int(4, 1, 100),
  AUTH_TIMEOUT_MS: int(5_000, 500, 30_000),
  // How long the reader page's reads wait on Strapi and the store before answering degraded
  BOOTSTRAP_TIMEOUT_MS: int(800, 100, 10_000),
  NOTES_TIMEOUT_MS: int(2_000, 200, 10_000),
  // Ask mode (lib/server/llm-gateway.ts). Its routes exist only in a build with
  // PUBLIC_ASK_ENABLED=true; the kill switch below is off unless set (the interview passes it too).
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
  // Mock interview (lib/server/interview/, docs/interview/README.md). Its pages and API exist only in
  // a build with PUBLIC_INTERVIEW_ENABLED=true; these tune and pause it at runtime.
  INTERVIEW_ENABLED: flag(true),
  /**
   * Early access (docs/interview/README.md "Rollout"): readers who may start a mock interview, as
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
  /** Drills (a topic's or a section's short interview, docs/interview/README.md) a reader may start per month, text or voice; separate from the whole interviews above. */
  INTERVIEW_MONTHLY_DRILLS: int(30, 0, 10_000),
  /** Coach lessons (docs/interview/coach-mode.md) a reader may start per month. */
  INTERVIEW_COACH_MONTHLY_SESSIONS: int(10, 0, 10_000),
  /** The coach's turn model, when it differs from the interviewer's. */
  INTERVIEW_COACH_MODEL: text('a model id'),
  /** A teaching turn: two or three sentences and up to eight drawing operations; the cap keeps a move short even when the words run on. */
  INTERVIEW_COACH_MAX_TOKENS: int(500, 256, 4096),
  /** The coach draws through a `draw` tool call instead of <draw> elements in its words (coach-mode.md, phase 4): it hears what landed and what was dropped inside the turn, at a second model call per drawing. */
  INTERVIEW_COACH_DRAW_TOOLS: flag(false),
  /** A 45-minute lesson costs more than an interview (docs/interview/cost-model.md, "Coach mode"). */
  INTERVIEW_COACH_SESSION_BUDGET_USD: { schema: z.coerce.number<string>().min(0), fallback: 4, expect: 'a dollar amount, 0 or more' } satisfies Setting<number>,
  INTERVIEW_MAX_TURNS: int(60, 4, 400),
  INTERVIEW_SESSION_BUDGET_USD: { schema: z.coerce.number<string>().min(0), fallback: 1.5, expect: 'a dollar amount, 0 or more' } satisfies Setting<number>,
  INTERVIEW_DAILY_BUDGET_USD: { schema: z.coerce.number<string>().min(0), fallback: 10, expect: 'a dollar amount, 0 or more' } satisfies Setting<number>,
  INTERVIEW_RETENTION_DAYS: int(30, 1, 365),
  INTERVIEW_OVERTIME_MINUTES: int(15, 0, 60),
  // The voice room (docs/interview/README.md "Voice"; design section 6): the Python interview-voice
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
  /** Daily's REST API (rooms and meeting tokens); a mock in tests. */
  DAILY_API_URL: text('a URL like https://api.daily.co/v1'),
  DAILY_GEO: text('a Daily region like ap-south-1'),
  // Interactive labs (lib/server/labs.ts, docs/labs-design.md "Web route"). The routes exist only in a
  // build with PUBLIC_LABS_ENABLED=true; LABS_ENABLED is the runtime kill switch (off unless set).
  LABS_ENABLED: flag(false),
  /** The lab runner's base URL on the private network (labs/runner), server-side only. */
  LABS_RUNNER_URL: {
    schema: httpUrl('http://labs.internal:8787').transform((u) => u.replace(/\/+$/, '')),
    fallback: undefined,
    expect: 'a URL like http://labs.internal:8787',
  } satisfies Setting<string | undefined>,
  /** The HMAC key of the bearer tokens the web server mints for the runner (the runner has the same LABS_SECRET). */
  LABS_SECRET: secret(),
  /** Lab sessions a Free reader may start in total (lifetime, not per day); paid plans are unlimited. Counted only where the free tier is enforced (PUBLIC_BILLING). */
  LABS_FREE_SESSIONS: int(5, 0, 1_000),
  /** How long one call to the runner may take (a little over its own statement limit and workload wall time). */
  LABS_TIMEOUT_MS: int(45_000, 1_000, 120_000),
  // Agent labs' live model (lib/server/agent-labs/proxy.ts, docs/labs-design.md "Agentic labs"): a lane
  // on the gateway, so Ask's kill switch (ASK_ENABLED / the store flag), ASK_DAILY_BUDGET_USD and
  // ASK_MAX_CONCURRENCY cover it too. The routes exist only in a build with PUBLIC_AGENT_LABS_ENABLED=true.
  /** Runtime switch for live-model runs (off unless set). */
  AGENT_LAB_LIVE_ENABLED: flag(false),
  /** The one model live runs use, fixed server-side; checked against the gateway's model list. */
  AGENT_LAB_MODEL: text('a model id'),
  /** Output tokens per model call (max_tokens, set by the server). */
  AGENT_LAB_MAX_TOKENS: int(1024, 64, 8192),
  /** One model call, retries included. */
  AGENT_LAB_TIMEOUT_MS: int(30_000, 5_000, 120_000),
  /** Model calls per run. */
  AGENT_LAB_RUN_CALLS: int(14, 1, 100),
  /** Input tokens per run (all its calls together). */
  AGENT_LAB_RUN_INPUT_TOKENS: int(80_000, 1_000, 2_000_000),
  /**
   * Ceilings for a lab whose live block declares a case binding (a batch of small single-turn calls, e.g. 30 or 2 x 20): the most model
   * calls and input tokens one such run may use, whatever the lab declares. The range's top is the hard limit in code (the kit's
   * MAX_MODEL_CALLS is 60); lower them to tighten the lane.
   */
  AGENT_LAB_BATCH_RUN_CALLS_MAX: int(60, 1, 60),
  AGENT_LAB_BATCH_RUN_INPUT_TOKENS_MAX: int(200_000, 1_000, 400_000),
  /** A run expires this long after it starts. */
  AGENT_LAB_RUN_TTL_MS: int(900_000, 60_000, 7_200_000),
  /** Tokens (input + output) per reader per UTC day, by plan (entitlements.ts); 0 turns live runs off for the plan. */
  AGENT_LAB_DAILY_TOKENS: int(0, 0, 100_000_000),
  AGENT_LAB_DAILY_TOKENS_PRO: int(1_200_000, 0, 100_000_000),
  AGENT_LAB_DAILY_TOKENS_STAFF: int(6_000_000, 0, 100_000_000),
  /** Runs a reader may start per UTC day. */
  AGENT_LAB_DAILY_RUNS: int(40, 0, 10_000),
  /** Model calls per reader per minute. */
  AGENT_LAB_RATE_PER_MINUTE: int(30, 1, 1_000),
  /** The lane's own daily dollar budget, kept well under ASK_DAILY_BUDGET_USD (which counts it too) so lab use can't switch Ask off. */
  AGENT_LAB_DAILY_BUDGET_USD: { schema: z.coerce.number<string>().min(0), fallback: 8, expect: 'a dollar amount, 0 or more' } satisfies Setting<number>,
  /** anthropic, or fake: replies from a lab's recorded fixture, never a network call (dev and tests; production refuses it). */
  AGENT_LAB_PROVIDER: oneOf(AGENT_LAB_PROVIDERS, 'anthropic'),
  // Billing (Phase 4, docs/phase-4-design.md): Pro through Razorpay. Its pages and API exist only in
  // a build with PUBLIC_BILLING=true; BILLING_ENABLED is the runtime kill switch for starting and
  // changing payments (the webhook keeps recording while it is off).
  BILLING_ENABLED: flag(false),
  /** test or live; checked against RAZORPAY_KEY_ID's prefix, and live never talks to a mock. */
  BILLING_MODE: oneOf(BILLING_MODES, 'test'),
  /** USD checkout for billing countries outside India (needs Razorpay International Payments). */
  BILLING_INTL_ENABLED: flag(true),
  /**
   * Lets a production server sell in test mode (BILLING_MODE=test): staging only. Without it a
   * production build with billing refuses to start in test mode, where Razorpay's test cards would
   * grant Pro without any money moving.
   */
  BILLING_ALLOW_TEST: flag(false),
  /**
   * Private coupons, as CODE:percentOff pairs separated by commas: honoured by the quote and
   * checkout only, never listed or offered on a page, and kept out of content/pricing.yaml (and git).
   * scripts/billing-sync-plans.mjs reads the same variable to make their Razorpay plans.
   */
  BILLING_PRIVATE_COUPONS: secret(),
  /** Days Pro outlasts a paid period, covering a renewal's retries: card (T+1..T+3) and UPI Autopay (D11). */
  BILLING_GRACE_DAYS_CARD: int(4, 0, 30),
  BILLING_GRACE_DAYS_UPI: int(6, 0, 30),
  /** Automatic refunds (duplicate, orphan and instrument-mismatch payments) per hour before they stop and alert. */
  BILLING_AUTOREFUND_MAX_PER_HOUR: int(5, 0, 1_000),
  /**
   * How often each task's reconciler looks for what webhooks missed (lib/server/billing/reconcile.ts);
   * one task at a time does the work (a Redis lease). 0 turns it off (the e2e server does).
   */
  BILLING_RECONCILE_INTERVAL_MS: int(300_000, 0, 3_600_000),
  RAZORPAY_KEY_ID: { ...text('a Razorpay key id like rzp_test_...'), schema: z.string().regex(RAZORPAY_KEY_ID) } satisfies Setting<string | undefined>,
  RAZORPAY_KEY_SECRET: secret(),
  RAZORPAY_WEBHOOK_SECRET: secret(),
  /** The webhook secret before a rotation, accepted until RAZORPAY_WEBHOOK_SECRET_PREV_UNTIL. */
  RAZORPAY_WEBHOOK_SECRET_PREV: secret(),
  RAZORPAY_WEBHOOK_SECRET_PREV_UNTIL: {
    schema: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
    fallback: undefined,
    expect: 'an ISO date-time like 2026-10-31T00:00:00Z',
  } satisfies Setting<Date | undefined>,
  /**
   * Razorpay's API, overridden only to point test mode at a mock on this machine (e2e/). Calls
   * carry RAZORPAY_KEY_SECRET as Basic auth, so anything but Razorpay or a loopback host is invalid
   * (and falls back to Razorpay).
   */
  RAZORPAY_API_BASE: {
    schema: httpUrl('https://api.razorpay.com')
      .transform((u) => u.replace(/\/+$/, ''))
      .refine((u) => u === RAZORPAY_API || LOOPBACK.has(new URL(u).hostname)),
    fallback: RAZORPAY_API,
    expect: `${RAZORPAY_API}, or a mock on a loopback host like http://127.0.0.1:4420`,
  } satisfies Setting<string>,
  // Google sign-in (lib/server/google.ts). Without the client id, its routes answer 404; the button
  // shows only in a build with PUBLIC_GOOGLE_SIGNIN=true.
  /** The OAuth client's id (Google Cloud Console > APIs & Services > Credentials). */
  GOOGLE_CLIENT_ID: text('an OAuth client id like 1234-abc.apps.googleusercontent.com'),
  GOOGLE_CLIENT_SECRET: secret(),
  /**
   * Google's authorization endpoint, overridden only to point dev and tests at a mock on this machine
   * (e2e/mock-google.mjs): the code exchange carries GOOGLE_CLIENT_SECRET, so anything but Google or
   * a loopback host is invalid (and falls back to Google). Production refuses the override.
   */
  GOOGLE_OAUTH_BASE: {
    schema: httpUrl(GOOGLE_OAUTH)
      .transform((u) => u.replace(/\/+$/, ''))
      .refine((u) => u === GOOGLE_OAUTH || LOOPBACK.has(new URL(u).hostname)),
    fallback: GOOGLE_OAUTH,
    expect: `${GOOGLE_OAUTH}, or a mock on a loopback host like http://127.0.0.1:4430`,
  } satisfies Setting<string>,
  // Logs and error tracking
  LOG_LEVEL: oneOf(LOG_LEVELS, undefined),
  /** Share of incoming web-vitals beacons (already sampled in the browser) that /api/rum logs; 0 turns it off. */
  RUM_LOG_RATE: { schema: z.coerce.number<string>().min(0).max(1), fallback: 1, expect: 'a number from 0 to 1' } satisfies Setting<number>,
  // Analytics and reader feedback (P3-2, docs/analytics.md)
  /** Share of consenting browsers whose /api/events beacons are logged (sampled by browser); 0 turns it off. */
  EVENTS_LOG_RATE: { schema: z.coerce.number<string>().min(0).max(1), fallback: 1, expect: 'a number from 0 to 1' } satisfies Setting<number>,
  /** Section votes, issue reports and notify-me; false refuses them all (503) without a rebuild. */
  FEEDBACK_ENABLED: flag(true),
  /** Issue reports accepted per day across all readers; 0 stops taking reports. */
  FEEDBACK_REPORTS_DAILY_CAP: int(500, 0, 100_000),
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

/** Strapi's base URL on the private network (http://localhost:1337 in dev), without a trailing slash. */
export const strapiUrl = (): string => serverEnv().STRAPI_URL;

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

/**
 * What stops billing from running as configured, or [] ([] too in a build without billing that
 * doesn't turn BILLING_ENABLED on). The webhook and reconciliation keep running while the kill
 * switch is off, so in a build with billing whatever Razorpay setting is set must be sound: the
 * secrets real, the key id's mode BILLING_MODE, and live mode against Razorpay itself. With
 * BILLING_ENABLED the keys are required too. (A webhook without a usable secret verifies nothing:
 * it refuses every call.)
 */
export function billingProblems(): string[] {
  const values = serverEnv();
  const enabled = values.BILLING_ENABLED;
  if (!FLAGS.billing && !enabled) return [];
  const out: string[] = [];
  const keyId = env('RAZORPAY_KEY_ID');
  if (!keyId) {
    if (enabled) out.push('RAZORPAY_KEY_ID is required when BILLING_ENABLED is true');
  } else {
    const mode = RAZORPAY_KEY_ID.exec(keyId)?.[1];
    if (mode && mode !== values.BILLING_MODE) out.push(`RAZORPAY_KEY_ID is a ${mode} key but BILLING_MODE is ${values.BILLING_MODE}`);
  }
  for (const name of ['RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_WEBHOOK_SECRET_PREV'] as const) {
    const required = enabled && name !== 'RAZORPAY_WEBHOOK_SECRET_PREV';
    const p = required || env(name) ? secretProblem(name, 16) : null;
    if (p) out.push(p);
  }
  if (values.BILLING_MODE === 'live' && values.RAZORPAY_API_BASE !== RAZORPAY_API) out.push(`RAZORPAY_API_BASE must be ${RAZORPAY_API} in live mode`);
  if (env('RAZORPAY_WEBHOOK_SECRET_PREV') && !values.RAZORPAY_WEBHOOK_SECRET_PREV_UNTIL) out.push('RAZORPAY_WEBHOOK_SECRET_PREV needs RAZORPAY_WEBHOOK_SECRET_PREV_UNTIL');
  return out;
}

/** What stops labs from running as configured, or [] (also [] in a build without labs that leaves LABS_ENABLED off). */
export function labsProblems(): string[] {
  const enabled = serverEnv().LABS_ENABLED;
  if (!FLAGS.labs && !enabled) return [];
  const out: string[] = [];
  if (enabled && !env('LABS_RUNNER_URL')) out.push('LABS_RUNNER_URL is required when LABS_ENABLED is true');
  const p = enabled || env('LABS_SECRET') ? secretProblem('LABS_SECRET', 32) : null;
  if (p) out.push(p);
  return out;
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
  // No silent fallback to a localhost CMS, and no placeholder or truncated tokens.
  if (!env('STRAPI_URL')) out.push('STRAPI_URL is required (the CMS on the private network)');
  const token = secretProblem('STRAPI_SERVER_TOKEN', 32);
  if (token) out.push(token);
  for (const optional of ['STRAPI_CONTENT_TOKEN', 'ANTHROPIC_API_KEY', 'BEDROCK_API_KEY', 'TURNSTILE_SECRET_KEY', 'DAILY_API_KEY', 'DEEPGRAM_API_KEY', 'CARTESIA_API_KEY', 'SARVAM_API_KEY', 'SMALLEST_API_KEY'] as const) {
    const p = env(optional) ? secretProblem(optional, 20) : null;
    if (p) out.push(p);
  }
  // The voice service's bearer is set with its URL, and real (the internal routes refuse every call without it).
  if (env('INTERVIEW_VOICE_URL') || env('INTERVIEW_VOICE_SECRET')) {
    const p = secretProblem('INTERVIEW_VOICE_SECRET', 32);
    if (p) out.push(p);
    if (!env('INTERVIEW_VOICE_URL')) out.push('INTERVIEW_VOICE_URL is required with INTERVIEW_VOICE_SECRET');
  }
  // With only the secret, registration demands a token that no widget on the page can issue
  // (turnstile.ts), so every sign-up is refused as a failed human check.
  if (env('TURNSTILE_SECRET_KEY') && !env('TURNSTILE_SITE_KEY')) out.push('TURNSTILE_SITE_KEY is required when TURNSTILE_SECRET_KEY is set');
  if (env('GOOGLE_CLIENT_ID')) {
    const p = secretProblem('GOOGLE_CLIENT_SECRET', 20);
    if (p) out.push(p);
    if (env('GOOGLE_OAUTH_BASE')) out.push('GOOGLE_OAUTH_BASE must be unset in production (it points Google sign-in at a mock)');
  }
  out.push(...billingProblems(), ...labsProblems());
  // The fake provider answers from fixtures without a key or a network call: never in production.
  if (values.AGENT_LAB_PROVIDER === 'fake') out.push('AGENT_LAB_PROVIDER=fake is for dev and tests only; production uses anthropic');
  // Lane spend counts toward the global breaker too: a lane budget at or over it could never bind,
  // and spending it would switch Ask and the interview off for the day as well.
  if ((FLAGS.agentLabs || values.AGENT_LAB_LIVE_ENABLED) && values.AGENT_LAB_DAILY_BUDGET_USD >= values.ASK_DAILY_BUDGET_USD) {
    out.push('AGENT_LAB_DAILY_BUDGET_USD must be less than ASK_DAILY_BUDGET_USD (the global breaker counts lab spend too)');
  }
  if (values.BILLING_ENABLED && values.BILLING_MODE === 'test' && !values.BILLING_ALLOW_TEST) {
    out.push('BILLING_MODE is test: a production server sells live (BILLING_MODE=live), or set BILLING_ALLOW_TEST=true on staging');
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
    for (const p of [...settingProblems(), ...billingProblems()]) console.warn(`[env] ${p} (see web/.env.example)`);
    checked = true;
    return;
  }
  const problems = productionProblems();
  if (problems.length) throw new Error(`Invalid production config (see web/.env.example): ${problems.join('; ')}`);
  checked = true;
}
