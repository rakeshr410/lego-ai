import { FLAGS } from '../flags';
import { freeInFull, type FreeTier } from '../free-tier';
import { serverEnv } from './env';

// What each reader may do, by plan: the one place entitlements are decided (P3-8, PRODUCT-5).
//
// The plan lives on the Strapi user (`plan`, `planExpiresAt`; cms/src/extensions/users-permissions)
// and rides along in the reader's session, refreshed from Strapi at most a minute after it
// changes. Staff set it in the admin today; billing, when it comes, only has to write those two
// fields (e.g. from a payment provider's webhook) and everything here follows. Nothing in this
// module talks to a payment provider.
//
// Callers ask this module, never the plan name: `entitlementsOf(reader).askDailyQuota`, not
// `plan === 'pro' ? ...`, so a new plan or a changed allowance is a change here alone.

export const PLANS = ['free', 'pro', 'staff'] as const;
export type Plan = (typeof PLANS)[number];

/** The plan fields as Strapi returns them on the user; missing on sessions from before them. */
export type PlanFields = { plan?: string | null; planExpiresAt?: string | null };

export type Entitlements = {
  plan: Plan;
  /** Shown on the account page. */
  label: string;
  /** Ask mode (questions answered by Claude). */
  ask: boolean;
  /** Questions per UTC day. */
  askDailyQuota: number;
  /** Lab sessions in total (lifetime) before the plan's allowance runs out; null: unlimited (paid plans). */
  labFreeSessions: number | null;
  /** Live-model tokens (input + output) per UTC day in agent labs (agent-labs/proxy.ts); 0: live runs are off, practice on the simulated model. */
  agentLabDailyTokens: number;
  /** When a paid plan lapses back to free (ISO date-time), or null when it doesn't. */
  expiresAt: string | null;
};

const isPlan = (v: unknown): v is Plan => typeof v === 'string' && (PLANS as readonly string[]).includes(v);

/**
 * The plan in force for these fields at `now`: an unknown or missing plan is free, and a plan
 * whose planExpiresAt has passed has lapsed to free.
 */
export function planOf(fields: PlanFields | null | undefined, now = Date.now()): Plan {
  const plan = fields?.plan;
  if (!isPlan(plan) || plan === 'free') return 'free';
  const until = fields?.planExpiresAt ? Date.parse(fields.planExpiresAt) : NaN;
  if (fields?.planExpiresAt && (!Number.isFinite(until) || until <= now)) return 'free';
  return plan;
}

const LABELS: Record<Plan, string> = { free: 'Free', pro: 'Pro', staff: 'Staff' };

/**
 * Whether the free tier's limits apply (Phase 4, decision 2): in any build with billing
 * (PUBLIC_BILLING, which builds the Free variants of the topic pages and the pricing page whose
 * Free card states them). BILLING_ENABLED doesn't enter into it: it is the kill switch for
 * checkout, verify and cancel only, and turning it off in an incident must not open every design to
 * every Free reader, or make the Free card claim a limit the server isn't applying.
 */
export function freeTierEnforced(): boolean {
  return FLAGS.billing;
}

/** The allowances of a plan. Quotas are settings (ASK_DAILY_QUOTA*, web/.env.example). */
export function entitlementsFor(plan: Plan): Omit<Entitlements, 'expiresAt'> {
  const s = serverEnv();
  const askDailyQuota = { free: s.ASK_DAILY_QUOTA, pro: s.ASK_DAILY_QUOTA_PRO, staff: s.ASK_DAILY_QUOTA_STAFF }[plan];
  const agentLabDailyTokens = { free: s.AGENT_LAB_DAILY_TOKENS, pro: s.AGENT_LAB_DAILY_TOKENS_PRO, staff: s.AGENT_LAB_DAILY_TOKENS_STAFF }[plan];
  return {
    plan,
    label: LABELS[plan],
    ask: askDailyQuota > 0,
    askDailyQuota,
    labFreeSessions: plan === 'free' ? s.LABS_FREE_SESSIONS : null,
    agentLabDailyTokens,
  };
}

/**
 * Which designs a plan reads in full: 'all', or the free tier of the price catalog this server was
 * built with (content/pricing.yaml): its fullTopics in full, and only the previewSections of every
 * other one (lib/free-tier.ts). 'all' without a catalog too: then there is no plan to sell.
 */
export async function topicsFor(plan: Plan): Promise<'all' | FreeTier> {
  if (plan !== 'free' || !freeTierEnforced()) return 'all';
  // Loaded the way sd.ts loads it, so the bundler keeps one copy of the snapshot, out of the
  // middleware's static graph.
  const { getSnapshot } = await import('../content-snapshot');
  const free = getSnapshot().pricing?.free;
  return free ? { fullTopics: free.fullTopics, previewSections: free.previewSections, publicSystems: free.publicSystems ?? [] } : 'all';
}

/**
 * Whether a reader with these topics (topicsFor) reads `topic` (`<system>/<topic>`) in full; when
 * not, they get the free tier's cut of it (lib/free-tier.ts), on the page (lib/server/gate.ts), in
 * Ask's grounding and in what the learner model records.
 */
export function readsInFull(topics: 'all' | FreeTier, topic: string): boolean {
  return topics === 'all' || freeInFull(topics, topic);
}

/** A reader's entitlements from their plan fields (null: nobody signed in, the free allowances). */
export function entitlementsOf(fields: PlanFields | null | undefined, now = Date.now()): Entitlements {
  const plan = planOf(fields, now);
  return { ...entitlementsFor(plan), expiresAt: plan !== 'free' && fields?.planExpiresAt ? fields.planExpiresAt : null };
}
