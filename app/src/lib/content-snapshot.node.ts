import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { CATALOG_VERSION, derivePlans, deriveSectionPlan, encodeBreadcrumb, errorsOf, formatIssues, formatLint, lintTopic, resolveTopicRef, strapiSchemas, toCmsBlock, toCmsComponents, toCmsTools, validateTopic, type InterviewRecord, type ProseFile, type SystemEntry, type TopicFile } from '@arrowbox/content-kit';
import { ALIASES_FILE, datesWarning, deriveMeta, FILES, lintContent, TAGS_FILE, type DerivedMeta, type TopicRecord } from '@arrowbox/content-kit/node';
import { PRICING_FILE } from '@arrowbox/content-kit/pricing';
import { REVIEWS_FILE } from '@arrowbox/content-kit/reviews';
import type { AstroIntegration, AstroIntegrationLogger } from 'astro';
import { parse as parseYaml } from 'yaml';
import type { ContentSnapshot, SnapshotDrill, SnapshotInterview, SnapshotPicker, SnapshotTopic } from './content-snapshot';
// With their extensions: scripts/content-snapshot.ts runs this module under Node itself.
import { FREE_PREFIX } from './gated.ts';
import { freeCut } from './free-tier.ts';

// Builds app/.content/snapshot.json from lego's content/ (Node only: the astro config and tests
// use it). The catalog files (systems, problem classes, UI
// copy) must be valid or nothing is built; a topic file that fails validation or has a lint error
// (npm run content:lint) is left out and reported, so one bad topic never stops the others from
// shipping. readMinutes, lastUpdated and contentVersion are derived here (content-kit derive.ts).

/**
 * Bumped when the snapshot's own layout changes. 2: derived and editorial topic fields. 3: topic
 * components. 4: slug aliases (P2-13). 5: the catalog model (P3-4): systems' groups, tags, and
 * topics' difficulty, tags, prerequisites and related topics.
 * 6: mock interview plans (P3-11). 7: the price catalog and free tier (Phase 4). 8: reader reviews
 * (Phase 4). 9: backend and agentic topics: a topic's kind, template, agentProfile and tools.
 * 10: tracks (design 15a, 16a): the tracks, a problem class's track, column and note, and a
 * system's summary, buildsOn, generic and pattern. 11: interview plans derived from the topics'
 * sections (ADR 0003): one per system with a design article, with coverage items and sections.
 * 12: practice drills (a topic's and each section's short interview) for the tracks that opt in
 * (tracks.yaml interviewDrills), and the flag on the track.
 */
export const SNAPSHOT_FORMAT = 13;

/**
 * Strapi's defaults for fields a file may leave out, so pages look as they did when they were
 * built from the CMS (cms/src/api/<type>/content-types/<type>/schema.json; content-snapshot.test.ts
 * checks they still match).
 */
export const DEFAULTS = {
  topic: { order: 0, xp: 200, eyebrow: 'Design', reviewStatus: 'draft' },
  system: { order: 0, generic: false },
  problemClass: { hue: 255, order: 0 },
  picker: {
    title: 'What are we designing?',
    searchPlaceholder: 'Filter apps and topics',
    classLabel: 'Problem class',
    allLabel: 'All systems',
    featuredLabel: 'Today’s pick',
    focusLabel: 'Choose your focus',
    startLabel: 'Start reading →',
    emptyText: 'No systems match',
  } satisfies SnapshotPicker,
} as const;

const hash = (value: unknown, length: number) => createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, length);

/** Component ids per block start at a multiple of this, so ids stay put when a later block changes. */
const IDS_PER_BLOCK = 1000;

