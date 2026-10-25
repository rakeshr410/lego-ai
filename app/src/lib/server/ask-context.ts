import type { SnapshotTopic } from '../content-snapshot';
import { freeCut, isLocked } from '../free-tier';
import { getTopics } from '../sd';
import { passageIndex, topicDocument, type Block, type PassageIndex } from './ask-grounding';
import { LRU } from './lru';
import { serverFetch, StrapiError } from './strapi-server';

// What Ask mode grounds its answers in: everything a reader can see in a topic, flattened to
// plain text (ask-grounding.ts), plus the topic's tutor brief (key facts to rely on).
//
// Both come from the content snapshot this server was built with, the same one its pages were
// prerendered from, so the tutor never answers about text the reader can't see and every
// instance serves the same version. A reader whose plan doesn't read the topic in full (the free
// tier, lib/free-tier.ts) gets answers grounded on the part of it they get, and no tutor brief
// (it sums up the whole design). Only the Strapi documentIds that Ask threads point at are
// looked up at runtime, by slug: they differ per database (local, staging, production) and the
// content sync keeps them stable, so they are cached for an hour.

export type AskContext = {
  topicDocumentId: string;
  systemDocumentId: string;
  title: string;
  systemName: string;
  brief: string;
  document: string;
  /** The topic's content hash, for logs (tells prompt-cache misses from content edits). */
  version: string;
  /** Every string in the topic, for checking that a clicked passage comes from it. */
  passages: PassageIndex;
};

export type Grounding = Pick<AskContext, 'title' | 'systemName' | 'brief' | 'document' | 'version' | 'passages'>;
export type TopicIds = Pick<AskContext, 'topicDocumentId' | 'systemDocumentId'>;

// Keyed by the topic's content hash: an edit is a new key, never a stale hit.
const groundings = new LRU<Grounding>(500, 24 * 60 * 60 * 1000);
// Found topics only: a miss is never cached, so made-up slugs can't fill the cache.
const IDS_TTL_MS = 60 * 60 * 1000;
const ids = new LRU<TopicIds>(2000, IDS_TTL_MS);
const inFlight = new Map<string, Promise<TopicIds | null>>();

/**
 * A topic's grounding, built from its snapshot entry (also used by the Ask eval, web/eval/). With
 * `preview` (pricing.yaml free.previewSections), only the free tier's cut of it: those sections'
 * text, without the brief, the component cards or the tools, which describe the whole design.
 */
export function grounding(t: SnapshotTopic, systemName: string, preview?: readonly string[]): Grounding {
  const key = preview ? `${t.hash}:free:${preview.join(',')}` : t.hash;
  const hit = groundings.get(key);
  if (hit) return hit;
  const content = preview ? freeCut(t.content as unknown as (Block & { __component: string })[], preview).content.filter((b) => !isLocked(b)) : (t.content as unknown as Block[]);
  const components = preview ? null : t.components;
  const tools = preview ? null : t.tools;
  const g = {
    title: t.title,
    systemName,
    brief: preview ? '' : (t.tutorBrief ?? ''),
    document: topicDocument(t.title, t.lede, content, components, tools),
    version: key,
    // The component cards' text is on the page too, so a reader may click it.
    passages: passageIndex(t.title, t.lede, content, components, tools),
  };
  groundings.set(key, g);
  return g;
}

async function lookupIds(system: string, topic: string): Promise<TopicIds | null> {
  const q = new URLSearchParams({
    'filters[slug][$eq]': topic,
    'filters[system][slug][$eq]': system,
    'fields[0]': 'slug',
    'populate[system][fields][0]': 'slug',
    'pagination[pageSize]': '1',
  });
  type Found = { data: { documentId: string; system: { documentId: string } | null }[] };
  let found: Found;
  try {
    found = await serverFetch<Found>(`/topics?${q}`);
  } catch (err) {
    // One retry for a blip (network, timeout, 5xx); a 4xx won't get better.
    if (err instanceof StrapiError && err.status < 500) throw err;
    await new Promise((r) => setTimeout(r, 250));
    found = await serverFetch<Found>(`/topics?${q}`);
  }
  const t = found.data[0];
  if (!t?.system) {
    console.warn(JSON.stringify({ level: 'warn', event: 'ask_topic_not_in_cms', topic: `${system}/${topic}`, hint: 'run the content sync' }));
    return null;
  }
  return { topicDocumentId: t.documentId, systemDocumentId: t.system.documentId };
}

/**
 * A topic's and its system's Strapi documentIds, by slug: what Ask threads and the learner model
 * (learner.ts) point at. Cached for an hour; null when the CMS has no such topic.
 */
export function topicIds(system: string, topic: string): Promise<TopicIds | null> {
  const key = `${system}/${topic}`;
  const hit = ids.get(key);
  if (hit) return Promise.resolve(hit);
  let p = inFlight.get(key);
  if (!p) {
    p = lookupIds(system, topic)
      .then((value) => {
        if (value) ids.set(key, value);
        return value;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

/**
 * The grounding for a topic whose page this build publishes, or null when there is no such page
 * (unknown, not authored, not reviewed when only reviewed topics are published) or the CMS has
 * no such topic (content not synced yet). `preview`: the reader gets only the free tier's cut of
 * the topic (entitlements.ts readsInFull), so the grounding is that cut (grounding above).
 */
export async function getAskContext(system: string, topic: string, { preview }: { preview?: readonly string[] } = {}): Promise<AskContext | null> {
  const readable = (await getTopics()).find((t) => t.system.slug === system && t.slug === topic);
  if (!readable?.available) return null;
  // Loaded the way sd.ts loads it, so the bundler keeps one copy of the snapshot.
  const { getSnapshot } = await import('../content-snapshot');
  const t = getSnapshot().topics.find((x) => x.system === system && x.slug === topic);
  if (!t) return null;
  const found = await topicIds(system, topic);
  if (!found) return null;
  return { ...found, ...grounding(t, readable.system.name, preview) };
}
