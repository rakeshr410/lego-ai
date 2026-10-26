import { planOf, type PlanFields } from '../entitlements';
import { serverEnv } from '../env';
import { getStore } from '../store';
import { fail } from './service';

// Early access (docs/README.md "Rollout"; design phase 3). While an allowlist is set, only
// the readers on it, and staff, may start a mock interview; everyone else sees the landing with an
// early-access note (InterviewStatus.reason 'access'). The list is INTERVIEW_ALLOWLIST (emails,
// comma-separated) plus the store's (`interview:allowlist`, a JSON array of emails written by
// scripts/interview-switch.mjs `allow add|remove|clear`, so seats open without a redeploy). Both
// empty: open to every signed-in reader. Cached 5 s, like the switch. The store being unreachable
// leaves the environment's list in force, never opens the door.

export const ALLOWLIST_KEY = 'interview:allowlist';
const CACHE_MS = 5_000;
let cache: { at: number; list: Set<string> } | null = null;

/** Forgets the cached list (tests only). */
export const resetAccessCache = () => {
  cache = null;
};

const normalise = (email: unknown) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

async function allowlist(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  const list = new Set((serverEnv().INTERVIEW_ALLOWLIST ?? '').split(',').map(normalise).filter(Boolean));
  try {
    const raw = await (await getStore()).get(ALLOWLIST_KEY);
    if (raw) for (const e of JSON.parse(raw) as unknown[]) if (normalise(e)) list.add(normalise(e));
  } catch (err) {
    console.error('[interview] allowlist unreadable:', (err as Error).message);
  }
  cache = { at: Date.now(), list };
  return list;
}

export type Access = {
  /** No allowlist: every signed-in reader may start. */
  open: boolean;
  /** This reader may start (open, staff, or listed). */
  allowed: boolean;
};

type Who = PlanFields & { email: string };

/** Whether the interview is open to everyone, and whether this reader may start one (nobody signed in: only when open). */
export async function interviewAccess(reader: Who | null): Promise<Access> {
  const list = await allowlist();
  const open = list.size === 0;
  if (!reader) return { open, allowed: open };
  return { open, allowed: open || planOf(reader) === 'staff' || list.has(normalise(reader.email)) };
}

/** Throws `access` (403) unless the reader may start a mock interview. */
export async function assertAccess(reader: Who): Promise<void> {
  if (!(await interviewAccess(reader)).allowed) throw fail('access', 403, 'Mock interviews are in early access. You’ll be able to start one when more seats open.');
}
