// The free tier's cut of a topic (Phase 4, decision 2; docs/phase-4-design.md, slice E): what a
// signed-in Free reader gets of a design that isn't one of pricing.yaml's free.fullTopics. They get
// the page's chrome and intro (title, lede, the section headings, the rail) and the sections or
// subsections keyed by one of free.previewSections ("functional-requirements"); everything else is
// locked and never leaves the server. The build makes a Free variant of each such topic page from
// this (pages/v/free/[system]/[topic].astro), Ask grounds a Free reader's questions on it, and the
// learner model records only what it leaves readable (lib/server/learner.ts).
//
// Pure, so the pages, the server and the tests share one definition. Content is the flat block list
// of a topic (sd.section markers followed by their blocks), in either the snapshot's or sd.ts's shape.

type Block = { __component: string; key?: string | null };

/**
 * How much of a section a Free reader gets: 'none' of it locked (a preview section), the 'rest'
 * locked after its preview subsections, or 'all' of it locked (the heading only).
 */
export type Lock = 'none' | 'rest' | 'all';

export type FreeCut<B extends Block> = {
  /**
   * The blocks a Free reader gets, in order: every section marker, and only the preview blocks under
   * them, with the headings of the locked subsections beside them.
   */
  content: B[];
  /** Per section, in order (as toSections splits `content`): how much of it is locked. */
  locks: Lock[];
};

const isSection = (b: Block) => b.__component === 'sd.section';
const isSubsection = (b: Block) => b.__component === 'sd.subsection';

/**
 * A topic's content cut to the free tier. A section keyed by one of `previewKeys` stays whole (its
 * quiz too). In any other section only the subsections keyed by one of them stay, each up to the
 * next heading, without the section's intro or quiz, and its other subsections keep their headings
 * alone, marked `locked` (isLocked); a section without one keeps only its heading. Blocks before
 * the first section (which no page shows) are dropped.
 */
export function freeCut<B extends Block>(content: readonly B[], previewKeys: readonly string[]): FreeCut<B> {
  const keys = new Set(previewKeys);
  const out: B[] = [];
  const locks: Lock[] = [];
  let i = content.findIndex(isSection);
  if (i < 0) return { content: [], locks: [] };
  while (i < content.length) {
    const marker = content[i];
    let end = i + 1;
    while (end < content.length && !isSection(content[end])) end++;
    const body = content.slice(i + 1, end);
    if (keys.has(marker.key ?? '')) {
      out.push(marker, ...body);
      locks.push('none');
    } else {
      // Only the heading: a section's intro is part of what it teaches.
      out.push({ ...marker, intro: null });
      const kept: B[] = [];
      let preview = 0;
      let open = false;
      for (const b of body) {
        if (isSubsection(b)) open = keys.has(b.key ?? '');
        else if (b.__component === 'sd.quiz') open = false;
        if (open) preview++;
        // A locked subsection keeps its heading (and rail label), marked, so the page and the rail
        // can say it is there and locked; its intro goes with the rest of what it teaches.
        if (open || isSubsection(b)) kept.push(open ? b : { ...b, intro: null, locked: true });
      }
      // A section with no preview subsection shows only its own heading.
      if (preview > 0) out.push(...kept);
      locks.push(preview === 0 ? 'all' : preview === body.length ? 'none' : 'rest');
    }
    i = end;
  }
  return { content: out, locks };
}

/** Whether a block of a cut is a locked subsection's heading (freeCut): shown, tagged Pro, with nothing under it. */
export const isLocked = (b: object) => (b as { locked?: unknown }).locked === true;

/**
 * The free tier as content/pricing.yaml sets it: the designs read in full, the preview keys, and
 * the public systems (every topic of them read in full by anyone, signed in or not).
 */
export type FreeTier = { fullTopics: readonly string[]; previewSections: readonly string[]; publicSystems?: readonly string[] };

/** Whether `topic` (`<system>/<topic>`) is public: anyone reads it, signed in or not (free.publicSystems). */
export function isPublic(free: Pick<FreeTier, 'publicSystems'> | null | undefined, topic: string): boolean {
  const system = /^([^/]+)\/[^/]+$/.exec(topic)?.[1];
  return !!system && (free?.publicSystems ?? []).includes(system);
}

/** Whether a Free reader gets `topic` (`<system>/<topic>`) in full: one of fullTopics, or public. */
export const freeInFull = (free: FreeTier, topic: string) => free.fullTopics.includes(topic) || isPublic(free, topic);
