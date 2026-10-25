// Real-user Core Web Vitals (P2-9, PERF-10): LCP, INP, CLS, FCP and TTFB from a sample of page
// views, sent once when the page is hidden to /api/rum, which logs them (src/pages/api/rum.ts).
// Nothing identifies the reader: no cookie, no storage, no id; only the page path, the metric values,
// the viewport width and the connection type. Readers who send Global Privacy Control or Do Not
// Track are never sampled.
//
// PUBLIC_RUM_SAMPLE_RATE (build time, 0 to 1, default 0.1) is the share of page views measured.
// web-vitals itself is only downloaded for sampled views.

export const RUM_ENDPOINT = '/api/rum';
export const DEFAULT_SAMPLE_RATE = 0.1;

export type RumMetric = { n: 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB'; v: number; r: 'good' | 'needs-improvement' | 'poor' };

/** What one page view sends. Short keys: it goes in a beacon. */
export type RumBeacon = {
  /** Page path, no query or hash. */
  p: string;
  /** Navigation type (navigate, reload, back-forward, prerender, ...). */
  t: string;
  /** Viewport width in CSS px. */
  w: number;
  /** Effective connection type, when the browser reports it. */
  c?: string;
  /** The sample rate this view was measured at, for re-weighting. */
  s: number;
  m: RumMetric[];
};

/** The configured sample rate, clamped to 0..1 (an unset or malformed value means the default). */
export function sampleRate(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SAMPLE_RATE;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_SAMPLE_RATE;
}

type PrivacyNavigator = Navigator & { globalPrivacyControl?: boolean; connection?: { effectiveType?: string } };

/** Starts measuring this page view if it is sampled. Safe to call on any page, once. */
export async function startRum(rate = sampleRate(import.meta.env.PUBLIC_RUM_SAMPLE_RATE)): Promise<void> {
  if (typeof window === 'undefined' || rate <= 0 || Math.random() >= rate) return;
  const nav = navigator as PrivacyNavigator;
  if (nav.globalPrivacyControl === true || nav.doNotTrack === '1') return;
  if (typeof nav.sendBeacon !== 'function') return;

  const { onCLS, onFCP, onINP, onLCP, onTTFB } = await import('web-vitals');
  const latest = new Map<RumMetric['n'], RumMetric>();
  let navigationType = 'navigate';
  const record = (m: { name: RumMetric['n']; value: number; rating: RumMetric['r']; navigationType: string }) => {
    // CLS is a unitless score (4 decimals); the rest are milliseconds.
    const v = m.name === 'CLS' ? Math.round(m.value * 10_000) / 10_000 : Math.round(m.value);
    latest.set(m.name, { n: m.name, v, r: m.rating });
    navigationType = m.navigationType;
  };
  onLCP(record);
  onINP(record);
  onCLS(record);
  onFCP(record);
  onTTFB(record);

  const flush = () => {
    if (!latest.size) return;
    const beacon: RumBeacon = {
      p: location.pathname,
      t: navigationType,
      w: Math.round(window.innerWidth),
      ...(nav.connection?.effectiveType ? { c: nav.connection.effectiveType } : {}),
      s: rate,
      m: [...latest.values()],
    };
    latest.clear();
    // text/plain keeps the beacon a simple request.
    nav.sendBeacon(RUM_ENDPOINT, new Blob([JSON.stringify(beacon)], { type: 'text/plain' }));
  };
  // Registered after web-vitals' own listeners, so CLS and INP are final when this runs.
  addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  addEventListener('pagehide', flush);
}
