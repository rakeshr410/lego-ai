import type {
  BlockUid,
  CmsBlockOf,
  CmsCoachTip,
  CmsTopicComponent,
  CmsTopicTool,
  COACH_TARGETS,
  DmField,
  DmType,
  FlowStep,
  MockField,
  MockScreen,
  MockState,
  ScreenSpoken,
  SlugAliases,
  TONES,
} from '@arrowbox/content-kit';
import { nextTopics, type NextReason } from '@arrowbox/content-kit/catalog';
import type { PricingFile } from '@arrowbox/content-kit/pricing';
import type { BlocksContent } from '@strapi/blocks-react-renderer';
import type { ContentSnapshot, Difficulty, SnapshotGroup, SnapshotPicker, SnapshotTag, SnapshotTopic, SnapshotTrack } from './content-snapshot';
import { FLAGS } from './flags';
import { reportWarning } from './report';
import tc from '../i18n/messages/common';
import type { SearchDoc } from './search';

// ---------- launch flags ----------

// Build-time switches (lib/flags.ts, which islands that don't need the rest of this module import).
export { FLAGS };

// ---------- content types ----------

export type ProblemClass = {
  name: string;
  slug: string;
  description?: string | null;
  hue: number;
  order: number;
  /** The track its systems are on (content/tracks.yaml). */
  track?: string | null;
  /** On a track board (design 16a): the column its systems sit in. */
  column?: 'concepts' | 'systems' | null;
  /** On a track board: what the trace bar says of a concept of this class no system builds on. */
  note?: string | null;
};

/** A layer of the stack on the track picker (design 15a) and its board (16a). */
export type Track = SnapshotTrack;

export type TopicSummary = {
  title: string;
  /** Short label for the picker's topic cards; falls back to the title. */
  shortTitle?: string | null;
  slug: string;
  summary?: string | null;
  /** The wireframe sketch a topic names in its content (no view draws them now). */
  wireframe?: string | null;
  /** The name of the topic's group (P3-4: a relation to one of its system's groups). */
  group: string;
  /** The group's key in systems.yaml. */
  groupKey: string;
  order: number;
  difficulty?: Difficulty | null;
  /** Tag slugs (the catalog's tags name them). */
  tags?: string[];
  readMinutes?: number | null;
  /** What the topic is worth: reading it earns most of it, its quizzes the rest (lib/learner.ts, P3-9). */
  xp?: number | null;
  /** True when the topic has reader content; empty topics show as "Coming soon". */
  available: boolean;
  /** Number of reader sections (only filled in by getSystems). */
  sectionCount?: number;
  /** Number of section quizzes (only filled in by getSystems). */
  quizCount?: number;
};

export type System = {
  name: string;
  slug: string;
  example?: string | null;
  monogram?: string | null;
  /** Sketched glyph name (see AppIcon); falls back to the monogram when unset. */
  icon?: string | null;
  order: number;
  problemClass: ProblemClass;
  /** One sentence under the name on a track hub (design 16c). */
  summary?: string | null;
  /** On a track board (16a): the systems of the same track this one builds on, as slugs. */
  buildsOn?: string[];
  /** Names no real product: no trademark notice on its pages. */
  generic?: boolean;
  /** An agent system's pattern (design 19a), shown on its hub. */
  pattern?: string | null;
  /** Topic groups in reading order (systems.yaml). */
  groups: SnapshotGroup[];
  topics: TopicSummary[];
};

export type { Difficulty, SnapshotTag as Tag };
/** A difficulty as readers see it (P3-4), from the message catalog (P3-7). */
export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  beginner: tc('difficulty.beginner'),
  intermediate: tc('difficulty.intermediate'),
  advanced: tc('difficulty.advanced'),
};

/** Copy for the "What are we designing?" screen. */
export type Picker = SnapshotPicker;

// ---------- sd.* blocks ----------
// Inferred from the block registry's zod schemas (content-kit), in the shape Strapi returns them:
// every component has an id and defaults are filled in. Edit the schema there, not the types here.

type Block<K extends BlockUid> = CmsBlockOf<K>;

