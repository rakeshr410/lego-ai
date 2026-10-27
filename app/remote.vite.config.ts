import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Manifest, type Plugin } from 'vite';
import { uiLocaleDefine } from './src/i18n/locales.ts';
import { CONTRACT } from './src/remote/contract.ts';
import { ASSETS_DIR } from './routes.mjs';

// The interview and the classroom as microfrontends (src/remote/): ES modules the site's shell
// (lego/web src/lib/remote.ts) imports from this app's deploy and mounts in its own pages, so moving
// between reading, the classroom and an interview stays in one page. Each module brings its own
// React: the shell's and this one never touch (each renders only into its own elements), and
// neither app's React upgrade waits on the other's.
//
// Built after astro build (npm run build) into the assets folder this app serves,
// dist/client/_ai/remote/; in dev (npm run dev:remote, a watch build) into public/_ai/remote/,
// which the dev server serves at the same path. Every file has a content hash (the CDN caches
// /_ai/ for a year); manifest.json names each module's entry and stylesheets, and
// /api/interview/page passes them to the shell.

const appDir = fileURLToPath(new URL('.', import.meta.url));
const MODULES = { interview: 'src/remote/interview.tsx', classroom: 'src/remote/classroom.tsx' } as const;
const base = `/${ASSETS_DIR}/remote/`;

/** manifest.json from Vite's own: per module, its entry and every stylesheet its static imports bring. */
function remoteManifest(voice: boolean): Plugin {
  let dir = '';
  return {
    name: 'arrowbox:remote-manifest',
    apply: 'build',
    writeBundle(options) {
      dir = options.dir!;
    },
    closeBundle() {
      if (!dir) return;
      const vite = JSON.parse(readFileSync(join(dir, '.vite', 'manifest.json'), 'utf8')) as Manifest;
      const cssOf = (key: string, seen = new Set<string>()): string[] => {
        if (seen.has(key)) return [];
        seen.add(key);
        const chunk = vite[key];
        return [...(chunk.css ?? []), ...(chunk.imports ?? []).flatMap((k) => cssOf(k, seen))];
      };
      const modules = Object.fromEntries(
        Object.entries(MODULES).map(([name, src]) => [name, { js: base + vite[src].file, css: [...new Set(cssOf(src))].map((f) => base + f) }]),
      );
      // `voice`: the room joins calls (Daily), so the shell's page needs the voice room's policy.
      writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ contract: CONTRACT, modules, voice, builtAt: new Date().toISOString() }, null, 2)}\n`);
      rmSync(join(dir, '.vite'), { recursive: true, force: true });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, appDir, 'PUBLIC_'), ...process.env };
  const outDir = mode === 'development' ? `public/${ASSETS_DIR}/remote` : `dist/client/${ASSETS_DIR}/remote`;
  return {
    root: appDir,
    base,
    envPrefix: 'PUBLIC_',
    publicDir: false,
    define: uiLocaleDefine(env.PUBLIC_UI_LOCALE),
    // As in astro.config.mjs: the Mermaid dialog's 1.5 MB stays out (src/lib/board/no-mermaid.ts).
    resolve: { alias: { '@excalidraw/mermaid-to-excalidraw': fileURLToPath(new URL('./src/lib/board/no-mermaid.ts', import.meta.url)) } },
    plugins: [react(), remoteManifest(env.PUBLIC_INTERVIEW_VOICE_ENABLED === 'true')],
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2022',
      manifest: true,
      // The room's whiteboard (Excalidraw) is over a megabyte; it loads only once a room opens.
      chunkSizeWarningLimit: 2048,
      rolldownOptions: {
        input: Object.fromEntries(Object.entries(MODULES).map(([name, src]) => [name, join(appDir, src)])),
        // No page: the entries are modules the shell imports, so they keep their exports.
        preserveEntrySignatures: 'exports-only',
      },
    },
  };
});
