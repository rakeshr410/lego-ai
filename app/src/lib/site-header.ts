import { AUTH_EVENT, authState, type AuthState } from './auth-state';
import { recentTopics, type RecentTopic } from './recent-topics';
import { LIBRARY_PATH } from './routes';

// The site header's "Reader" link (components/SiteHeader.astro, design 13a; D15 in
// docs/phase-4-design.md): the topic this browser last had open, at the section it was in, for a
// signed-in reader, and the library otherwise. Topic pages are for signed-in readers, so a
// signed-out reader is never sent into one. The page is static: the link is built at render time
// as the library (LIBRARY_PATH) and pointed at the topic here once the page knows.

/** The library, where "Reader" goes when there is no topic to go back to. */
export const READER_FALLBACK = LIBRARY_PATH;

/**
 * Pages prerendered as variants under /v/ (pages/v/pricing/[region].astro, pages/v/reviews.astro,
 * pages/v/checkout/…) and how many trailing segments name the variant rather than the page. The
 * middleware will serve them at their public route (slice M2 on; docs/phase-4-design.md §2.2), so
 * the header's sign-in link already returns there.
 */
const VARIANT_SEGMENTS: Record<string, number> = { pricing: 1 };

/**
 * The route a reader sees for a page's own path: a variant's internal path (/v/pricing/in) is its
 * public one (/pricing), so signing in from it comes back there and the region is picked afresh.
 * Any other path is returned as it is.
 */
export function publicPath(pathname: string): string {
  const m = /^\/v\/([^/]+)((?:\/[^/]+)*)\/?$/.exec(pathname);
  if (!m) return pathname;
  const [, page, rest] = m;
  const segments = rest.split('/').filter(Boolean);
  const kept = segments.slice(0, Math.max(0, segments.length - (VARIANT_SEGMENTS[page] ?? 0))).filter((s) => s !== 'index');
  return `/${[page, ...kept].join('/')}`;
}

/** Where "Reader" goes, from the most recent topic (recentTopics(), newest first) and the auth state. */
export function readerHref(recent: RecentTopic | undefined, state: AuthState | null): string {
  if (state !== 'in' || !recent) return READER_FALLBACK;
  const [system, topic] = recent.key.split('/');
  if (!system || !topic) return READER_FALLBACK;
  return `/systems/${encodeURIComponent(system)}/${encodeURIComponent(topic)}${recent.anchor ? `#${encodeURIComponent(recent.anchor)}` : ''}`;
}

/** Points every `a[data-reader-link]` at readerHref(), now and whenever the auth state changes. */
export function wireReaderLinks(root: ParentNode = document): number {
  const links = [...root.querySelectorAll<HTMLAnchorElement>('a[data-reader-link]')];
  if (!links.length) return 0;
  const apply = () => {
    const href = readerHref(recentTopics()[0], authState());
    for (const a of links) a.href = href;
  };
  apply();
  document.addEventListener(AUTH_EVENT, apply);
  return links.length;
}