export type SectionBlock = Block<'sd.section'>;
export type SubsectionBlock = Block<'sd.subsection'>;
export type RichTextBlock = Omit<Block<'sd.rich-text'>, 'body'> & { body: BlocksContent | null };
export type QaBlock = Block<'sd.qa-reveal'>;
export type ChecklistBlock = Block<'sd.checklist'>;
export type MetricRowBlock = Block<'sd.metric-row'>;
export type SplitListBlock = Block<'sd.split-list'>;
export type DiagramBlock = Block<'sd.diagram'>;
export type TableBlock = Block<'sd.table'>;
export type ColumnStyle = TableBlock['columns'][number]['style'];
export type CodeBlock = Block<'sd.code'>;
export type CdTone = (typeof TONES)[number];
export type ComponentDiagramBlock = Block<'sd.component-diagram'>;
export type SequenceDiagramBlock = Block<'sd.sequence-diagram'>;
export type StateMachineBlock = Block<'sd.state-machine'>;
export type OutcomeGridBlock = Block<'sd.outcome-grid'>;
/** One of the topic's components (P1-5), in the CMS shape: owns and talksTo are comma-separated. */
export type TopicComponent = CmsTopicComponent;

// ---------- interface blocks ----------

/** A drawn stand-in for a real screen, shared by the action flow and component API previews. */
export type { MockField, MockScreen, MockState, FlowStep, DmField, DmType };

export type ChoiceListBlock = Block<'sd.choice-list'>;
export type EndpointBlock = Block<'sd.endpoint'>;
export type ErrorTableBlock = Block<'sd.error-table'>;
export type ActionFlowBlock = Block<'sd.action-flow'>;
export type ComponentApiBlock = Block<'sd.component-api'>;
export type PropCategory = ComponentApiBlock['props'][number]['category'];
export type PriorityRubricBlock = Block<'sd.priority-rubric'>;
export type DeepDiveBlock = Block<'sd.deep-dive'>;
export type DecisionBlock = Block<'sd.decision'>;
export type RequirementTableBlock = Block<'sd.requirement-table'>;
export type DataModelBlock = Block<'sd.data-model'>;
export type StatementBlock = Block<'sd.statement'>;
export type CardGridBlock = Block<'sd.card-grid'>;
export type QuizBlock = Block<'sd.quiz'>;
export type QuizQuestion = QuizBlock['questions'][number];
/**
 * An sd.screen as the reader gets it. `spoken` is what its live region says under each tab, added
 * when the page is built (lib/server/screens.ts), so the families' words never ship to the
 * browser (docs/budgets.md).
 */
export type ScreenBlock = Block<'sd.screen'> & { spoken?: ScreenSpoken };
export type FigureBlock = Block<'sd.figure'>;

// ---------- backend and agentic blocks ----------

export type EstimateBlock = Block<'sd.estimate'>;
export type ChartBlock = Block<'sd.chart'>;
export type DbSchemaBlock = Block<'sd.db-schema'>;
export type EventContractBlock = Block<'sd.event-contract'>;
export type FailureModesBlock = Block<'sd.failure-modes'>;
export type ScaleStagesBlock = Block<'sd.scale-stages'>;
export type TimelineBlock = Block<'sd.timeline'>;
/** One of an agentic topic's tools, as the CMS returns it. */
export type TopicTool = CmsTopicTool;
/**
 * An sd.tool-catalog as the reader gets it. `catalog` is the topic's tools it shows, added when the
 * page is built (lib/server/tool-catalogs.ts), so the block renders on its own.
 */
export type ToolCatalogBlock = Block<'sd.tool-catalog'> & { catalog?: TopicTool[] };
export type AgentTraceBlock = Block<'sd.agent-trace'>;
export type ContextBudgetBlock = Block<'sd.context-budget'>;
export type EvalSuiteBlock = Block<'sd.eval-suite'>;
export type StripBlock = Block<'sd.strip'>;
/** An sd.lab as the reader gets it (the CMS shape, with its id); the file-shape type is content-kit's `LabBlock`. */
export type LabBlock = Block<'sd.lab'>;
/**
 * An sd.agent-lab as the reader gets it. `href` is the lab's page, added when the topic page is
 * built and only while agent labs are available there (lib/server/agent-labs.ts agentLabLinks); left
 * out, the card says the lab is not available yet.
 */
export type AgentLabBlock = Block<'sd.agent-lab'> & { href?: string | null };

/** Reader controls a coach tip can point at. */
export type CoachTarget = (typeof COACH_TARGETS)[number];
export type CoachTip = CmsCoachTip;

export type ContentBlock =
  | SectionBlock
  | SubsectionBlock
  | RichTextBlock
  | QaBlock
  | ChecklistBlock
  | MetricRowBlock
  | SplitListBlock
  | DiagramBlock
  | ComponentDiagramBlock
  | SequenceDiagramBlock
  | StateMachineBlock
  | OutcomeGridBlock
  | ChoiceListBlock
  | EndpointBlock
  | ErrorTableBlock
  | ActionFlowBlock
  | ComponentApiBlock
  | PriorityRubricBlock
  | DeepDiveBlock
  | DecisionBlock
  | RequirementTableBlock
  | TableBlock
  | CodeBlock
  | DataModelBlock
  | StatementBlock
  | CardGridBlock
  | QuizBlock
  | ScreenBlock
  | FigureBlock
  | EstimateBlock
  | ChartBlock
  | DbSchemaBlock
  | EventContractBlock
  | FailureModesBlock
  | ScaleStagesBlock
  | TimelineBlock
  | ToolCatalogBlock
  | AgentTraceBlock
  | ContextBudgetBlock
  | EvalSuiteBlock
  | StripBlock
  | LabBlock
  | AgentLabBlock;

