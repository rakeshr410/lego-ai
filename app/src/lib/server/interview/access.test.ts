import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Early access: the allowlist from the environment and the store, staff always in, open when both are empty.

const { store } = vi.hoisted(() => {
  const map = new Map<string, string>();
  return { store: { map, get: async (k: string) => (k === 'boom' ? Promise.reject(new Error('down')) : (map.get(k) ?? null)), fail: false } };
});
vi.mock('../store', () => ({
  getStore: async () => {
    if (store.fail) throw new Error('redis down');
    return store;
  },
}));

const access = await import('./access');

const PRO = { email: 'Ada@Example.com', plan: 'pro', planExpiresAt: null };
const STAFF = { email: 'ops@arrowbox.in', plan: 'staff', planExpiresAt: null };
const FREE = { email: 'bob@example.com', plan: 'free', planExpiresAt: null };

beforeEach(() => {
  store.map.clear();
  store.fail = false;
  vi.unstubAllEnvs();
  access.resetAccessCache();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());

describe('interview access', () => {
  it('is open to every signed-in reader while no list is set', async () => {
    expect(await access.interviewAccess(FREE)).toEqual({ open: true, allowed: true });
    expect(await access.interviewAccess(null)).toEqual({ open: true, allowed: true });
    await expect(access.assertAccess(FREE)).resolves.toBeUndefined();
  });

  it('admits the environment’s emails, case and spaces aside, and staff; refuses the rest with 403', async () => {
    vi.stubEnv('INTERVIEW_ALLOWLIST', ' ada@example.com , carol@example.com');
    expect(await access.interviewAccess(PRO)).toEqual({ open: false, allowed: true });
    expect(await access.interviewAccess(STAFF)).toEqual({ open: false, allowed: true });
    expect(await access.interviewAccess(FREE)).toEqual({ open: false, allowed: false });
    expect(await access.interviewAccess(null)).toEqual({ open: false, allowed: false });
    await expect(access.assertAccess(FREE)).rejects.toMatchObject({ code: 'access', status: 403 });
  });

  it('adds the store’s list to the environment’s, and re-reads it after the cache', async () => {
    vi.stubEnv('INTERVIEW_ALLOWLIST', 'carol@example.com');
    vi.useFakeTimers();
    try {
      expect((await access.interviewAccess(PRO)).allowed).toBe(false);
      store.map.set(access.ALLOWLIST_KEY, JSON.stringify(['ADA@example.com ']));
      expect((await access.interviewAccess(PRO)).allowed).toBe(false); // cached
      vi.advanceTimersByTime(6_000);
      expect((await access.interviewAccess(PRO)).allowed).toBe(true);
      expect((await access.interviewAccess({ ...FREE, email: 'carol@example.com' })).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the environment’s list in force when the store is unreachable or unreadable', async () => {
    vi.stubEnv('INTERVIEW_ALLOWLIST', 'ada@example.com');
    store.fail = true;
    expect(await access.interviewAccess(FREE)).toEqual({ open: false, allowed: false });
    expect((await access.interviewAccess(PRO)).allowed).toBe(true);
    access.resetAccessCache();
    store.fail = false;
    store.map.set(access.ALLOWLIST_KEY, 'not json');
    expect((await access.interviewAccess(FREE)).allowed).toBe(false);
    expect((await access.interviewAccess(PRO)).allowed).toBe(true);
  });
});
