import type { AGENT_PATTERNS, AgentProfile, CmsBlock, CmsCoachTip, CmsTopicComponent, CmsTopicTool, DIFFICULTIES, TEMPLATE_NAMES, TOPIC_KINDS, DerivedPlan, SlugAliases, PROVENANCES, REVIEW_STATUSES, SYSTEM_ICONS, WIREFRAMES } from '@arrowbox/content-kit';
import type { PricingFile } from '@arrowbox/content-kit/pricing';
import type { Review } from '@arrowbox/content-kit/reviews';

// The catalog the site is built from and Ask grounds on: content/ validated by content-kit and
// written to web/.content/snapshot.json (content-snapshot.node.ts) whenever `astro build` or
// `astro dev` starts. Pages and the Ask server read this one file, so they always agree; the
// build never calls Strapi. Server-only: it carries the tutor briefs. Pages reach it through
// sd.ts, which strips them.

export type SnapshotProblemClass = {
  slug: string;
  name: string;
  description: string | null;
  hue: number;
  order: number;
  /** The track its systems are on (content/tracks.yaml); a class that names none is the library track's. */
  track: string | null;
  /** On a track board (design 16a): the column its systems sit in. */
  column: 'concepts' | 'systems' | null;
  /** On a track board: what the trace bar says of a concept of this class no system builds on. */
  note: string | null;
};

/** A layer of the stack on the track picker (content/tracks.yaml, design 15a), and its board (16a). */
export type SnapshotTrack = {
  slug: string;
  name: string;
  strip: string;
  text: string;
  order: number;
  /** `library`: the system picker at /systems (6a). `board`: /tracks/<slug> (16a). */
  view: 'library' | 'board';
  /** System slugs named on the track's card first. */
  featured: string[];
  /** Practice drills (topic and section interviews) are derived for this track's systems (docs/README.md, "Drills"). */
  interviewDrills: boolean;
  /** Example systems named on the card while the track has none. */
  examples: string[];
  /** The caption of the card's figure on the track picker (15a). */
  figure: string | null;
  board: {
    heading: string;
    accent: string | null;
    conceptsTitle: string;
    conceptsText: string | null;
    systemsTitle: string;
    systemsText: string | null;
    /** The label over a system hub's topics (16c). */
    focusLabel: string | null;
  } | null;
};

export type SnapshotSystem = {
  slug: string;
  name: string;
  example: string | null;
  monogram: string | null;
  icon: (typeof SYSTEM_ICONS)[number] | null;
  order: number;
  /** A problem class slug. */
  problemClass: string;
  /** One sentence under the name on a track hub (design 16c). */
  summary: string | null;
  /** Names no real product: no trademark notice on its pages. */
  generic: boolean;
  /** An agent system's pattern (design 19a), shown on its hub. */
  pattern: (typeof AGENT_PATTERNS)[number] | null;
  /** On a track board (16a): the systems of the same track this one builds on, as slugs. */
  buildsOn: string[];
  /** The system's topic groups, in reading order (P3-4); topics name one by key. */
  groups: SnapshotGroup[];
};

export type SnapshotGroup = { key: string; name: string; summary: string | null };

/** content/tags.yaml (P3-4). */
export type SnapshotTag = { slug: string; name: string; description: string | null };

export type Difficulty = (typeof DIFFICULTIES)[number];

export type SnapshotSource = { title: string; url: string; note: string | null };

/** A topic in the shape the CMS returns it: every component has an id and defaults are filled in. */
export type SnapshotTopic = {
  system: string;
  slug: string;
  /** The source file, relative to content/. */
  file: string;
  /** Hash of the whole topic: changes with any edit, so caches keyed by it never go stale. */
  hash: string;
  title: string;
  shortTitle: string | null;
  summary: string | null;
  wireframe: (typeof WIREFRAMES)[number] | null;
  /** The key of one of its system's groups. */
  group: string;
  order: number;
  difficulty: Difficulty | null;
  /** Tag slugs (tags below). */
  tags: string[];
  /** Topics to read first, as <system>/<topic> (P3-4); ones this snapshot lacks are dropped by the pages. */
  prerequisites: string[];
  /** Topics worth reading alongside, as <system>/<topic>. */
  related: string[];
  xp: number;
  eyebrow: string;
  /** Slash-separated, as the CMS stores it ("Onboarding / Authentication"). */
  breadcrumb: string | null;
  lede: string | null;
  reviewStatus: (typeof REVIEW_STATUSES)[number];
  /** Editorial record (P1-9), GitHub handles. The review checklist stays in content/ and the CMS. */
  author: string | null;
  reviewer: string | null;
  reviewedAt: string | null;
  provenance: (typeof PROVENANCES)[number] | null;
  sources: SnapshotSource[];
  /** Derived at build (content-kit derive.ts): words / 200, rounded up; null without content. */
  readMinutes: number | null;
  /** Derived: the last commit that touched the file (its mtime when uncommitted or without git). */
  lastUpdated: string | null;
  /** Derived: a hash of the file's data, for recording which version notes and progress were made against. */
  contentVersion: string | null;
  /** Key facts for Ask mode. Never sent to the browser. */
  tutorBrief: string | null;
  /** radio (a product's screens) or agentic (an agent); null when the file leaves it out. */
  kind: (typeof TOPIC_KINDS)[number] | null;
  /** The section template the topic follows (content-kit TOPIC_TEMPLATES), if any. */
  template: (typeof TEMPLATE_NAMES)[number] | null;
  /** An agentic topic's pattern, autonomy, channels, risk and models. */
  agentProfile: AgentProfile | null;
  /** The topic's components (P1-5), as the CMS returns them; blocks refer to them by key. */
  components: CmsTopicComponent[];
  /** An agentic topic's tools, as the CMS returns them; sd.tool-catalog shows them, agent-trace steps name them. */
  tools: CmsTopicTool[];
  content: CmsBlock[];
};

