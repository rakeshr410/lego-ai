import type { AstroCookies } from 'astro';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearReaderCache, getReader, SessionUnavailable } from './session';

// Who a session belongs to, asked of the main site (session.ts): GET /api/internal/reader with the
// reader's cookie and the bearer.

const SECRET = 's'.repeat(40);
const SID = 'a'.repeat(43);
const reader = { id: 7, documentId: 'doc7doc7doc7', username: 'ada', email: 'ada@example.com', plan: 'pro', planExpiresAt: null };
const cookies = (value: string | undefined, name = 'sd_session') => ({ get: (n: string) => (n === name && value !== undefined ? { value } : undefined) }) as unknown as AstroCookies;
const fetchMock = vi.fn();
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  clearReaderCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('LEGO_AI_SECRET', SECRET);
  vi.stubEnv('WEB_INTERNAL_URL', 'http://web.internal:4321/');
  vi.stubEnv('PUBLIC_ORIGIN', '');
});
afterEach(() => vi.unstubAllGlobals());

describe('getReader', () => {
  it('asks nothing without a well-formed session cookie', async () => {
    expect(await getReader(cookies(undefined))).toBeNull();
    expect(await getReader(cookies('short'))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the cookie with the bearer and returns the reader', async () => {
    fetchMock.mockResolvedValueOnce(answer({ reader: { ...reader, extra: 'dropped' } }));
    expect(await getReader(cookies(SID))).toEqual(reader);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://web.internal:4321/api/internal/reader');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${SECRET}`, cookie: `sd_session=${SID}` });
  });

  it('reads the __Host- cookie on an https site', async () => {
    vi.stubEnv('PUBLIC_ORIGIN', 'https://arrowbox.example');
    fetchMock.mockResolvedValueOnce(answer({ reader }));
    expect(await getReader(cookies(SID, '__Host-sd_session'))).toEqual(reader);
    expect(fetchMock.mock.calls[0][1].headers.cookie).toBe(`__Host-sd_session=${SID}`);
  });

  it('caches an answer, and asks once for concurrent requests', async () => {
    fetchMock.mockResolvedValue(answer({ reader }));
    await Promise.all([getReader(cookies(SID)), getReader(cookies(SID))]);
    await getReader(cookies(SID));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for a session the main site doesn’t know', async () => {
    fetchMock.mockResolvedValueOnce(answer({ reader: null }));
    expect(await getReader(cookies(SID))).toBeNull();
  });

  it('throws SessionUnavailable when the main site is down, refuses, or the bearer is unset', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(getReader(cookies(SID))).rejects.toBeInstanceOf(SessionUnavailable);
    fetchMock.mockResolvedValueOnce(answer({ error: 'Not found' }, 404));
    await expect(getReader(cookies(SID))).rejects.toBeInstanceOf(SessionUnavailable);
    vi.stubEnv('LEGO_AI_SECRET', '');
    await expect(getReader(cookies(SID))).rejects.toBeInstanceOf(SessionUnavailable);
  });
});
