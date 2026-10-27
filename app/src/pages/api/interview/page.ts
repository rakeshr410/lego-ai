import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRoute } from 'astro';
import { FLAGS } from '../../../lib/flags';
import { json } from '../../../lib/server/http';
import { getInterviewPages, getPlaylistPages, lessonPage } from '../../../lib/interview.node';
import { INTL_LOCALE } from '../../../i18n';
import t from '../../../i18n/messages/interview';
import type { RemoteView } from '../../../remote/contract';

export const prerender = false;

// GET /api/interview/page?path=<a page path>: what the site's shell (lego/web) renders at that path
// from this app, a module's name and props (src/remote/contract.ts), the page's title, and the
// module's files: its entry and stylesheets (remote.vite.config.ts manifest.json). The shell asks on
// the server when it renders the page, so its links and the reader's tab switches stay in one page.
//
//   /systems/<system>/interview   the interview module, the system's interview
//   /coach/<playlist>             the classroom module, the playlist's page
//   /coach/<playlist>/<lesson>    the classroom module, the lesson
//
// 404 for any other path, and for every path with PUBLIC_INTERVIEW_ENABLED off. Public data, the
// pages the shell built before were prerendered from the same; the shell caches it briefly.

type RemoteFiles = { js: string; css: string[] };
type Manifest = { contract: number; modules: Record<RemoteView['module'], RemoteFiles>; voice?: boolean };

let manifest: Manifest | null = null;
/** The remote's manifest.json (remote.vite.config.ts): public/ in dev (npm run dev:remote), the build's otherwise. */
function remoteManifest(): Manifest | null {
  if (manifest && !import.meta.env.DEV) return manifest;
  const file = join(process.cwd(), import.meta.env.DEV ? 'public' : 'dist/client', '_ai', 'remote', 'manifest.json');
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  } catch {
    manifest = null;
  }
  return manifest;
}

async function viewAt(path: string): Promise<RemoteView | null> {
  const parts = path.replace(/\/+$/, '').split('/').slice(1).map(decodeURIComponent);
  if (parts[0] === 'systems' && parts.length === 3 && parts[2] === 'interview') {
    const page = (await getInterviewPages()).find((p) => p.system.slug === parts[1]);
    if (!page) return null;
    return {
      module: 'interview',
      props: { page },
      title: t('meta.title', { system: page.system.name }),
      description: t('meta.description', { minutes: page.minutes, title: page.title.toLocaleLowerCase(INTL_LOCALE) }),
    };
  }
  if (parts[0] === 'coach' && parts.length === 2) {
    const page = (await getPlaylistPages()).find((p) => p.slug === parts[1]);
    if (!page) return null;
    return { module: 'classroom', props: { kind: 'playlist', page }, title: page.title, description: t('playlist.meta.description', { count: page.lessons.length, title: page.title }) };
  }
  if (parts[0] === 'coach' && parts.length === 3) {
    const page = await lessonPage(parts[1], parts[2]);
    if (!page) return null;
    return {
      module: 'classroom',
      props: { kind: 'lesson', page },
      title: t('lesson.meta.title', { lesson: page.title, playlist: page.system.name }),
      description: t('lesson.meta.description', { minutes: page.minutes, title: page.title }),
    };
  }
  return null;
}

export const GET: APIRoute = async ({ url }) => {
  const path = url.searchParams.get('path') ?? '';
  if (!FLAGS.interview || !path.startsWith('/')) return json({ error: 'Not found' }, 404);
  const remote = remoteManifest();
  if (!remote) return json({ error: 'The interview modules are not built (npm run build, or npm run dev:remote)' }, 503);
  const view = await viewAt(path);
  if (!view) return json({ error: 'Not found' }, 404);
  // `voice`: a voice build, so the page needs the voice room's policy (Daily's hosts, the
  // microphone), which the shell sends: on a playlist's page too, which the client router may move
  // on from into a lesson's room, keeping its policy.
  return json({ contract: remote.contract, remote: { ...remote.modules[view.module], voice: remote.voice === true }, view }, 200, { 'Cache-Control': 'public, max-age=60' });
};
