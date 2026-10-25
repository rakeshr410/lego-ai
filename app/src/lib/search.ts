import type { Options, SearchResult } from 'minisearch';
import type { Difficulty } from './content-snapshot';

// Site search (P3-3, PRODUCT-9): every system design and every topic. The index is built at build
// time from the catalog (pages/catalog/search.json.ts) and loaded by the header's search box
// (components/HeaderSearch.astro) the first time someone focuses it, with MiniSearch imported then
// too, so no page ships either up front. Every topic is in it, written or not: finding a
// coming-soon topic still tells the reader where it will be.

/** One system, concept or topic as the index holds it. `id` is <system>/<topic>, or system:<system>. */
export type SearchDoc = {
  id: string;
  /** A system design, a core concept (a track board's concepts column) or a topic in either. */
  kind: 'system' | 'concept' | 'topic';
  /** The track the system is on ("Backend"), and its slug for the track's tint; empty when none. */
  track: string;
  trackSlug: string;
  title: string;
  summary: string;
  /** The system's name ("Instagram"), so "instagram login" finds the topic. */
  system: string;
  systemSlug: string;
  slug: string;
  group: string;
  /** Tag names, space-separated. */
  tags: string;
  difficulty: Difficulty | null;
  available: boolean;
};

/** A hit, with the stored fields the results list shows. */
export type SearchHit = Pick<SearchDoc, 'id' | 'kind' | 'track' | 'trackSlug' | 'title' | 'summary' | 'tags' | 'system' | 'systemSlug' | 'slug' | 'group' | 'difficulty' | 'available'> & {
  score: number;
  /** The query words as matched in the index ("rate", "limiting"). */
  terms: string[];
  /** For each matched word, the fields it was found in ("title", "tags"): why the hit matched. */
  match: Record<string, string[]>;
};

/** The same options build the index and load it: MiniSearch needs both to agree. */
export const SEARCH_OPTIONS = {
  fields: ['title', 'summary', 'system', 'group', 'tags', 'track'],
  storeFields: ['kind', 'track', 'trackSlug', 'title', 'summary', 'tags', 'system', 'systemSlug', 'slug', 'group', 'difficulty', 'available'],
  searchOptions: {
    boost: { title: 3, tags: 2, system: 1.5 },
    // A system named by the query ("rate limiter") comes before its own topics.
    boostDocument: (_id: string, _term: string, stored?: Record<string, unknown>) => (stored?.kind === 'topic' ? 1 : 1.6),
    // Typing is searching: "chat thr" finds Chat thread, and a slip ("pagnation") still matches.
    prefix: true,
    fuzzy: (term: string) => (term.length > 4 ? 0.2 : false),
    combineWith: 'AND',
  },
} satisfies Options<SearchDoc>;

/** Queries shorter than this show no results (a single letter matches everything). */
export const MIN_QUERY = 2;

/** Builds the index, serialized for /catalog/search.json. Build time only (it imports MiniSearch). */
export async function buildSearchIndex(docs: SearchDoc[]): Promise<string> {
  const { default: MiniSearch } = await import('minisearch');
  const index = new MiniSearch<SearchDoc>(SEARCH_OPTIONS);
  index.addAll(docs);
  return JSON.stringify(index);
}

export type TopicSearch = (query: string) => SearchHit[];

let loading: Promise<TopicSearch> | null = null;

/**
 * The search, loaded once: MiniSearch and the index, fetched in parallel. `version` (the content
 * hash) keeps a cached index from outliving the content it was built from. A failed load is
 * forgotten, so the next attempt tries again.
 */
export function loadSearch(version: string, fetcher: typeof fetch = fetch): Promise<TopicSearch> {
  loading ??= Promise.all([import('minisearch'), fetcher(`/catalog/search.json?v=${encodeURIComponent(version)}`)])
    .then(async ([{ default: MiniSearch }, res]) => {
      if (!res.ok) throw new Error(`search index: HTTP ${res.status}`);
      const index = MiniSearch.loadJSON<SearchDoc>(await res.text(), SEARCH_OPTIONS);
      return (query: string) => (query.trim().length < MIN_QUERY ? [] : (index.search(query.trim()) as (SearchResult & SearchHit)[]));
    })
    .catch((err: unknown) => {
      loading = null;
      throw err;
    });
  return loading;
}

/** Where a hit opens: a system's hub, or a written topic's page (an unwritten one opens its system). */
export function hitHref(hit: Pick<SearchHit, 'kind' | 'systemSlug' | 'slug' | 'available'>): string {
  return hit.kind === 'topic' && hit.available ? `/systems/${hit.systemSlug}/${hit.slug}` : `/systems/${hit.systemSlug}`;
}
