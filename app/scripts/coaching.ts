import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { catalogFromFiles } from '../src/lib/server/coaching/catalog.ts';
import { coachingSectionHash, sectionBlocksOf } from '../src/lib/server/coaching/hash.ts';
import { packRef } from '../src/lib/server/coaching/schema.ts';
import { readOwnArticles, snapshotPaths, writeSnapshot } from '../src/lib/content-snapshot.node.ts';
import { loadContent } from '@arrowbox/content-kit/node';
import { formatLint, lintTopic } from '@arrowbox/content-kit';

// The coaching material's tool (docs/coaching.md). The packs are drafted by Claude and reviewed
// by people; this is how a pack is drafted, checked and kept in step with the article.
//
//   node scripts/coaching.ts check            every file against the schema and each other, and
//                                             every pack against the article it was written from
//                                             (stale: the section changed; missing: it is gone).
//                                             Exits 1 on an invalid file or a missing section;
//                                             --strict also on a stale pack.
//   node scripts/coaching.ts articles         lego-ai's own articles (app/articles) checked as content/'s
//                                             topics are, then the snapshot rebuilt with them (exits 1
//                                             when one is skipped)
//   node scripts/coaching.ts hash <pack id>   the section's current hash (<system>/<topic>/<sectionKey>, or
//                                             backend/<system>/<topic>/<sectionKey> for a backend article)
//   node scripts/coaching.ts stamp <pack id>  after rereading the section and fixing the pack:
//                                             records the section's current hash in the pack
//   node scripts/coaching.ts draft <pack id> [--after <pack id>] [--keep id,id] [--force]
//                                             asks Claude for a first draft of the section's pack
//                                             (review.status draft, provenance ai-drafted), checked
//                                             before it is written; a person reviews it in the PR.
//                                             Needs ANTHROPIC_API_KEY; COACHING_MODEL picks the model.
//
// The article comes from the content snapshot (.content/snapshot.json, written by `astro sync`).

const appDir = fileURLToPath(new URL('..', import.meta.url));
const root = join(appDir, 'coaching');
const DRAFT_MODEL = process.env.COACHING_MODEL || 'claude-opus-5-5';

type Topic = { system: string; slug: string; title: string; content?: { __component?: string; key?: string }[] };

function files(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.yaml')) out[relative(root, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return out;
}

function topics(): Topic[] {
  const { outFile } = snapshotPaths(appDir);
  if (!existsSync(outFile)) throw new Error(`No content snapshot at ${outFile}: run \`npx astro sync\` first.`);
  const snap = JSON.parse(readFileSync(outFile, 'utf8')) as { topics: Topic[]; backendTopics?: Topic[] };
  // Backend articles under their pack ids' system, backend/<system> (packRef).
  return [...snap.topics, ...(snap.backendTopics ?? []).map((t) => ({ ...t, system: `backend/${t.system}` }))];
}

function section(id: string): { topic: Topic; key: string; hash: string } {
  const { system, topic: slug, sectionKey: key } = packRef(id);
  const topic = topics().find((t) => t.system === system && t.slug === slug);
  if (!topic) throw new Error(`No topic ${system}/${slug} in the snapshot.`);
  const hash = coachingSectionHash(topic.content ?? [], key ?? '');
  if (!hash) throw new Error(`No section "${key}" in ${system}/${slug}.`);
  return { topic, key, hash };
}

const packPath = (id: string) => join(root, 'packs', `${id}.yaml`);

function check(strict: boolean): number {
  const all = files();
  const c = catalogFromFiles(all);
  const all_topics = topics();
  const problems = [...c.errors];
  const stale: string[] = [];
  for (const [id, p] of c.packs) {
    const { system, topic: slug, sectionKey: key } = packRef(id);
    const t = all_topics.find((x) => x.system === system && x.slug === slug);
    const hash = t ? coachingSectionHash(t.content ?? [], key) : null;
    if (!hash) problems.push(`packs/${id}.yaml: the section is not in the content (${system}/${slug}#${key})`);
    else if (hash !== p.source.hash) stale.push(`packs/${id}.yaml: stale (written from ${p.source.hash}, the section is now ${hash}): reread it, then \`node scripts/coaching.ts stamp ${id}\``);
  }
  for (const line of problems) console.error(line);
  for (const line of stale) (strict ? console.error : console.warn)(line);
  const drafts = [...c.packs.values()].filter((p) => p.review.status !== 'reviewed').length;
  console.log(`${c.packs.size} packs (${drafts} drafts, ${stale.length} stale), ${c.playlists.size} playlists, ${[...c.playlists.values()].reduce((n, p) => n + p.lessons.length, 0)} lessons`);
  return problems.length || (strict && stale.length) ? 1 : 0;
}