function toTopic({ system, slug, file, data }: TopicRecord, meta: DerivedMeta | undefined): SnapshotTopic {
  // Lists are encoded as the CMS stores them (STRING_LISTS): the renderers read the CMS shape.
  const content = (data.content ?? []).map((b, i) => toCmsBlock(b, (i + 1) * IDS_PER_BLOCK));
  const topic: Omit<SnapshotTopic, 'hash'> = {
    system,
    slug,
    file,
    title: data.title,
    shortTitle: data.shortTitle ?? null,
    summary: data.summary ?? null,
    wireframe: data.wireframe ?? null,
    group: data.group,
    order: data.order ?? DEFAULTS.topic.order,
    difficulty: data.difficulty ?? null,
    tags: data.tags ?? [],
    prerequisites: (data.prerequisites ?? []).map((r) => resolveTopicRef(r, system)),
    related: (data.related ?? []).map((r) => resolveTopicRef(r, system)),
    xp: data.xp ?? DEFAULTS.topic.xp,
    eyebrow: data.eyebrow ?? DEFAULTS.topic.eyebrow,
    breadcrumb: encodeBreadcrumb(data.breadcrumb),
    lede: data.lede ?? null,
    reviewStatus: data.reviewStatus ?? DEFAULTS.topic.reviewStatus,
    author: data.author ?? null,
    reviewer: data.reviewer ?? null,
    reviewedAt: data.reviewedAt ?? null,
    provenance: data.provenance ?? null,
    sources: (data.sources ?? []).map((s) => ({ title: s.title, url: s.url, note: s.note ?? null })),
    readMinutes: meta?.readMinutes ?? null,
    lastUpdated: meta?.lastUpdated ?? null,
    contentVersion: meta?.contentVersion ?? null,
    tutorBrief: data.tutorBrief?.trim() || null,
    kind: data.kind ?? null,
    template: data.template ?? null,
    agentProfile: data.agentProfile ?? null,
    components: toCmsComponents(data.components),
    tools: toCmsTools(data.tools),
    content,
  };
  // The date alone (a new commit, a fresh checkout) doesn't change what the topic says.
  const { lastUpdated: _d, ...hashed } = topic;
  return { ...topic, hash: hash(hashed, 12) };
}

/**
 * A system's interview plan as the interview service reads it (ADR 0003): derived from the
 * system's topics that validated, with its hand-written plan (content/interviews/<system>.yaml)
 * merged in where one exists. Private fields included; pages get a projection (lib/interview.ts).
 * Null for a system with no system interview (concept articles only).
 */
function toInterview(system: SystemEntry, topics: readonly TopicRecord[], override: InterviewRecord | null, prose: readonly ProseFile[]): SnapshotInterview | null {
  const set = derivePlans({ system, topics: topics.map((t) => ({ slug: t.slug, file: t.file, data: t.data })), override: override?.data ?? null, prose });
  const plan = set.system;
  if (!plan) return null;
  const derived = plan.override !== 'whole';
  const sourceTopics = derived ? plan.sourceTopics : [];
  const lead = topics.find((t) => t.slug === plan.sourceTopics[0]);
  const reviewed = (derived ? sourceTopics.every((slug) => topics.find((t) => t.slug === slug)?.data.reviewStatus === 'reviewed') : true) && (!override || override.data.reviewStatus === 'reviewed');
  const entry: Omit<SnapshotInterview, 'hash'> = {
    system: system.slug,
    file: override?.file ?? lead?.file ?? `${system.slug}/`,
    reviewStatus: reviewed ? 'reviewed' : 'draft',
    plan,
    sourceTopics,
    derived,
  };
  // Sessions record the plan's hash, so a plan edited mid-session is noticed; the rubric is pinned to it.
  return { ...entry, hash: hash(entry, 12) };
}

/**
 * A system's practice drills (docs/README.md, "Drills"): each topic with content as a
 * short interview of its own, and each of that topic's sections as a one-stage drill. Derived from
 * the same input as the system plan, so a drill's items are the ones the whole interview asks on
 * that section. A drill follows its topic's review status.
 */
