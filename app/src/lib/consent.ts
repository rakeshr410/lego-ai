// The reader's privacy choice (P3-2): "necessary" storage is always on (sign-in, the reader's own
// settings and progress: what the site needs to work, listed on /legal/privacy), "analytics" is
// off until they turn it on. The choice is kept in this browser (localStorage, itself necessary)
// with the version of the wording they answered and when. A new CONSENT_VERSION (the purposes
// changed) asks again. Global Privacy Control or Do Not Track is a standing "no": analytics stays
// off and the banner isn't shown.
//
// components/ConsentBanner.astro asks; the footer's "Privacy choices" reopens it. lib/analytics.ts
// sends nothing unless analyticsAllowed().

export const CONSENT_KEY = 'sd-consent';
/** Bump when what analytics collects, or why, changes: everyone is asked again. */
export const CONSENT_VERSION = 1;
/** Fired on window when the choice changes; `detail` is the new Consent. */
export const CONSENT_EVENT = 'sd:consent';
/** localStorage: the anonymous analytics id (lib/analytics.ts), deleted when analytics is turned off. */
export const ANON_ID_KEY = 'sd-aid';

export type Consent = {
  /** CONSENT_VERSION the reader answered. */
  v: number;
  analytics: boolean;
  /** When they answered (ISO). */
  at: string;
};

type PrivacyNavigator = Navigator & { globalPrivacyControl?: boolean };

/** The browser asks sites not to track: Global Privacy Control or Do Not Track. */
export function privacySignal(nav: PrivacyNavigator | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  return nav?.globalPrivacyControl === true || nav?.doNotTrack === '1';
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The reader's answer for the current wording, or null when they haven't given one. */
export function readConsent(store: Storage | null = storage()): Consent | null {
  try {
    const raw = store?.getItem(CONSENT_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<Consent>;
    if (c.v !== CONSENT_VERSION || typeof c.analytics !== 'boolean' || typeof c.at !== 'string') return null;
    return { v: c.v, analytics: c.analytics, at: c.at };
  } catch {
    return null;
  }
}

/** Records the reader's answer; turning analytics off deletes the anonymous id with it. */
export function saveConsent(analytics: boolean, store: Storage | null = storage(), now = new Date()): Consent {
  const consent: Consent = { v: CONSENT_VERSION, analytics, at: now.toISOString() };
  try {
    store?.setItem(CONSENT_KEY, JSON.stringify(consent));
    if (!analytics) store?.removeItem(ANON_ID_KEY);
  } catch {
    /* no storage: the choice holds for this page only */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<Consent>(CONSENT_EVENT, { detail: consent }));
  return consent;
}

/** Whether analytics may run now: the reader said yes to this wording and the browser doesn't object. */
export function analyticsAllowed(store: Storage | null = storage(), nav?: PrivacyNavigator): boolean {
  return !privacySignal(nav) && readConsent(store)?.analytics === true;
}

/** Whether to ask: no answer to this wording yet, and no privacy signal answering for them. */
export function needsChoice(store: Storage | null = storage(), nav?: PrivacyNavigator): boolean {
  return !privacySignal(nav) && readConsent(store) === null;
}