export type Topic = TopicSummary & {
  eyebrow?: string | null;
  breadcrumb?: string | null;
  lede?: string | null;
  reviewStatus?: 'draft' | 'in-review' | 'reviewed' | null;
  /** Derived at build from git (content-kit derive.ts), never written by hand. */
  lastUpdated?: string | null;
  /** Derived at build: changes with any edit to the topic file. */
  contentVersion?: string | null;
  /** The editorial record (P1-9). */
  author?: string | null;
  reviewer?: string | null;
  reviewedAt?: string | null;
  provenance?: SnapshotTopic['provenance'];
  sources?: SnapshotTopic['sources'];
  /** The topic's components, declared once; blocks refer to them by key (P1-5). */
  components: TopicComponent[];
  /** An agentic topic's tools, declared once; sd.tool-catalog shows them. */
  tools: TopicTool[];
  kind?: SnapshotTopic['kind'];
  template?: SnapshotTopic['template'];
  agentProfile?: SnapshotTopic['agentProfile'];
  /** Topics to read first and topics worth reading alongside, as <system>/<topic> (P3-4). */
  prerequisites: string[];
  related: string[];
  content: ContentBlock[];
  coachTips?: CoachTip[] | null;
  system: { slug: string; name: string; icon?: string | null; generic?: boolean };
};

/** A section of the reader: the sd.section marker plus the blocks that follow it. */
export type ReaderSection = {
  section: SectionBlock;
  blocks: ContentBlock[];
  quiz: QuizBlock | null;
};

/** A section's sd.subsection markers, which stay in its blocks where they render as headings. */
export const subsOf = (s: ReaderSection): SubsectionBlock[] =>
  s.blocks.filter((b): b is SubsectionBlock => b.__component === 'sd.subsection');

/**
 * What the reader island is given of its topic besides the sections (P2-3): the header, the
 * components blocks refer to and the coach tips. Only these fields are serialized into the page,
 * so the content (passed once, as sections), the editorial record and anything server-only stay out.
 */
export type ReaderTopic = Pick<
  Topic,
  | 'title'
  | 'slug'
  | 'group'
  | 'order'
  | 'eyebrow'
  | 'breadcrumb'
  | 'lede'
  | 'reviewStatus'
  | 'readMinutes'
  | 'lastUpdated'
  | 'contentVersion'
  | 'components'
  | 'difficulty'
  | 'agentProfile'
> & {
  coachTips: CoachTip[];
  system: { slug: string; name: string; generic?: boolean };
};

export function toReaderTopic(t: Topic): ReaderTopic {
  return {
    title: t.title,
    slug: t.slug,
    group: t.group,
    order: t.order,
    eyebrow: t.eyebrow ?? null,
    breadcrumb: t.breadcrumb ?? null,
    lede: t.lede ?? null,
    reviewStatus: t.reviewStatus ?? null,
    readMinutes: t.readMinutes ?? null,
    lastUpdated: t.lastUpdated ?? null,
    // What the reader's progress is recorded against (P3-1).
    contentVersion: t.contentVersion ?? null,
    difficulty: t.difficulty ?? null,
    ...(t.agentProfile ? { agentProfile: t.agentProfile } : {}),
    components: t.components,
    coachTips: t.coachTips ?? [],
    system: { slug: t.system.slug, name: t.system.name, ...(t.system.generic ? { generic: true } : {}) },
  };
}

/**
 * The picker's view of a system (P2-3, P3-3): only what its card needs. The topics' details
 * (PickerTopic) load when the system's preview opens, from /catalog/<system>.json, so the page's
 * props stay small however big the catalog grows; only the topics there are to read come with
 * the page (`readable`), since progress, XP and today's pick are counted from them (P3-1, P3-9).
 */
export type PickerSystem = Pick<System, 'name' | 'slug' | 'example' | 'monogram' | 'icon'> & {
  problemClass: Pick<ProblemClass, 'slug' | 'name' | 'hue'>;
  /** Every topic's slug, in order. */
  topics: string[];
  /** The first three topics' titles, for the card. */
  preview: string[];
  /** The topics there are to read, in order. */
  readable: PickerReadable[];
};

