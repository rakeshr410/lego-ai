import { canonicalTopic, type SlugAliases } from '@arrowbox/content-kit/aliases';

// Continue reading (P3-3): the topics opened most recently, newest first, with the section the
// reader was in, so the library can offer "Continue reading" at that section and the site header's
// "Reader" link can go back to it. Kept in this browser only: the learner model (progress.ts)
// knows which sections are read, not where the reader left off; whether a topic is finished comes
// from it. Its own module, with no dependencies but the alias table, so the marketing pages' header
// (lib/site-header.ts) reads it without loading the learner model.

function getItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the place just isn't remembered */
  }
}

function parse(raw: string | null): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const RECENT_KEY = 'sd-recent';
const RECENT_MAX = 5;

export type RecentTopic = {
  /** <system>/<topic> */
  key: string;
  title: string;
  /** The system's name, for the label. */
  system: string;
  /** The section the reader was in, 0-based, of `sections`. */
  section: number;
  sections: number;
  /** The section's fragment id (lib/anchors.ts), to land on it. */
  anchor: string | null;
  /** When, in ms since the epoch. */
  at: number;
};

const isRecent = (v: unknown): v is RecentTopic => {
  const r = v as RecentTopic;
  return !!r && typeof r === 'object' && typeof r.key === 'string' && r.key.includes('/') && typeof r.title === 'string' && typeof r.section === 'number' && typeof r.at === 'number';
};

/** The recently opened topics, newest first; one saved under an old slug (P2-13) reads as its current topic. */
export function recentTopics(aliases?: SlugAliases): RecentTopic[] {
  const stored = parse(getItem(RECENT_KEY));
  const list = (Array.isArray(stored) ? stored.filter(isRecent) : []).map((r) => {
    const [system, topic] = r.key.split('/');
    const key = (aliases && canonicalTopic(aliases, system, topic)) || r.key;
    // The section ids of a renamed topic may have changed with it: land at its top.
    return key === r.key ? r : { ...r, key, anchor: null };
  });
  const seen = new Set<string>();
  return list
    .sort((a, b) => b.at - a.at)
    .filter((r) => {
      if (seen.has(r.key)) return false;
      seen.add(r.key);
      return true;
    });
}

/** Records where the reader is in a topic; the reader calls it as the current section changes. */
export function rememberReading(entry: Omit<RecentTopic, 'at'>, now = Date.now()) {
  const rest = recentTopics().filter((r) => r.key !== entry.key);
  setItem(RECENT_KEY, JSON.stringify([{ ...entry, at: now }, ...rest].slice(0, RECENT_MAX)));
}