function stamp(id: string) {
  const path = packPath(id);
  if (!existsSync(path)) throw new Error(`No pack at ${path}`);
  const { hash } = section(id);
  // Only the hash line changes, so the pack keeps its layout; quoted, since a hash of digits only would read as a number.
  const text = readFileSync(path, 'utf8');
  const line = /^(source:\s*\n\s+hash:\s*).*$/m;
  if (!line.test(text)) throw new Error(`${path}: no source.hash line to restamp (expected "source:" then "  hash: ...")`);
  writeFileSync(path, text.replace(line, `$1"${hash}"`));
  console.log(`${id}: source.hash ${hash}`);
}

async function draft(id: string, after: string | null, keep: string[], force: boolean) {
  const path = packPath(id);
  if (existsSync(path) && !force) throw new Error(`${path} exists (--force to replace it)`);
  const { topic, key, hash } = section(id);
  const blocks = sectionBlocksOf(topic.content ?? [], key);
  const guide = readFileSync(join(appDir, '..', 'docs', 'coaching.md'), 'utf8');
  const all = files();
  const example = Object.entries(all).find(([p]) => p.startsWith('packs/'))?.[1] ?? '';
  const before = after ? all[`packs/${after}.yaml`] : '';
  if (after && !before) throw new Error(`No pack ${after} to continue.`);
  const client = new Anthropic();
  const prompt = [
    `Draft the coaching pack for the article section below, following the guide's format exactly. Teach what the section says; never contradict it, and put nothing in the pack the section does not support. Write in your own words (no sentences copied from anywhere). Plan the board as a picture a teacher would draw: regions for the big parts, boxes inside them, arrows with short words, on the grid, nothing overlapping.`,
    `The pack's id is ${id}; source.hash is ${hash}; review: {status: draft, provenance: ai-drafted, author: ${process.env.COACHING_AUTHOR || 'claude'}}.`,
    after ? `It continues the pack ${after} (context.after), whose board it builds on; board.keep: [${keep.join(', ')}].` : `It starts a fresh board (context.after: null, board.keep: []).`,
    `<guide>\n${guide}\n</guide>`,
    example ? `<example-pack>\n${example}\n</example-pack>` : '',
    before ? `<previous-pack>\n${before}\n</previous-pack>` : '',
    `<section topic="${topic.system}/${topic.slug}" title="${topic.title}" key="${key}">\n${JSON.stringify(blocks)}\n</section>`,
    `Answer with the YAML file only, no code fence.`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const res = await client.messages.create({ model: DRAFT_MODEL, max_tokens: 16000, messages: [{ role: 'user', content: prompt }] });
  const text = res.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('')
    .replace(/^```(?:yaml)?\n|\n```\s*$/g, '');
  const c = catalogFromFiles({ ...all, [`packs/${id}.yaml`]: text });
  const mine = c.errors.filter((e) => e.startsWith(`packs/${id}.yaml`));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(mine.length ? `${path}.rejected` : path, text);
  if (mine.length) throw new Error(`The draft does not check (kept at ${path}.rejected):\n${mine.join('\n')}`);
  console.log(`${path}: drafted; review it against the section before it is merged.`);
}

function articles(): number {
  const { contentDir, articlesDir, outFile } = snapshotPaths(appDir);
  const { catalog } = loadContent(contentDir);
  const own = readOwnArticles(articlesDir, catalog.systems, new Set(catalog.topics.map((t) => `${t.system}/${t.slug}`)));
  for (const list of own.problems.values()) for (const line of list) console.error(line);
  for (const t of own.topics) {
    const groups = catalog.systems.find((x) => x.slug === t.system)?.groups;
    const warnings = lintTopic(t.data, { groups }).filter((i) => i.severity !== 'error');
    if (warnings.length) console.warn(formatLint(warnings.map((i) => ({ ...i, file: t.file }))));
  }
  const { written } = writeSnapshot(contentDir, outFile, { articlesDir });
  console.log(`${own.topics.length} article(s) read, ${own.problems.size} skipped; snapshot ${written ? 'rebuilt' : 'unchanged'}.`);
  return own.problems.size ? 1 : 0;
}

const [cmd, arg, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? (rest[i + 1] ?? '') : null;
};
try {
  if (cmd === 'check') process.exit(check(process.argv.includes('--strict')));
  else if (cmd === 'articles') process.exit(articles());
  else if (cmd === 'hash' && arg) console.log(section(arg).hash);
  else if (cmd === 'stamp' && arg) stamp(arg);
  else if (cmd === 'draft' && arg) await draft(arg, flag('after'), (flag('keep') ?? '').split(',').filter(Boolean), rest.includes('--force'));
  else {
    console.error('Usage: node scripts/coaching.ts check [--strict] | articles | hash <pack id> | stamp <pack id> | draft <pack id> [--after <pack id>] [--keep id,id] [--force]');
    process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
