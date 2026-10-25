// The analytics event taxonomy (P3-2, docs/analytics.md), shared by the browser (lib/analytics.ts)
// and the server (lib/server/events.ts). Events are sent only with the reader's consent, to this
// site's own /api/events, and become log lines; there is no third party. Nothing in an event is
// free text: topics and sections are the site's own slugs and block keys, and everything else is
// a number, a flag or one of a few fixed words.
//
// Changing an event's meaning means a new name (or a new TAXONOMY_VERSION), never a silent change:
// dashboards read old and new lines side by side.

export const TAXONOMY_VERSION = 1;
export const EVENTS_ENDPOINT = '/api/events';
/** Most events in one beacon; the browser sends sooner when it has this many. */
export const MAX_EVENTS = 25;
/** The largest beacon the server reads. */
export const MAX_EVENT_BYTES = 8 * 1024;

/** `<system>/<topic>`, as the learner model keys topics. */
export type TopicKey = string;
export type VoteValue = 'up' | 'down' | null;
export type Referrer = 'direct' | 'internal' | 'search' | 'social' | 'other';
export type QuickCheckAction = 'start' | 'later' | 'never';
export type IssueCategory = 'incorrect' | 'unclear' | 'typo' | 'broken' | 'other';

/** Every event, by name (`n`), with its properties. Short keys: they go in a beacon. */
export type AnalyticsEvent =
  /** A page was opened. The page is the beacon's path; `r` is where the reader came from. */
  | { n: 'page_view'; r: Referrer }
  /** A section counted as read (components/sd/reading.ts: time in it, not scrolling past). */
  | { n: 'section_read'; topic: TopicKey; section: string }
  /** The topic reached its finishing share of sections read (lib/learner.ts). */
  | { n: 'topic_completed'; topic: TopicKey }
  /** A quick check was closed with answers: per question 1 right, 0 wrong, null skipped. */
  | { n: 'quiz_answered'; topic: TopicKey; quiz: string; answers: (0 | 1 | null)[] }
  /** The reader's answer to a "Quick check ready" offer. */
  | { n: 'quick_check'; topic: TopicKey; quiz: string; action: QuickCheckAction }
  /** Ask mode was switched on. */
  | { n: 'ask_opened'; topic: TopicKey }
  /** The library search settled on a query: its length and how many systems matched, never the words. */
  | { n: 'picker_search'; length: number; results: number }
  /** A coming-soon topic was opened in the library's preview. */
  | { n: 'coming_soon_viewed'; topic: TopicKey }
  /** "Notify me" on a coming-soon topic was turned on or off. */
  | { n: 'notify_me'; topic: TopicKey; on: boolean }
  /** A section was voted helpful (up), not helpful (down), or the vote was taken back (null). */
  | { n: 'section_vote'; topic: TopicKey; section: string; vote: VoteValue }
  /** "Report an issue" was sent; the report itself is in the CMS. */
  | { n: 'issue_reported'; topic: TopicKey; section: string | null; category: IssueCategory }
  /** The reviews page (13c) was opened. */
  | { n: 'reviews_view' }
  /** A filter chip on the reviews page was chosen: its key (`all`, `5`, `tag:news-feed`), the site's own. */
  | { n: 'reviews_filter'; filter: string };

export type EventName = AnalyticsEvent['n'];

export const EVENT_NAMES = [
  'page_view',
  'section_read',
  'topic_completed',
  'quiz_answered',
  'quick_check',
  'ask_opened',
  'picker_search',
  'coming_soon_viewed',
  'notify_me',
  'section_vote',
  'issue_reported',
  'reviews_view',
  'reviews_filter',
] as const satisfies readonly EventName[];

/** One browser's batch. */
export type EventBeacon = {
  /** TAXONOMY_VERSION. */
  v: number;
  /** The browser's anonymous id: random, made when the reader allows analytics, deleted when they stop. */
  a: string;
  /** The share of browsers the build samples. Informational: the server logs its own rate, never this. */
  s: number;
  /** Page path, no query or hash. */
  p: string;
  /** Viewport width in CSS px. */
  w: number;
  e: AnalyticsEvent[];
};

export const ANON_ID = /^[A-Za-z0-9_-]{16,32}$/;

/**
 * Where a browser falls in [0, 1), from its anonymous id (FNV-1a). Sampling by it keeps or drops a
 * browser's events together, so funnels stay whole; the server samples the same way, so its rate
 * only ever narrows the browser's.
 */
export function sampleSlot(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x1_0000_0000;
}

/** The configured sample rate, clamped to 0..1 (unset or malformed means `fallback`). */
export function rateFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}
