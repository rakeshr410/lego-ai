import { slugify } from './headings';

// Stable fragment ids for a topic's sections and subsections (P2-10, UX-2), so a section can be
// linked and shared (/systems/instagram/email-and-password-login#data-model). Made from the rail
// label (else the title), which authors change less often than the heading.

type Heading = { id: number; title: string; railLabel?: string | null };

/** Ids other parts of the reader page already use. */
const RESERVED = new Set(['content', 'rd-contents']);

export type Anchors = {
  /** One id per section, in order. */
  sections: string[];
  /** Subsection ids by block id. */
  subs: Map<number, string>;
};

/** Unique ids for the sections and their subsections, in document order. */
export function sectionAnchors(sections: { section: Heading; subs: Heading[] }[]): Anchors {
  const used = new Set(RESERVED);
  const take = (h: Heading, fallback: string) => {
    const base = slugify(h.railLabel || h.title) || fallback;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  const subs = new Map<number, string>();
  const ids = sections.map((s, i) => {
    const id = take(s.section, `section-${i + 1}`);
    s.subs.forEach((sub, j) => subs.set(sub.id, take(sub, `${id}-${j + 1}`)));
    return id;
  });
  return { sections: ids, subs };
}