/** A readable topic, as the picker counts progress and XP and draws today's pick from it. */
export type PickerReadable = Pick<TopicSummary, 'title' | 'slug' | 'readMinutes' | 'sectionCount' | 'quizCount' | 'xp'>;

/** One topic in a system's preview (/catalog/<system>.json). */
export type PickerTopic = Pick<
  TopicSummary,
  'title' | 'shortTitle' | 'slug' | 'summary' | 'wireframe' | 'group' | 'readMinutes' | 'available' | 'sectionCount' | 'difficulty'
>;

export function toPickerSystem(s: System): PickerSystem {
  return {
    name: s.name,
    slug: s.slug,
    example: s.example ?? null,
    monogram: s.monogram ?? null,
    icon: s.icon ?? null,
    problemClass: { slug: s.problemClass.slug, name: s.problemClass.name, hue: s.problemClass.hue },
    topics: s.topics.map((t) => t.slug),
    preview: s.topics.slice(0, 3).map((t) => t.title),
    readable: s.topics
      .filter((t) => t.available)
      .map((t) => ({ title: t.title, slug: t.slug, readMinutes: t.readMinutes ?? null, sectionCount: t.sectionCount ?? 0, quizCount: t.quizCount ?? 0, xp: t.xp ?? 0 })),
  };
}

export function toPickerTopics(s: System): PickerTopic[] {
  return s.topics.map((t) => ({
    title: t.title,
    shortTitle: t.shortTitle ?? null,
    slug: t.slug,
    summary: t.summary ?? null,
    wireframe: t.wireframe ?? null,
    group: t.group,
    readMinutes: t.readMinutes ?? null,
    available: t.available,
    sectionCount: t.sectionCount ?? 0,
    difficulty: t.difficulty ?? null,
  }));
}

/** The picker's view of a problem class: the order is already applied. */
export type PickerClass = Pick<ProblemClass, 'name' | 'slug' | 'description' | 'hue'>;

export const toPickerClass = (c: ProblemClass): PickerClass => ({ name: c.name, slug: c.slug, description: c.description ?? null, hue: c.hue });

// ---------- catalog ----------
// Everything comes from the content snapshot (content-snapshot.ts): content/ as validated at the
// start of this build or dev server. Strapi is not involved. The snapshot is loaded with a dynamic
// import so components that import this module's types never pull it into the browser bundle.

type Catalog = {
  problemClasses: ProblemClass[];
  tracks: Track[];
  systems: System[];
  topics: Topic[];
  picker: Picker;
  /** Old slugs of renamed topics and systems (P2-13): progress saved under one counts for the topic now. */
  aliases: SlugAliases;
  tags: SnapshotTag[];
  /** The content hash of the snapshot: versions files built from it (the search index, catalog JSON). */
  version: string;
};

const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;
const keyOf = (system: string, topic: string) => `${system}/${topic}`;

let built: { snapshot: ContentSnapshot; catalog: Catalog } | null = null;

/** The catalog, built once per snapshot (the dev server regenerates it when content/ changes). */
async function catalog(): Promise<Catalog> {
  const { getSnapshot } = await import('./content-snapshot');
  const snapshot = getSnapshot();
  if (built?.snapshot !== snapshot) built = { snapshot, catalog: buildCatalog(snapshot) };
  return built.catalog;
}

