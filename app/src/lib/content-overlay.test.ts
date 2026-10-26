import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
});
