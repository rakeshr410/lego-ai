import { serverEnv } from './env';

// What each reader may do, by plan (a copy of lego/web's entitlements.ts, cut to what the
// interview and the model gateway ask: the plan in force, and Ask's daily quota the gateway checks).
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

/** The allowances of a plan. Quotas are settings (ASK_DAILY_QUOTA*, app/.env.example). */
export function entitlementsFor(plan: Plan): Omit<Entitlements, 'expiresAt'> {
  const s = serverEnv();
  const askDailyQuota = { free: s.ASK_DAILY_QUOTA, pro: s.ASK_DAILY_QUOTA_PRO, staff: s.ASK_DAILY_QUOTA_STAFF }[plan];
  return {
    plan,
    label: LABELS[plan],
    ask: askDailyQuota > 0,
    askDailyQuota,
  };
}

/** A reader's entitlements from their plan fields (null: nobody signed in, the free allowances). */
export function entitlementsOf(fields: PlanFields | null | undefined, now = Date.now()): Entitlements {
  const plan = planOf(fields, now);
  return { ...entitlementsFor(plan), expiresAt: plan !== 'free' && fields?.planExpiresAt ? fields.planExpiresAt : null };
}
