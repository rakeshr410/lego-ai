import { createHash } from 'node:crypto';

// A section's identity for the coaching material: the hash of its blocks as the content snapshot
// has them (the blocks between its heading and the next). A pack records the hash of the section
// it was written from; when the article's section changes, the hash does, and the pack is stale
// until someone rereads the section and restamps it (scripts/coaching.ts stamp).

type Block = { __component?: string; key?: string | null };

/** The blocks between a section heading and the next, by the heading's key, or null when the topic has no such section. */
export function sectionBlocksOf<B extends Block>(content: readonly B[], sectionKey: string): B[] | null {
  const heads = content.flatMap((b, i) => (b.__component === 'sd.section' ? [{ b, i }] : []));
  const n = heads.findIndex(({ b }, k) => (b.key ?? `section-${k + 1}`) === sectionKey);
  if (n < 0) return null;
  const end = heads[n + 1]?.i ?? content.length;
  return content.slice(heads[n].i + 1, end);
}

/** Object keys in a stable order, so a hash survives a re-serialised snapshot. */
const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
        )
      : v;

/** The section's hash (12 hex characters) from the topic's blocks, or null when the section is not there. */
export function coachingSectionHash(content: readonly Block[], sectionKey: string): string | null {
  const blocks = sectionBlocksOf(content, sectionKey);
  if (!blocks) return null;
  // The heading itself counts: a renamed section is a changed one.
  const heading = content.find((b, k) => b.__component === 'sd.section' && (b.key ?? `section-${k + 1}`) === sectionKey);
  return createHash('sha256')
    .update(JSON.stringify(stable([heading, ...blocks])))
    .digest('hex')
    .slice(0, 12);
}