/** The snapshot's catalog in the shape pages use, with anything unsafe to render skipped and reported. */
export function buildCatalog(snapshot: ContentSnapshot): Catalog {
  // One bad topic must not stop the build: skip it, say why, and build the rest.
  for (const s of snapshot.skipped) reportWarning('Topic file failed validation or the content linter; the topic is not published', { file: s.file, problems: s.problems });

  const problemClasses = snapshot.problemClasses.map((c) => ({ ...c })).sort(byOrder);
  const classes = new Map(problemClasses.map((c) => [c.slug, c]));
  const systemsBySlug = new Map(snapshot.systems.map((s) => [s.slug, s]));

  const seen = new Set<string>();
  const topics: Topic[] = [];
  const sectionCounts = new Map<string, number>();
  const quizCounts = new Map<string, number>();
  for (const t of snapshot.topics) {
    const system = systemsBySlug.get(t.system);
    const key = keyOf(t.system, t.slug);
    if (!system) {
      reportWarning('Skipping topic with no system', { topic: key });
      continue;
    }
    if (seen.has(key)) {
      reportWarning('Skipping topic with a duplicate slug', { topic: key });
      continue;
    }
    seen.add(key);
    const problem = checkContent(t.content);
    if (problem) reportWarning('Topic content failed its shape check; the topic is not published', { topic: key, problem });
    const content = problem ? [] : (t.content as ContentBlock[]);
    sectionCounts.set(key, t.content.filter((b) => b.__component === 'sd.section').length);
    quizCounts.set(key, t.content.filter((b) => b.__component === 'sd.quiz').length);
    // The tutor brief stays on the server: topics are passed to the reader island as props.
    const { system: _s, file: _f, hash: _h, tutorBrief: _b, content: _c, group: groupKey, ...fields } = t;
    topics.push({
      ...fields,
      group: system.groups?.find((g) => g.key === groupKey)?.name ?? groupKey,
      groupKey,
      content,
      available: content.length > 0 && (t.reviewStatus === 'reviewed' || !FLAGS.reviewedOnly),
      coachTips: content.length ? snapshot.coachTips : [],
      system: { slug: system.slug, name: system.name, icon: system.icon, ...(system.generic ? { generic: true } : {}) },
    });
  }

  const systems: System[] = [];
  for (const s of snapshot.systems) {
    const problemClass = classes.get(s.problemClass);
    if (!problemClass) {
      reportWarning('Skipping system with no problem class', { system: s.slug });
      continue;
    }
    systems.push({
      ...s,
      groups: s.groups ?? [],
      problemClass,
      topics: topics
        .filter((t) => t.system.slug === s.slug)
        .map((t) => ({
          title: t.title,
          shortTitle: t.shortTitle,
          slug: t.slug,
          summary: t.summary,
          wireframe: t.wireframe,
          group: t.group,
          groupKey: t.groupKey,
          order: t.order,
          difficulty: t.difficulty,
          tags: t.tags,
          readMinutes: t.readMinutes,
          xp: t.xp,
          available: t.available,
          sectionCount: sectionCounts.get(keyOf(s.slug, t.slug)) ?? 0,
          quizCount: quizCounts.get(keyOf(s.slug, t.slug)) ?? 0,
        }))
        .sort(byOrder),
    });
  }
  systems.sort((a, b) => a.problemClass.order - b.problemClass.order || byOrder(a, b));

  return {
    problemClasses,
    tracks: [...(snapshot.tracks ?? [])].sort(byOrder),
    systems,
    topics,
    picker: snapshot.picker,
    aliases: snapshot.aliases ?? { topics: {}, systems: {} },
    tags: snapshot.tags ?? [],
    version: snapshot.contentHash,
  };
}

export async function getSystems(): Promise<System[]> {
  return (await catalog()).systems;
}

export async function getTracks(): Promise<Track[]> {
  return (await catalog()).tracks;
}

/** The track a system is on: its problem class's. */
export const trackOf = (system: Pick<System, 'problemClass'>): string | null => system.problemClass.track ?? null;

/** The track whose systems the system picker lists (/systems, design 6a): the one with view `library`. */
export async function getLibraryTrack(): Promise<Track | null> {
  return (await getTracks()).find((t) => t.view === 'library') ?? null;
}

/**
 * Where a track opens: the library is the system picker, a board is /tracks/<slug>. A track with no
 * readable-or-not systems yet opens nothing (null): the track picker draws it as planned.
 */
export function trackHref(track: Pick<Track, 'slug' | 'view'>, systems: readonly Pick<System, 'problemClass'>[]): string | null {
  if (!systems.some((s) => trackOf(s) === track.slug)) return null;
  return `/tracks/${track.slug}`;
}

export async function getProblemClasses(): Promise<ProblemClass[]> {
  return (await catalog()).problemClasses;
}

export async function getPicker(): Promise<Picker> {
  return (await catalog()).picker;
}

export async function getAliases(): Promise<SlugAliases> {
  return (await catalog()).aliases;
}

/** Every routable topic; `available` says whether its page is built (content that passed the checks, reviewed when required). */
export async function getTopics(): Promise<Topic[]> {
  return (await catalog()).topics;
}

export async function getTags(): Promise<SnapshotTag[]> {
  return (await catalog()).tags;
}

/**
 * The price catalog and free tier (content/pricing.yaml, Phase 4). Its helpers (priceFor,
 * displayMonthly, regionForCountry) are in @arrowbox/content-kit/pricing, which islands can import.
 */
export async function getPricing(): Promise<PricingFile> {
  const { getSnapshot } = await import('./content-snapshot');
  const pricing = getSnapshot().pricing;
  if (!pricing) throw new Error('No price catalog: content/pricing.yaml is missing');
  return pricing;
}

