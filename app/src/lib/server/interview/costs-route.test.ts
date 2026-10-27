import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '../../../pages/api/internal/interview/costs';
import { getStore } from '../store';

// The internal costs report (scripts/session-costs.ts --url): every session in the store, read by a scan,
// behind LEGO_AI_SECRET.

const SECRET = 'costs-test-secret-0123456789abcdef';
const call = (query: string, auth = `Bearer ${SECRET}`) => {
  const url = new URL(`http://app/api/internal/interview/costs?${query}`);
  return GET({ request: new Request(url, { headers: { authorization: auth } }), url } as never) as Promise<Response>;
};

afterEach(() => {
  delete process.env.LEGO_AI_SECRET;
});

describe('the costs report', () => {
  it('is a 404 without the secret, and lists the store’s sessions by service with it', async () => {
    process.env.LEGO_AI_SECRET = SECRET;
    const now = new Date().toISOString();
    const store = await getStore();
    await store.set(
      `interview:session:${'f'.repeat(24)}`,
      JSON.stringify({ id: 'f'.repeat(24), readerId: 'reader9', system: 'frontend-foundations', kind: 'coach', mode: 'voice', course: { lesson: 'news-feed' }, status: 'finished', startedAt: now, updatedAt: now, costUsd: 0.5, spend: { 'claude reply': 0.3, 'tts smallest': 0.2 } }),
      60_000,
    );
    expect((await call('days=1', 'Bearer wrong')).status).toBe(404);
    const json = await (await call('days=1&format=json')).json();
    expect(json.sessions).toEqual([expect.objectContaining({ readerId: 'reader9', totalUsd: 0.5, groups: expect.objectContaining({ claude: 0.3, tts: 0.2 }) })]);
    expect(await (await call('days=1&detail=1')).text()).toContain('tts smallest');
    expect((await call('reader=bad id')).status).toBe(400);
  });
});
