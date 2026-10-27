import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIContext } from 'astro';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/interview/page (pages/api/interview/page.ts): what the site's shell mounts at a path,
// the module and its props from this app's pages, its files from the remote build's manifest.

const flags = { interview: true };
const system = { slug: 'amazon', name: 'Amazon-style app' };
const interviewPage = { system, title: 'Design Amazon', minutes: 45, stages: [] };
const playlist = { slug: 'amazon-storefront', title: 'Design Amazon, on the whiteboard', lessons: [{ slug: 'listing' }] };
const lesson = { system, title: 'Listing: scope', minutes: 24, course: { playlist: 'amazon-storefront', lesson: 'listing' } };

const manifest = {
  contract: 1,
  modules: {
    interview: { js: '/_ai/remote/assets/interview-a.js', css: ['/_ai/remote/assets/contract-c.css'] },
    classroom: { js: '/_ai/remote/assets/classroom-b.js', css: [] },
  },
  voice: true,
};

let dir = '';

async function get(path: string | null) {
  vi.resetModules();
  vi.doMock('../../flags', () => ({ FLAGS: flags }));
  vi.doMock('../../interview.node', () => ({
    getInterviewPages: vi.fn(async () => [interviewPage]),
    getPlaylistPages: vi.fn(async () => [playlist]),
    lessonPage: vi.fn(async (p: string, l: string) => (p === 'amazon-storefront' && l === 'listing' ? lesson : null)),
  }));
  const { GET } = await import('../../../pages/api/interview/page');
  const url = new URL('http://lego-ai.internal/api/interview/page');
  if (path !== null) url.searchParams.set('path', path);
  const res = (await GET({ url } as unknown as APIContext)) as Response;
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  flags.interview = true;
  dir = mkdtempSync(join(tmpdir(), 'page-route-'));
  mkdirSync(join(dir, 'public', '_ai', 'remote'), { recursive: true });
  writeFileSync(join(dir, 'public', '_ai', 'remote', 'manifest.json'), JSON.stringify(manifest));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('GET /api/interview/page', () => {
  it('mounts the interview at a system’s interview path, with the module’s files and the voice policy', async () => {
    const { status, body } = await get('/systems/amazon/interview');
    expect(status).toBe(200);
    expect(body.contract).toBe(1);
    expect(body.remote).toEqual({ ...manifest.modules.interview, voice: true });
    expect(body.view).toMatchObject({ module: 'interview', props: { page: interviewPage } });
  });

  it('mounts the classroom at a playlist, with the voice policy: the router may go on into a lesson', async () => {
    const { body } = await get('/coach/amazon-storefront/');
    expect(body.remote).toEqual({ ...manifest.modules.classroom, voice: true });
    expect(body.view).toMatchObject({ module: 'classroom', props: { kind: 'playlist', page: playlist }, title: playlist.title });
  });

  it('mounts the classroom at a lesson', async () => {
    const { body } = await get('/coach/amazon-storefront/listing');
    expect(body.remote.voice).toBe(true);
    expect(body.view).toMatchObject({ module: 'classroom', props: { kind: 'lesson', page: lesson } });
  });

  it.each([['/systems/nothing/interview'], ['/coach/nothing'], ['/coach/amazon-storefront/nothing'], ['/systems/amazon'], ['systems/amazon/interview'], [null]])(
    'is 404 for %s',
    async (path) => {
      expect((await get(path)).status).toBe(404);
    },
  );

  it('is 404 for every path with the interview off', async () => {
    flags.interview = false;
    expect((await get('/systems/amazon/interview')).status).toBe(404);
  });

  it('is 503 before the modules are built', async () => {
    rmSync(join(dir, 'public'), { recursive: true });
    expect((await get('/systems/amazon/interview')).status).toBe(503);
  });
});