/** The systems anyone reads without signing in (pricing.yaml free.publicSystems); none without a catalog. */
export async function publicSystemsSet(): Promise<ReadonlySet<string>> {
  const pricing = await getPricing().catch(() => null);
  return new Set(pricing?.free.publicSystems ?? []);
}

/** The content version this build serves (the snapshot's hash). */
export async function getContentVersion(): Promise<string> {
  return (await catalog()).version;
}

/** Every system and every topic as the search index holds them (lib/search.ts), written or not. */
export async function searchDocs(): Promise<SearchDoc[]> {
  const { systems, topics, tags, tracks } = await catalog();
  const tagNames = new Map(tags.map((t) => [t.slug, t.name]));
  const trackNames = new Map(tracks.map((t) => [t.slug, t.name]));
  const trackName = (s: Pick<System, 'problemClass'>) => trackNames.get(trackOf(s) ?? '') ?? '';
  const bySlug = new Map(systems.map((s) => [s.slug, s]));
  const systemDocs: SearchDoc[] = systems.map((s) => ({
    id: `system:${s.slug}`,
    kind: s.problemClass.column === 'concepts' ? 'concept' : 'system',
    track: trackName(s),
    trackSlug: trackOf(s) ?? '',
    title: s.name,
    summary: s.summary ?? '',
    system: s.name,
    systemSlug: s.slug,
    slug: '',
    group: s.problemClass.name ?? '',
    tags: '',
    difficulty: null,
    available: s.topics.some((t) => t.available),
  }));
  const topicDocs: SearchDoc[] = topics.map((t) => ({
    id: `${t.system.slug}/${t.slug}`,
    kind: 'topic',
    track: bySlug.has(t.system.slug) ? trackName(bySlug.get(t.system.slug)!) : '',
    trackSlug: bySlug.get(t.system.slug)?.problemClass.track ?? '',
    title: t.title,
    summary: t.summary ?? '',
    system: t.system.name,
    systemSlug: t.system.slug,
    slug: t.slug,
    group: t.group,
    tags: (t.tags ?? []).map((s) => tagNames.get(s) ?? s).join(' '),
    difficulty: t.difficulty ?? null,
    available: t.available,
  }));
  return [...systemDocs, ...topicDocs];
}

// ---------- the catalog model: what to read next (P3-4) ----------

export const topicHref = (system: string, slug: string) => `/systems/${system}/${slug}`;

/** A topic suggested after this one; `href` is null for a topic that is not written yet, which offers "Notify me" (P3-2) by its `key`, <system>/<topic>. */
export type NextTopic = { title: string; group: string; href: string | null; reason: NextReason | 'soon'; key: string };

/** A topic this one points at (a prerequisite); `href` is null while it has no page. */
export type TopicLink = { title: string; href: string | null };

/**
 * What to read after `topic`, best first (content-kit's nextTopics: topics that build on it, then
 * the rest of its group, the next groups of its system, then its related topics; available ones
 * only). When none is available, the topic that would come next, as "Coming soon". The reader
 * shows the first one the reader hasn't finished.
 */
export function nextFor(topic: Topic, topics: readonly Topic[], systems: readonly System[], limit = 3): NextTopic[] {
  const ranks = new Map(systems.map((s) => [s.slug, new Map(s.groups.map((g, i) => [g.key, i]))]));
  const linked = topics.map((t) => ({ system: t.system.slug, slug: t.slug, group: t.groupKey, order: t.order, prerequisites: t.prerequisites, related: t.related, available: t.available, topic: t }));
  const current = linked.find((t) => t.topic === topic);
  if (!current) return [];
  const rank = (system: string, group: string) => ranks.get(system)?.get(group) ?? Number.MAX_SAFE_INTEGER;
  const { next, soon } = nextTopics(linked, current, rank, { limit });
  const card = (t: (typeof linked)[number], reason: NextTopic['reason']): NextTopic => ({
    title: t.topic.title,
    group: t.topic.group,
    href: t.available ? topicHref(t.system, t.slug) : null,
    reason,
    key: `${t.system}/${t.slug}`,
  });
  if (next.length) return next.map((c) => card(c.topic, c.reason));
  return soon ? [card(soon, 'soon')] : [];
}

/** The topic's prerequisites that exist, linked where they have a page. */
export function prerequisitesOf(topic: Topic, topics: readonly Topic[]): TopicLink[] {
  const byKey = new Map(topics.map((t) => [`${t.system.slug}/${t.slug}`, t]));
  return topic.prerequisites
    .map((k) => byKey.get(k))
    .filter((t): t is Topic => !!t)
    .map((t) => ({ title: t.title, href: t.available ? topicHref(t.system.slug, t.slug) : null }));
}

// ---------- content shape check ----------

