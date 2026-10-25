// Excalidraw's fonts for the interview whiteboard (docs/interview/README.md, "Whiteboard").
//
// The canvas (components/sd/ExcalidrawCanvas.tsx) loads its fonts from this site, not from
// Excalidraw's CDN: window.EXCALIDRAW_ASSET_PATH points at /excalidraw/, and this script copies
// node_modules/@excalidraw/excalidraw/dist/prod/fonts there (public/excalidraw/, git-ignored).
// Runs in predev/prebuild, like copy-pyodide.mjs. The CJK family (Xiaolai, 12 MB) is left out:
// the interview is in English; a candidate typing CJK falls back to a system font.
//
//   node scripts/copy-excalidraw.mjs            copy when missing or built from another version
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('..', import.meta.url));
const pkgDir = join(web, 'node_modules', '@excalidraw', 'excalidraw');
export const OUT_DIR = join(web, 'public', 'excalidraw');
const SKIP = new Set(['Xiaolai']);

export function excalidrawVersion() {
  return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
}

export function copyExcalidrawAssets() {
  const version = excalidrawVersion();
  const stamp = join(OUT_DIR, 'VERSION');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === version && existsSync(join(OUT_DIR, 'fonts'))) return { version, copied: false };
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(join(OUT_DIR, 'fonts'), { recursive: true });
  const src = join(pkgDir, 'dist', 'prod', 'fonts');
  for (const family of readdirSync(src)) {
    if (SKIP.has(family)) continue;
    cpSync(join(src, family), join(OUT_DIR, 'fonts', family), { recursive: true });
  }
  writeFileSync(stamp, `${version}\n`);
  return { version, copied: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { version, copied } = copyExcalidrawAssets();
  console.log(`${copied ? 'Copied' : 'Kept'} Excalidraw ${version} fonts in public/excalidraw/`);
}