export type SnapshotPicker = {
  title: string;
  searchPlaceholder: string;
  classLabel: string;
  allLabel: string;
  featuredLabel: string;
  focusLabel: string;
  startLabel: string;
  emptyText: string;
};

/**
 * A system's mock interview plan (content/interviews/<system>.yaml, P3-11), whole: the private
 * fields (briefs, signals, follow-ups) are for the interview service only; pages get a projection
 * (lib/interview.ts).
 */
export type SnapshotInterview = {
  system: string;
  /** The hand-written plan's file, or the lead source topic's. */
  file: string;
  /** Reviewed only when every source topic (and the hand-written plan, if any) is. */
  reviewStatus: (typeof REVIEW_STATUSES)[number];
  /**
   * The plan the room runs (ADR 0003): derived from the system's sections, with the hand-written
   * plan merged in where one exists (used whole when its stages name no sections).
   */
  plan: DerivedPlan;
  /** The topics it was derived from (`derived` false: the hand-written plan was used whole). */
  sourceTopics: string[];
  derived: boolean;
  /** Hash of the plan: a session started on one version notices an edit; the rubric is pinned to it. */
  hash: string;
};

/**
 * A practice drill (docs/README.md, "Drills"): a topic's or one section's short interview,
 * derived like the system plan (ADR 0003), for systems on a track with `interviewDrills`. Whole,
 * like SnapshotInterview: the private fields never leave the interview service.
 */
export type SnapshotDrill = {
  system: string;
  topic: string;
  /** The section's key, or null for the whole topic. */
  section: string | null;
  /** The topic's file. */
  file: string;
  /** The topic's review status. */
  reviewStatus: (typeof REVIEW_STATUSES)[number];
  plan: DerivedPlan;
  hash: string;
};

export type ContentSnapshot = {
  /** SNAPSHOT_FORMAT in content-snapshot.node.ts. */
  format: number;
  /** content-kit's CATALOG_VERSION the files were written for. */
  catalogVersion: number;
  /** Hash of everything below: the content version a build (and its Ask server) serves. */
  contentHash: string;
  problemClasses: SnapshotProblemClass[];
  /** The track picker's tracks (content/tracks.yaml), in order. */
  tracks: SnapshotTrack[];
  systems: SnapshotSystem[];
  /** Topics that validated, in systems.yaml order, then by order and slug. */
  topics: SnapshotTopic[];
  /**
   * lego-ai's backend articles (app/articles/backend/<system>/<slug>.yaml), kept apart from `topics` so a
   * backend article may share its system and slug with a frontend one. Only the coach reads them (topicAt).
   */
  backendTopics?: SnapshotTopic[];
  picker: SnapshotPicker;
  /** The tags topics may carry (P3-4). */
  tags: SnapshotTag[];
  /** Reader coach tips, the same for every topic with content. */
  coachTips: CmsCoachTip[];
  /**
   * Old slugs of renamed topics and systems (content/slug-aliases.yaml, P2-13), each pointing at a
   * topic or system in this snapshot: the server redirects them, and progress saved under them counts.
   */
  aliases: SlugAliases;
  /** Mock interview plans, one per system at most (P3-11). */
  interviews: SnapshotInterview[];
  /** Practice drills: a topic and each of its sections, for systems on a track with `interviewDrills`. */
  drills: SnapshotDrill[];
  /** The price catalog and free tier (content/pricing.yaml, Phase 4); null in a content directory without one. */
  pricing: PricingFile | null;
  /** Reader reviews (content/reviews.yaml, Phase 4), newest first; [] without the file. */
  reviews: Review[];
  /** Topic files left out because they failed validation or have lint errors (the build goes on without them). */
  skipped: { file: string; problems: string[] }[];
};

let parsed: ContentSnapshot | undefined;

/**
 * The snapshot this build was made from, read from .content/snapshot.json beside the app (the image
 * copies it there) on first use. Not imported with ?raw: that inlines the whole file (70+ MB) as one
 * string literal in a server chunk, and V8 took several GB to compile it (the ai task OOM-killed at
 * 1 GiB, 2026-10-28). fs comes from getBuiltinModule so no client bundle imports node:fs.
 */
export function getSnapshot(): ContentSnapshot {
  if (!parsed) {
    const { readFileSync } = process.getBuiltinModule('node:fs');
    parsed = JSON.parse(readFileSync(`${process.cwd()}/.content/snapshot.json`, 'utf8')) as ContentSnapshot;
  }
  return parsed;
}

/** The folder of lego-ai's backend articles and packs, and the prefix of a system written as theirs (`backend/url-shortener`). */
export const BACKEND = 'backend';

/** A topic by system and slug; a system written `backend/<system>` is looked up among the backend articles. */
export function topicAt(snapshot: Pick<ContentSnapshot, 'topics' | 'backendTopics'>, system: string, slug: string): SnapshotTopic | undefined {
  const backend = system.startsWith(`${BACKEND}/`);
  const name = backend ? system.slice(BACKEND.length + 1) : system;
  return (backend ? (snapshot.backendTopics ?? []) : snapshot.topics).find((t) => t.system === name && t.slug === slug);
}
