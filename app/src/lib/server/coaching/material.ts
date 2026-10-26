import { getSnapshot, topicAt, type SnapshotTopic } from '../../content-snapshot';
import { FLAGS } from '../../sd';
import { catalogFromFiles, type Catalog } from './catalog';
import { coachingSectionHash } from './hash';
import { packRef, type Pack } from './schema';

// The build's coaching material (docs/coaching.md): the files under app/coaching, bundled at build
// time like the article snapshot, checked once (an invalid file fails the build and the tests), and
// each pack's standing against the article it was written from.

const FILES = Object.fromEntries(
  Object.entries(import.meta.glob('../../../../coaching/**/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>).map(([path, text]) => [path.replace(/^.*\/coaching\//, ''), text]),
);

let cached: Catalog | null = null;

/** The catalog; throws when a file is invalid. */
export function coachingCatalog(): Catalog {
  if (cached) return cached;
  const c = catalogFromFiles(FILES);
  if (c.errors.length) throw new Error(`Invalid coaching material:\n${c.errors.join('\n')}`);
  cached = c;
  return c;
}

/** The article topic a pack teaches from, as the snapshot has it. */
export function packTopic(id: string): SnapshotTopic | undefined {
  const { system, topic } = packRef(id);
  return topicAt(getSnapshot(), system, topic);
}

/**
 * Whether a lesson uses the pack, or falls back to the article for that section:
 *   fresh     the section is in the snapshot and unchanged since the pack was written;
 *   stale     the section changed (or was removed): the article is taught instead;
 *   draft     not reviewed, in a build that serves reviewed material only (PUBLIC_REVIEWED_ONLY);
 *   missing   the article's topic or section is not in this build.
 */
export type PackStanding = 'fresh' | 'stale' | 'draft' | 'missing';

export function packStanding(p: Pack): PackStanding {
  const topic = packTopic(p.id);
  if (!topic) return 'missing';
  const hash = coachingSectionHash((topic.content ?? []) as { __component?: string; key?: string }[], packRef(p.id).sectionKey);
  if (!hash) return 'missing';
  if (hash !== p.source.hash) return 'stale';
  if (FLAGS.reviewedOnly && p.review.status !== 'reviewed') return 'draft';
  return 'fresh';
}
