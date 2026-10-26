import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContent } from '@arrowbox/content-kit/node';
import { describe, expect, it } from 'vitest';
import { readOwnArticles, snapshotPaths } from './content-snapshot.node';

const paths = snapshotPaths(fileURLToPath(new URL('../../', import.meta.url)));
const { catalog } = loadContent(paths.contentDir);
const taken = new Set(catalog.topics.map((t) => `${t.system}/${t.slug}`));

describe("lego-ai's own articles", () => {
  it('reads every article in app/articles, none skipped', () => {
    const own = readOwnArticles(paths.articlesDir, catalog.systems, taken);
    expect([...own.problems.values()].flat()).toEqual([]);
  });

  it('skips an article for an unknown system, one content/ already has, and one that does not validate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'articles-'));
    const write = (path: string, text: string) => {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    const [first] = catalog.topics;
    write('no-such-system/a.yaml', 'title: A\n');
    write(`${first.system}/${first.slug}.yaml`, 'title: A\n');
    write(`${first.system}/broken.yaml`, 'title: 3\n');
    const own = readOwnArticles(dir, catalog.systems, taken);
    expect(own.topics).toEqual([]);
    expect([...own.problems.keys()].sort()).toEqual([`articles/${first.system}/${first.slug}.yaml`, `articles/${first.system}/broken.yaml`, 'articles/no-such-system/a.yaml'].sort());
  });

  it('reads app/articles/backend apart, so a backend article may share its system and slug with a frontend one or with content/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'articles-'));
    const write = (path: string, text: string) => {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    const text = readFileSync(join(paths.articlesDir, 'backend/url-shortener/short-links-end-to-end.yaml'), 'utf8');
    const content = catalog.topics.find((t) => t.system === 'url-shortener')!;
    write('url-shortener/short-links-end-to-end.yaml', text);
    write('backend/url-shortener/short-links-end-to-end.yaml', text);
    write(`backend/url-shortener/${content.slug}.yaml`, text);
    write('backend/no-such-system/a.yaml', 'title: A\n');
    const own = readOwnArticles(dir, catalog.systems, taken);
    expect(own.topics.map((t) => [t.file, t.backend ?? false])).toEqual([
      ['articles/url-shortener/short-links-end-to-end.yaml', false],
      [`articles/backend/url-shortener/${content.slug}.yaml`, true],
      ['articles/backend/url-shortener/short-links-end-to-end.yaml', true],
    ].sort((a, b) => (a[1] === b[1] ? String(a[0]).localeCompare(String(b[0])) : a[1] ? 1 : -1)));
    expect([...own.problems.keys()]).toEqual(['articles/backend/no-such-system/a.yaml']);
  });
});