function toDrills(system: SystemEntry, topics: readonly TopicRecord[], prose: readonly ProseFile[]): SnapshotDrill[] {
  const input = { system, topics: topics.map((t) => ({ slug: t.slug, file: t.file, data: t.data })), override: null, prose };
  const out: SnapshotDrill[] = [];
  const add = (topic: TopicRecord, section: string | null, plan: SnapshotDrill['plan']) => {
    const entry: Omit<SnapshotDrill, 'hash'> = { system: system.slug, topic: topic.slug, section, file: topic.file, reviewStatus: topic.data.reviewStatus ?? 'draft', plan };
    out.push({ ...entry, hash: hash(entry, 12) });
  };
  for (const plan of derivePlans(input).topics) {
    const topic = topics.find((t) => t.slug === plan.topic);
    if (!topic) continue;
    add(topic, null, plan);
    for (const s of plan.sections) {
      const section = deriveSectionPlan(input, topic.slug, s.sectionKey);
      if (section) add(topic, s.sectionKey, section);
    }
  }
  return out;
}

// pricing.yaml among them: the site never builds with a price or a free tier that failed its checks;
// reviews.yaml too: a review that breaks the honesty rules (a "verified" sample) stops the build.
const catalogFiles = new Set<string>([...Object.values(FILES), ALIASES_FILE, TAGS_FILE, PRICING_FILE, REVIEWS_FILE]);

type BuildOptions = {
  /** Told about things worth a look that don't stop the build (dates from a shallow clone, or none). */
  warn?: (message: string) => void;
  /** lego-ai's own articles (app/articles), added to the main site's topics (readOwnArticles). */
  articlesDir?: string;
};

/**
 * lego-ai's own articles: topic files in the main site's format under app/articles/<system>/<slug>.yaml
 * (frontend) or app/articles/backend/<system>/<slug>.yaml (backend, the snapshot's backendTopics), for an
 * existing system of content/. They are written for the coaching playlists (docs/coaching.md)
 * and live only in this app's snapshot: the main site does not list or serve them, and they are left
 * out of the systems' interview plans and drills. Each is validated and linted as content/'s topics
 * are; one with an error is skipped and reported.
 */
/** app/articles/backend: BACKEND in content-snapshot.ts, which this file can only import types from (it reads the snapshot with ?raw). */
const BACKEND = 'backend';

export type OwnTopic = TopicRecord & { backend?: true };

