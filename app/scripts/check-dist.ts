import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogFromFiles } from '../src/lib/server/coaching/catalog.ts';
import { describeSnapshot, findLeakedBriefs, snapshotPaths } from '../src/lib/content-snapshot.node.ts';
import type { ContentSnapshot } from '../src/lib/content-snapshot.ts';

// node scripts/check-dist.ts   after a build: fail when an interview plan's private notes (the
//                              interviewer's briefs, the grader's brief, the items' probes), the
//                              whiteboard matcher's text, a tutor brief, or a coaching pack's
//                              notes (its teaching, answers and corrections) reached dist/client,
//                              which browsers get (they belong in the server bundle only). The
//                              same check the main site runs on its build (lego/web,
//                              scripts/content-snapshot.ts --check-dist).

const appDir = fileURLToPath(new URL('..', import.meta.url));
const { outFile } = snapshotPaths(appDir);

function textFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) textFiles(path, out);
    else if (/\.(?:js|mjs|html|json|css)$/.test(name)) out.push(path);
  }
  return out;
}

/** Pack notes in the browser build: each pack's teach lines, answers and corrections are the coach's alone. */
function leakedPackNotes(clientDir: string): string[] {
  const root = join(appDir, 'coaching');
  const files: Record<string, string> = {};
  for (const path of walkYaml(root)) files[relative(root, path)] = readFileSync(path, 'utf8');
  const notes = [...catalogFromFiles(files).packs.values()].flatMap((p) => p.beats.flatMap((b) => [...b.teach, ...(b.answer ? [b.answer] : []), ...(b.misconceptions ?? [])]).map((text) => [p.id, text] as const));
  const shipped = textFiles(clientDir).map((path) => readFileSync(path, 'utf8'));
  return notes.filter(([, text]) => text.length >= 40 && shipped.some((s) => s.includes(text))).map(([id, text]) => `coaching pack ${id}: "${text.slice(0, 60)}…"`);
}

function walkYaml(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkYaml(path, out);
    else if (name.endsWith('.yaml')) out.push(path);
  }
  return out;
}

try {
  const snapshot = JSON.parse(readFileSync(outFile, 'utf8')) as ContentSnapshot;
  const leaks = [...findLeakedBriefs(snapshot, `${appDir}/dist/client`), ...leakedPackNotes(`${appDir}/dist/client`)];
  if (leaks.length) {
    console.error(`Server-only text in the browser build:\n${leaks.join('\n')}`);
    process.exit(1);
  }
  console.log(`dist/client carries no private interview notes, tutor briefs or coaching notes (${describeSnapshot(snapshot)})`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