/**
 * List fields each block needs before any renderer can walk it: repeatable components, which Strapi
 * always returns as arrays. Optional fields that may come back null (rich-text body) are left out;
 * the renderers treat them as empty.
 */
const LISTS: Partial<Record<ContentBlock['__component'], string[]>> = {
  'sd.qa-reveal': ['items'],
  'sd.checklist': ['items'],
  'sd.metric-row': ['items'],
  'sd.split-list': ['leftItems', 'rightItems'],
  'sd.diagram': ['nodes', 'notes'],
  'sd.table': ['columns', 'rows'],
  'sd.code': ['snippets'],
  'sd.component-diagram': ['groups', 'nodes', 'edges'],
  'sd.sequence-diagram': ['participants', 'steps'],
  'sd.state-machine': ['states', 'transitions'],
  'sd.outcome-grid': ['outcomes'],
  'sd.choice-list': ['items'],
  'sd.endpoint': ['responses'],
  'sd.error-table': ['rows'],
  'sd.action-flow': ['actions', 'scenarios'],
  'sd.component-api': ['props', 'children'],
  'sd.priority-rubric': ['areas'],
  'sd.deep-dive': ['targets', 'items'],
  'sd.decision': ['options'],
  'sd.requirement-table': ['rows'],
  'sd.data-model': ['groups', 'flows'],
  'sd.card-grid': ['cards'],
  'sd.quiz': ['questions'],
  'sd.screen': ['states', 'callouts', 'clients'],
  // The backend and agentic blocks' rows are json fields the schema requires.
  'sd.estimate': ['lines'],
  'sd.db-schema': ['stores'],
  'sd.event-contract': ['topics'],
  'sd.failure-modes': ['rows'],
  'sd.scale-stages': ['stages'],
  'sd.timeline': ['lanes'],
  'sd.agent-trace': ['scenarios'],
  'sd.context-budget': ['segments'],
  'sd.strip': ['legend', 'rows'],
  'sd.lab': ['engines', 'checks'],
  'sd.agent-lab': ['stages'],
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Where a topic's content breaks the shape the reader relies on, or null when it is fine.
 * A cheap guard against build-breaking content, not a full schema.
 */
export function checkContent(content: unknown): string | null {
  if (content == null) return null;
  if (!Array.isArray(content)) return 'content is not a list';
  for (const [i, b] of content.entries()) {
    if (!isObj(b) || typeof b.__component !== 'string' || typeof b.id !== 'number') return `block ${i}: not a component`;
    const at = `block ${i} ${b.__component}`;
    for (const f of LISTS[b.__component as ContentBlock['__component']] ?? []) {
      if (!Array.isArray(b[f])) return `${at} > ${f}: expected a list`;
    }
    switch (b.__component) {
      case 'sd.section':
      case 'sd.subsection':
        if (typeof b.title !== 'string') return `${at} > title: required`;
        break;
      case 'sd.action-flow':
        if (!isObj(b.screens) || !isObj(b.screens.screens)) return `${at} > screens.screens: expected an object`;
        break;
      case 'sd.component-api':
        if (!isObj(b.screen) || !Array.isArray(b.screen.fields)) return `${at} > screen.fields: expected a list`;
        break;
      case 'sd.data-model':
        if ((b.groups as unknown[]).some((g) => !isObj(g) || !Array.isArray(g.types))) return `${at} > groups[].types: expected a list`;
        break;
      case 'sd.db-schema':
        if ((b.stores as unknown[]).some((st) => !isObj(st) || !Array.isArray(st.tables) || st.tables.some((t) => !isObj(t) || !Array.isArray(t.columns))))
          return `${at} > stores[].tables[].columns: expected lists`;
        // What the renderer and relationships() dereference: a table's indexes and constraints (lists
        // of objects), an index's columns and include (lists), a column's roles (a list), references
        // and onDelete (strings).
        if (
          (b.stores as { tables: Record<string, unknown>[] }[]).some((st) =>
            st.tables.some(
              (t) =>
                ![t.indexes, t.constraints].every((v) => v == null || Array.isArray(v)) ||
                ((t.indexes ?? []) as unknown[]).some((ix) => !isObj(ix) || !Array.isArray(ix.columns) || !(ix.include == null || Array.isArray(ix.include))) ||
                ((t.constraints ?? []) as unknown[]).some((k) => !isObj(k)) ||
                (t.columns as unknown[]).some(
                  (c) =>
                    !isObj(c) ||
                    !(c.roles == null || Array.isArray(c.roles)) ||
                    !(c.references == null || typeof c.references === 'string') ||
                    !(c.onDelete == null || typeof c.onDelete === 'string'),
                ),
            ),
          )
        )
          return `${at} > stores[].tables[]: indexes, constraints, include and roles must be lists, references and onDelete text`;
        break;
      case 'sd.component-diagram': {
        // Steps are json: a list of objects whose highlight is a list and tones and labels are maps.
        const steps = b.steps ?? [];
        const strings = (v: unknown[]) => v.every((x) => typeof x === 'string');
        if (
          !Array.isArray(steps) ||
          steps.some(
            (st) =>
              !isObj(st) ||
              !(st.highlight == null || (Array.isArray(st.highlight) && strings(st.highlight))) ||
              [st.tones, st.labels].some((m) => m != null && !(isObj(m) && strings(Object.values(m)))),
          )
        )
          return `${at} > steps[]: expected objects with a highlight list and tones and labels maps of text`;
        break;
      }
      case 'sd.timeline':
        if (!isObj(b.axis) || typeof b.axis.from !== 'number' || typeof b.axis.to !== 'number') return `${at} > axis: expected { from, to }`;
        break;
      case 'sd.agent-trace':
        if ((b.scenarios as unknown[]).some((sc) => !isObj(sc) || !Array.isArray(sc.steps))) return `${at} > scenarios[].steps: expected a list`;
        break;
      case 'sd.strip': {
        // Rows, markers, spans and steps are json: every list the renderer maps must be one.
        const rowsOk = (rows: unknown) => Array.isArray(rows) && rows.every((r) => isObj(r) && Array.isArray(r.segments));
        const listOrNone = (v: unknown) => v == null || Array.isArray(v);
        if (!rowsOk(b.rows)) return `${at} > rows[].segments: expected a list`;
        if (!listOrNone(b.markers) || !listOrNone(b.spans)) return `${at} > markers, spans: expected lists`;
        if (!listOrNone(b.steps)) return `${at} > steps: expected a list`;
        const steps = (b.steps ?? []) as unknown[];
        if (steps.some((st) => !isObj(st) || (st.rows != null && !rowsOk(st.rows)) || !listOrNone(st.markers) || !listOrNone(st.spans) || !listOrNone(st.highlight)))
          return `${at} > steps[]: rows[].segments, markers, spans and highlight must be lists`;
        break;
      }
      case 'sd.lab': {
        // The json fields the static view maps: engines and checks are lists, the starter an object of engine maps.
        const engines = b.engines as unknown[];
        if (engines.some((e) => e !== 'postgres' && e !== 'mysql')) return `${at} > engines: expected postgres or mysql`;
        if ((b.checks as unknown[]).some((c) => !isObj(c) || typeof c.label !== 'string' || !isObj(c.assert))) return `${at} > checks[]: expected { key, label, assert }`;
        if (!isObj(b.starter) || [b.starter.postgres, b.starter.mysql].some((m) => m != null && !(isObj(m) && Object.values(m).every((x) => typeof x === 'string'))))
          return `${at} > starter: expected text per pane`;
        if (b.hints != null && !(Array.isArray(b.hints) && b.hints.every((h) => typeof h === 'string'))) return `${at} > hints: expected a list of text`;
        if (b.reference != null && !isObj(b.reference)) return `${at} > reference: expected text per engine`;
        break;
      }
      case 'sd.agent-lab':
        // The card lists the stage titles (a json field).
        if ((b.stages as unknown[]).some((x) => typeof x !== 'string')) return `${at} > stages: expected a list of text`;
        break;
      case 'sd.quiz':
        if ((b.questions as unknown[]).some((q) => !isObj(q) || !['A', 'B', 'C', 'D'].includes(String(q.answer))))
          return `${at} > questions[].answer: expected A, B, C or D`;
        break;
    }
  }
  return null;
}

/** Splits a topic's flat content into sections at each sd.section marker. */
export function toSections(content: ContentBlock[]): ReaderSection[] {
  const sections: ReaderSection[] = [];
  for (const block of content) {
    if (block.__component === 'sd.section') {
      sections.push({ section: block, blocks: [], quiz: null });
    } else if (sections.length === 0) {
      // Blocks before the first section have nowhere to live.
      reportWarning('Dropping a block that comes before the first section', { block: block.__component, id: block.id });
    } else if (block.__component === 'sd.quiz') {
      sections[sections.length - 1].quiz = block;
    } else {
      sections[sections.length - 1].blocks.push(block);
    }
  }
  return sections;
}

export function monogram(name: string, override?: string | null): string {
  if (override) return override;
  return (name.includes(' ') ? name.split(' ').map((w) => w[0]).join('').slice(0, 2) : name[0]).toUpperCase();
}