export function readOwnArticles(dir: string, systems: readonly SystemEntry[], taken: ReadonlySet<string>): { topics: OwnTopic[]; problems: Map<string, string[]> } {
  const topics: OwnTopic[] = [];
  const problems = new Map<string, string[]>();
  if (!existsSync(dir)) return { topics, problems };
  const skip = (file: string, message: string) => problems.set(file, [...(problems.get(file) ?? []), message]);
  // articles/<system>/ are frontend articles, beside content/'s topics; articles/backend/<system>/ are backend ones,
  // kept apart (the snapshot's backendTopics), so they may share a system and a slug with a frontend article.
  const read = (root: string, prefix: string, backend: boolean, clash: ReadonlySet<string>) => {
    for (const system of readdirSync(root).sort()) {
      const full = join(root, system);
      if (system.startsWith('.') || !statSync(full).isDirectory()) continue;
      if (!backend && system === BACKEND) continue;
      const entry = systems.find((s) => s.slug === system);
      for (const name of readdirSync(full).sort()) {
        if (!name.endsWith('.yaml')) continue;
        const slug = name.slice(0, -'.yaml'.length);
        const file = `${prefix}/${system}/${name}`;
        if (!entry) {
          skip(file, `${file}: no system "${system}" in the main site's content/systems.yaml`);
          continue;
        }
        if (clash.has(`${system}/${slug}`)) {
          skip(file, `${file}: content/ already has a topic ${system}/${slug}`);
          continue;
        }
        let value: unknown;
        try {
          value = parseYaml(readFileSync(join(full, name), 'utf8'));
        } catch (err) {
          skip(file, `${file}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
          continue;
        }
        const r = validateTopic(value);
        if (!r.ok) {
          skip(file, `${file}:\n${formatIssues(r.issues.map((i) => ({ ...i, file })))}`);
          continue;
        }
        const errors = errorsOf(lintTopic(r.data, { groups: entry.groups }));
        if (errors.length) {
          skip(file, formatLint(errors.map((i) => ({ ...i, file }))));
          continue;
        }
        topics.push({ system, slug, file, data: r.data as TopicFile, ...(backend ? { backend: true as const } : {}) });
      }
    }
  };
  read(dir, 'articles', false, taken);
  if (existsSync(join(dir, BACKEND))) read(join(dir, BACKEND), `articles/${BACKEND}`, true, new Set());
  return { topics, problems };
}

/** Reads, validates and lints content/ and returns the snapshot. Throws when a catalog file is invalid. */
export function buildSnapshot(contentDir: string, { warn, articlesDir }: BuildOptions = {}): ContentSnapshot {
  if (!existsSync(contentDir)) throw new Error(`No content directory at ${contentDir} (set CONTENT_DIR)`);
  const { catalog, issues } = lintContent(contentDir);
  const fatal = issues.filter((i) => i.rule === 'schema' && catalogFiles.has(i.file ?? ''));
  if (fatal.length) {
    throw new Error(`${formatIssues(fatal)}\n\nThe catalog files in content/ must be valid to build the site (npm run content:validate).`);
  }
  // Validation problems and lint errors skip the topic; warnings never do.
  const problems = new Map<string, string[]>();
  const skip = (file: string, message: string) => problems.set(file, [...(problems.get(file) ?? []), message]);
  for (const i of issues) if (i.severity === 'error') skip(i.file ?? '(content)', i.rule === 'schema' ? formatIssues([i]) : formatLint([i]));

  // lastUpdated: git, else content/.dates.json (a Docker build), else left out (never the mtime).
  const derived = deriveMeta(contentDir, catalog.topics);
  const { meta } = derived;
  const datesProblem = catalog.topics.length ? datesWarning(derived) : null;
  if (datesProblem) warn?.(datesProblem);
  const topics: SnapshotTopic[] = [];
  for (const t of catalog.topics) {
    if (problems.has(t.file)) continue;
    try {
      topics.push(toTopic(t, meta.get(t.file)));
    } catch (err) {
      skip(t.file, `${t.file}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }

  // lego-ai's own articles (app/articles), after content/'s topics; not in the interview plans or drills below.
  const backendTopics: SnapshotTopic[] = [];
  if (articlesDir) {
    const own = readOwnArticles(articlesDir, catalog.systems, new Set(catalog.topics.map((t) => `${t.system}/${t.slug}`)));
    for (const [file, list] of own.problems) problems.set(file, list);
    // Files are named from the app directory (articles/<system>/<topic>.yaml, articles/backend/<system>/<topic>.yaml).
    const ownMeta = deriveMeta(dirname(articlesDir), own.topics).meta;
    for (const t of own.topics) (t.backend ? backendTopics : topics).push(toTopic(t, ownMeta.get(t.file)));
  }

  // A problem class that names no track is the library's (the system picker's, design 6a).
  const libraryTrack = catalog.tracks.find((t) => t.view === 'library')?.slug ?? null;
  const body: Omit<ContentSnapshot, 'contentHash'> = {
    format: SNAPSHOT_FORMAT,
    catalogVersion: CATALOG_VERSION,
    problemClasses: catalog.problemClasses.map((c) => ({
      slug: c.slug,
      name: c.name,
      description: c.description ?? null,
      hue: c.hue ?? DEFAULTS.problemClass.hue,
      order: c.order ?? DEFAULTS.problemClass.order,
      track: c.track ?? libraryTrack,
      column: c.column ?? null,
      note: c.note ?? null,
    })),
    tracks: catalog.tracks.map((t) => ({
      slug: t.slug,
      name: t.name,
      strip: t.strip,
      text: t.text,
      order: t.order ?? 0,
      view: t.view,
      featured: t.featured ?? [],
      interviewDrills: t.interviewDrills ?? false,
      examples: t.examples ?? [],
      figure: t.figure ?? null,
      board: t.board
        ? {
            heading: t.board.heading,
            accent: t.board.accent ?? null,
            conceptsTitle: t.board.conceptsTitle,
            conceptsText: t.board.conceptsText ?? null,
            systemsTitle: t.board.systemsTitle,
            systemsText: t.board.systemsText ?? null,
            focusLabel: t.board.focusLabel ?? null,
          }
        : null,
    })),
    systems: catalog.systems.map((s) => ({
      slug: s.slug,
      name: s.name,
      example: s.example ?? null,
      monogram: s.monogram ?? null,
      icon: s.icon ?? null,
      order: s.order ?? DEFAULTS.system.order,
      problemClass: s.problemClass,
      summary: s.summary ?? null,
      generic: s.generic ?? DEFAULTS.system.generic,
      pattern: s.pattern ?? null,
      buildsOn: s.buildsOn ?? [],
      groups: (s.groups ?? []).map((g) => ({ key: g.key, name: g.name, summary: g.summary ?? null })),
    })),
    topics,
    backendTopics,
    picker: { ...DEFAULTS.picker, ...catalog.picker },
    tags: (catalog.tags ?? []).map((t) => ({ slug: t.slug, name: t.name, description: t.description ?? null })),
    coachTips: catalog.coachTips.map((t, i) => strapiSchemas.coachTip.parse({ id: i + 1, ...t })),
    // Old slugs (P2-13): only aliases to a topic or system this build has; the linter reports the rest.
    aliases: {
      topics: Object.fromEntries(Object.entries(catalog.aliases.topics).filter(([, to]) => topics.some((t) => `${t.system}/${t.slug}` === to))),
      systems: Object.fromEntries(Object.entries(catalog.aliases.systems).filter(([, to]) => catalog.systems.some((s) => s.slug === to))),
    },
    // Derived from the topics that validated; a hand-written plan with a lint error is left out like a topic (reported under skipped).
    interviews: catalog.systems.flatMap((s) => {
      const own = catalog.topics.filter((t) => t.system === s.slug && !problems.has(t.file));
      if (!own.some((t) => t.data.content?.length)) return [];
      const override = catalog.interviews.find((i) => i.system === s.slug && !problems.has(i.file)) ?? null;
      const entry = toInterview(s, own, override, catalog.prose.map((p) => p.data));
      return entry ? [entry] : [];
    }),
    // Drills only on the tracks that opt in (tracks.yaml interviewDrills): the other tracks' prose is still being refined.
    drills: catalog.systems.flatMap((s) => {
      const track = catalog.problemClasses.find((c) => c.slug === s.problemClass)?.track ?? libraryTrack;
      if (!catalog.tracks.find((t) => t.slug === track)?.interviewDrills) return [];
      const own = catalog.topics.filter((t) => t.system === s.slug && !problems.has(t.file));
      return own.some((t) => t.data.content?.length) ? toDrills(s, own, catalog.prose.map((p) => p.data)) : [];
    }),
    pricing: catalog.pricing,
    reviews: catalog.reviews,
    skipped: [...problems].map(([file, list]) => ({ file, problems: list })),
  };
  const { format, catalogVersion, ...rest } = body;
  return { format, catalogVersion, contentHash: hash(body, 16), ...rest };
}

/**
 * The snapshot is imported as one string (`snapshot.json?raw`). Vite's worker and asset-URL
 * plugins scan any module that contains `new Worker(`, `new SharedWorker(` or `new URL(` text with a
 * JavaScript tokenizer, and on a string of tens of megabytes that overflows the stack ("Maximum
 * call stack size exceeded"): three topics show those lines as code examples. Writing one
 * character of each as a JSON escape keeps the file the same JSON (JSON.parse gives the same
 * text back) and keeps the plugins from matching. These sequences only occur inside strings.
 */
export function inertForBundlers(json: string): string {
  return json
    .replaceAll('new Worker(', 'new Worker\\u0028')
    .replaceAll('new SharedWorker(', 'new SharedWorker\\u0028')
    .replaceAll('new URL(', 'new URL\\u0028')
    .replaceAll('import.meta.url', 'import.meta.\\u0075rl');
}

/**
 * Writes the snapshot to `outFile` (atomically, and only when it changed, so a dev server's
 * watcher isn't woken for nothing).
 */
export function writeSnapshot(contentDir: string, outFile: string, options: BuildOptions = {}): { snapshot: ContentSnapshot; written: boolean } {
  const snapshot = buildSnapshot(contentDir, options);
  const text = `${inertForBundlers(JSON.stringify(snapshot))}\n`;
  if (existsSync(outFile) && readFileSync(outFile, 'utf8') === text) return { snapshot, written: false };
  mkdirSync(dirname(outFile), { recursive: true });
  const tmp = `${outFile}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, outFile);
  return { snapshot, written: true };
}

export function describeSnapshot(s: ContentSnapshot): string {
  const authored = s.topics.filter((t) => t.content.length).length;
  return (
    `content ${s.contentHash} (catalog v${s.catalogVersion}): ${s.topics.length} topics (${authored} with content), ` +
    `${s.systems.length} systems, ${s.interviews.length} interview plans, ${s.drills.length} drills${s.skipped.length ? `, ${s.skipped.length} file(s) skipped` : ''}`
  );
}

/**
 * A warning when a reviewed-only build (PUBLIC_REVIEWED_ONLY=true, the web image's default) would
 * have no readable topic: every topic with content is still in draft or review. Not a failure:
 * shipping without readable topics until one is reviewed is an editorial decision.
 */
export function noReviewedTopic(s: ContentSnapshot, reviewedOnly: boolean): string | null {
  const authored = s.topics.filter((t) => t.content.length);
  if (!reviewedOnly || !authored.length || authored.some((t) => t.reviewStatus === 'reviewed')) return null;
  return (
    `PUBLIC_REVIEWED_ONLY=true and none of the ${authored.length} topic(s) with content is reviewed ` +
    `(${authored.map((t) => `${t.system}/${t.slug}: ${t.reviewStatus}`).join(', ')}): this build has nothing to read (docs/content-workflow.md).`
  );
}

/**
 * Why this build would serve fewer full designs than content/pricing.yaml gives Free readers (the
 * plan cards promise every one of them): a free topic skipped for its errors, without content, or
 * not reviewed in a reviewed-only build (the rule `available` follows in sd.ts). [] when every one
 * is readable, and when there is no price catalog.
 */
export function freeTierProblems(s: ContentSnapshot, reviewedOnly: boolean): string[] {
  const out: string[] = [];
  for (const path of s.pricing?.free.fullTopics ?? []) {
    const t = s.topics.find((x) => `${x.system}/${x.slug}` === path);
    const why = !t
      ? 'is skipped (see above)'
      : !t.content.length
        ? 'has no content'
        : reviewedOnly && t.reviewStatus !== 'reviewed'
          ? `is ${t.reviewStatus} and PUBLIC_REVIEWED_ONLY=true`
          : null;
    if (why) out.push(`pricing.yaml free.fullTopics: ${path} ${why}, so Free readers get fewer full designs than the plan cards promise.`);
  }
  for (const system of s.pricing?.free.publicSystems ?? []) {
    if (!s.topics.some((x) => x.system === system && x.content.length))
      out.push(`pricing.yaml free.publicSystems: ${system} has no readable topic, so it opens nothing to signed-out readers.`);
  }
  return out;
}

/**
 * Default locations: the main site's content/ (a checkout of lego beside lego-ai, so
 * ../../lego/content from app/; CONTENT_DIR overrides it), the snapshot in app/.content/.
 */
export function snapshotPaths(appDir: string) {
  return {
    contentDir: resolve(process.env.CONTENT_DIR ?? join(appDir, '..', '..', 'lego', 'content')),
    articlesDir: join(appDir, 'articles'),
    outFile: join(appDir, '.content', 'snapshot.json'),
  };
}

/**
 * Regenerates the snapshot when `astro build`, `astro dev` (and `astro sync`/`check`) start, and
 * in dev whenever a file under content/ changes. A build fails when the catalog files are invalid;
 * the dev server keeps its last good snapshot and says why.
 */
export function contentSnapshot({ contentDir, outFile, articlesDir }: { contentDir: string; outFile: string; articlesDir?: string }): AstroIntegration {
  const generate = (logger: AstroIntegrationLogger) => {
    const { snapshot, written } = writeSnapshot(contentDir, outFile, { warn: (m) => logger.warn(m), articlesDir });
    logger.info(describeSnapshot(snapshot));
    for (const s of snapshot.skipped) logger.warn(`Skipped ${s.file}:\n${s.problems.join('\n')}`);
    const reviewedOnly = process.env.PUBLIC_REVIEWED_ONLY === 'true';
    const unreadable = noReviewedTopic(snapshot, reviewedOnly);
    if (unreadable) logger.warn(unreadable);
    // A build with billing sells against the free tier, so it fails; any other build only warns.
    const freeTier = freeTierProblems(snapshot, reviewedOnly);
    if (freeTier.length && process.env.PUBLIC_BILLING === 'true') throw new Error(`${freeTier.join('\n')}\n\nFix the topics or free.fullTopics before building with PUBLIC_BILLING=true.`);
    for (const p of freeTier) logger.warn(p);
    return written;
  };
  let serverDir: URL | undefined;
  return {
    name: 'arrowbox:content-snapshot',
    hooks: {
      'astro:config:setup': ({ command, logger }) => {
        try {
          generate(logger);
        } catch (err) {
          if (command !== 'dev' || !existsSync(outFile)) throw err;
          logger.error(`Keeping the previous content snapshot: ${err instanceof Error ? err.message : err}`);
        }
      },
      'astro:server:setup': ({ server, logger }) => {
        server.watcher.add(contentDir);
        if (articlesDir) server.watcher.add(articlesDir);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onChange = (file: string) => {
          if (!file.startsWith(contentDir + sep) && !(articlesDir && file.startsWith(articlesDir + sep))) return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            try {
              // Vite sees the new snapshot like any other changed module and reloads the page.
              generate(logger);
            } catch (err) {
              logger.error(`content/ has problems; the dev server keeps the previous snapshot.\n${err instanceof Error ? err.message : err}`);
            }
          }, 150);
        };
        server.watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
      },
      'astro:config:done': ({ config }) => {
        serverDir = config.build.server;
      },
      // The price catalog beside the server bundle, for scripts/billing-sync-plans.mjs, which runs
      // from the production image (no content/ there) to create the Razorpay plans it sells.
      'astro:build:done': () => {
        const pricing = (JSON.parse(readFileSync(outFile, 'utf8')) as ContentSnapshot).pricing;
        if (serverDir && pricing) writeFileSync(new URL('pricing.json', serverDir), `${JSON.stringify(pricing, null, 2)}\n`);
      },
    },
  };
}

/** Tutor briefs found in the browser-facing build output (they must only be in dist/server). */
export function findLeakedBriefs(snapshot: ContentSnapshot, clientDir: string): string[] {
  const needles = snapshot.topics
    .filter((t) => t.tutorBrief && t.tutorBrief.length >= 40)
    .map((t) => ({ topic: `tutor brief of ${t.system}/${t.slug}`, text: t.tutorBrief!.slice(0, 60) }));
  // Interview plans' private fields (P3-11, ADR 0003): the interviewer's notes, the grader's brief
  // and the items' probes belong to the interview service only. A derived plan's signals and
  // follow-ups are the articles' own words (they are on the topic pages), so only the written
  // notes and the derived probes are checked.
  const plans = [...(snapshot.interviews ?? []).map((i) => ({ ...i, label: i.system })), ...(snapshot.drills ?? []).map((d) => ({ ...d, derived: true, label: `${d.system}/${d.topic}${d.section ? `#${d.section}` : ''}` }))];
  for (const i of plans) {
    const written = i.derived ? [] : i.plan.stages.flatMap((s) => [...s.signals, ...(s.redFlags ?? []), ...(s.followUps ?? [])]);
    const probes = i.plan.stages.flatMap((s) => s.items.flatMap((item) => [item.probe, ...(item.wrongSignals ?? [])]));
    const secret = [i.plan.graderBrief, ...i.plan.stages.map((s) => s.brief), ...written, ...probes];
    for (const text of secret) if (text && text.length >= 40) needles.push({ topic: `private interview notes of ${i.label}`, text: text.slice(0, 60) });
  }
  // The whiteboard matcher (design section 7, board-match.ts) tells the interviewer what a board is
  // missing; that text, and so the module, must stay on the server: the room never learns what it has not drawn.
  needles.push({ topic: 'the whiteboard matcher (server/interview/board-match.ts)', text: 'Not on the board yet, though the design should have it by now' });
  const leaks: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(html|js|mjs|json|txt)$/.test(name)) {
        const text = readFileSync(p, 'utf8');
        for (const n of needles) if (text.includes(n.text)) leaks.push(`${p}: ${n.topic}`);
      }
    }
  };
  if (existsSync(clientDir)) walk(clientDir);
  return leaks;
}

/** Every string in a value (a block's text, nested lists and rich text), in order. */
function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== '__component') stringsOf(x, out);
  return out;
}

/**
 * Text a Free reader must not get of a topic (lib/free-tier.ts): a snippet of each longer string in
 * what the free tier's cut leaves out (the locked blocks, the dropped section intros, the component
 * cards and the tutor brief), unless the same words are in what it keeps. Snippets stop short of
 * characters HTML escapes, so they match the built page as written.
 */
export function lockedSnippets(t: SnapshotTopic, previewKeys: readonly string[], shown = ''): string[] {
  const cut = freeCut(t.content, previewKeys);
  const kept = new Set(cut.content);
  // A component's name, number and links draw a preview diagram's boxes (TopicPage keeps them in the
  // Free variant); what it does and owns is the locked prose.
  const prose = (t.components ?? []).flatMap((c) => [String((c as { summary?: unknown }).summary ?? ''), ...stringsOf((c as { owns?: unknown }).owns)]);
  const locked: string[] = [t.tutorBrief ?? '', ...prose, ...stringsOf(t.tools)];
  for (const b of t.content) {
    if (b.__component === 'sd.section') locked.push(String((b as { intro?: unknown }).intro ?? ''));
    else if (!kept.has(b)) locked.push(...stringsOf(b));
  }
  // `shown`: what any page shows besides the article (other topics' titles, references and links in the
  // navigation), so naming another topic in a locked block isn't a leak of it.
  const open = [t.title, t.lede ?? '', t.summary ?? '', ...stringsOf(cut.content), shown].join('\n');
  const out = new Set<string>();
  for (const text of locked) {
    const run = text.split(/[&<>"'\n]/).find((r) => r.trim().length >= 32);
    const snippet = run?.trim().slice(0, 48);
    if (snippet && !open.includes(snippet)) out.add(snippet);
  }
  return [...out];
}

/**
 * Locked text found in the Free variants of the topic pages (`<gatedDir>/v/free/`, a build with
 * PUBLIC_BILLING): what a Free reader is served must carry none of what their plan locks.
 */
export function findLockedLeaks(snapshot: ContentSnapshot, gatedDir: string): string[] {
  const free = snapshot.pricing?.free;
  if (!free) return [];
  const leaks: string[] = [];
  // The chrome's words: every topic's titles, references and links (rail, next, builds-on, search).
  const shown = snapshot.topics
    .flatMap((x) => [x.title, (x as { shortTitle?: string | null }).shortTitle ?? '', `${x.system}/${x.slug}`, `/systems/${x.system}/${x.slug}`])
    .join('\n');
  // And what every public page carries anyway (the framework's scripts, the header and footer): a
  // locked code sample that happens to match them gives nothing away.
  const clientDir = join(gatedDir, '..', '..', 'client');
  const baseline = ['index.html', '404.html', 'tracks/frontend/index.html'].map((f) => join(clientDir, f)).filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
  for (const t of snapshot.topics) {
    const file = join(gatedDir, ...FREE_PREFIX.split('/').filter(Boolean), t.system, t.slug, 'index.html');
    if (!existsSync(file)) continue;
    const html = readFileSync(file, 'utf8');
    for (const s of lockedSnippets(t, free.previewSections, shown)) if (html.includes(s) && !baseline.includes(s)) leaks.push(`${file}: locked text of ${t.system}/${t.slug} ("${s}")`);
  }
  return leaks;
}
