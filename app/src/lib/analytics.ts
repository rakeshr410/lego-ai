import {
  ANON_ID,
  EVENTS_ENDPOINT,
  MAX_EVENTS,
  TAXONOMY_VERSION,
  rateFrom,
  sampleSlot,
  type AnalyticsEvent,
  type EventBeacon,
  type Referrer,
} from './analytics-events';
import { ANON_ID_KEY, CONSENT_EVENT, analyticsAllowed, type Consent } from './consent';

// Consented, first-party product analytics (P3-2, docs/analytics.md). track() does nothing unless
// the reader has allowed analytics (lib/consent.ts) and this browser is in the sample; then events
// are queued and sent to /api/events in one beacon when the page is hidden, when MAX_EVENTS are
// waiting, or FLUSH_MS after the first. Each browser is one random id (sd-aid), made when analytics
// is allowed and deleted when it is turned off, never linked to the reader's account.
//
// PUBLIC_ANALYTICS_SAMPLE_RATE (build time, 0 to 1, default 1) is the share of consenting browsers
// that send events.

const FLUSH_MS = 15_000;

let queue: AnalyticsEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let bound = false;

export const sampleRate = () => rateFrom(import.meta.env.PUBLIC_ANALYTICS_SAMPLE_RATE, 1);

function anonId(create: boolean): string | null {
  try {
    const have = localStorage.getItem(ANON_ID_KEY);
    if (have && ANON_ID.test(have)) return have;
    if (!create) return null;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const id = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    localStorage.setItem(ANON_ID_KEY, id);
    return id;
  } catch {
    return null;
  }
}

/** This browser's id when it may send events now, else null. */
function sender(): string | null {
  if (typeof window === 'undefined' || !analyticsAllowed()) return null;
  const id = anonId(true);
  return id && sampleSlot(id) < sampleRate() ? id : null;
}

function send(id: string) {
  if (!queue.length) return;
  const beacon: EventBeacon = {
    v: TAXONOMY_VERSION,
    a: id,
    s: sampleRate(),
    p: location.pathname,
    w: Math.round(window.innerWidth),
    e: queue.splice(0, MAX_EVENTS),
  };
  const body = JSON.stringify(beacon);
  // text/plain keeps it a simple request; sendBeacon survives the page closing.
  const sent =
    typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(EVENTS_ENDPOINT, new Blob([body], { type: 'text/plain' }));
  if (!sent)
    void fetch(EVENTS_ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
  if (queue.length) send(id);
}

/** Sends what is queued now. */
export function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  const id = sender();
  if (id) send(id);
  else queue = [];
}

function bind() {
  if (bound) return;
  bound = true;
  addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  addEventListener('pagehide', flush);
  // Turned off: nothing queued is sent.
  addEventListener(CONSENT_EVENT, (e) => {
    if (!(e as CustomEvent<Consent>).detail.analytics) queue = [];
  });
}

/** Records an event, if the reader allows analytics. Cheap to call when they don't. */
export function track(event: AnalyticsEvent) {
  if (!sender()) return;
  bind();
  queue.push(event);
  if (queue.length >= MAX_EVENTS) flush();
  else timer ??= setTimeout(flush, FLUSH_MS);
}

const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex|kagi|startpage|brave)\./;
const SOCIAL = /(^|\.)(twitter|x|t|facebook|linkedin|lnkd|reddit|news\.ycombinator|mastodon|bsky|threads|youtube)\./;

/** Where the reader came from, as a class: never the referring URL. */
export function referrerClass(referrer: string, origin: string): Referrer {
  if (!referrer) return 'direct';
  try {
    const u = new URL(referrer);
    if (u.origin === origin) return 'internal';
    const host = `${u.hostname}.`;
    if (SEARCH.test(host)) return 'search';
    if (SOCIAL.test(host)) return 'social';
    return 'other';
  } catch {
    return 'other';
  }
}

/** Counts this page view (AppLayout calls it on every page), now or once the reader allows analytics. */
export function trackPageView() {
  const view = () => track({ n: 'page_view', r: referrerClass(document.referrer, location.origin) });
  if (analyticsAllowed()) return view();
  // Allowed from the banner on this page: this view counts too.
  addEventListener(CONSENT_EVENT, (e) => (e as CustomEvent<Consent>).detail.analytics && view(), { once: true });
}
