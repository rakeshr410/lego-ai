import { z } from 'zod';

// The coaching material's file formats (docs/coaching.md): a pack per article section, and
// playlists of lessons built from packs. Packs are drafted by Claude (scripts/coaching.ts draft) and
// reviewed by people in pull requests; each is stamped with the hash of the section it was written
// from, so an edit to the article marks it stale and the lesson falls back to the article itself.
//
// A pack carries what the coach needs to teach its section the same way every time: the teaching
// beats in order (what to get across, how, the question that checks it, the misconceptions to
// correct), the board the beats build up (every region, box, note and arrow, placed on a grid), and
// the context that ties it to the packs around it (what it assumes, what it hands on, its terms, and
// which earlier elements stay on the board).

const slugRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = () => z.string().regex(slugRe, 'Expected a lowercase-kebab-case slug');
const handle = () => z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, 'Expected a GitHub handle (no @)');
const date = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date, YYYY-MM-DD');
const line = (max = 300) => z.string().regex(/\S/, 'Empty text').max(max);

/**
 * A pack's id: the section it teaches, as `<system>/<topic>/<sectionKey>` (its path under coaching/packs), or
 * `backend/<system>/<topic>/<sectionKey>` for a backend article's (app/articles/backend), which may share its
 * system and topic with a frontend one.
 */
export const PACK_ID = /^(?:backend\/)?[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9][a-z0-9-]{0,120}$/;

/**
 * A pack id's parts. `system` keeps the `backend/` prefix (content-snapshot.ts `topicAt` reads it), so
 * `system`/`topic` names one article; `section` is `<topic>/<sectionKey>`, the plan's key for it.
 */
export function packRef(id: string): { system: string; topic: string; sectionKey: string; section: string } {
  const parts = id.split('/');
  const backend = parts.length === 4;
  const [system, topic, sectionKey] = backend ? parts.slice(1) : parts;
  return { system: backend ? `${parts[0]}/${system}` : system, topic, sectionKey, section: `${topic}/${sectionKey}` };
}

/** Board grid cell, in board pixels: positions and sizes in a pack are in cells. */
export const CELL = 20;
/** A box's size when the pack gives none, in cells (160 × 60 px). */
export const BOX_CELLS = [8, 3] as const;
/** The board's extent a pack may use, in cells: wide enough for four panels side by side. */
export const GRID = { cols: 120, rows: 110 } as const;

export const ELEMENT_KINDS = ['region', 'box', 'oval', 'diamond', 'note'] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];
export const TONES = ['neutral', 'blue', 'green', 'red', 'amber', 'grey'] as const;
export type Tone = (typeof TONES)[number];

const cell = (max: number) => z.number().int().min(0).max(max);
const point = z.tuple([cell(GRID.cols), cell(GRID.rows)]);
const size = z.tuple([z.number().int().min(1).max(GRID.cols), z.number().int().min(1).max(GRID.rows)]);
const elementId = () => z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Expected a kebab-case id').max(40);

export const boardElement = z.strictObject({
  id: elementId(),
  /**
   * region: a labelled panel other elements sit in (a tree, a context, a layer); box, oval (a store)
   * and diamond (a decision): a labelled shape; note: free text, a rule or a number.
   */
  kind: z.enum(ELEMENT_KINDS),
  /** The words on it; labels are how the coach and the learner name elements, so unique on a lesson's board. */
  label: line(60),
  /** Top-left corner, in cells. */
  at: point,
  /** Width and height in cells; a box defaults to BOX_CELLS, a region must say. */
  size: size.optional(),
  /** The region it sits in (drawn before it); for reading, the position is still absolute. */
  in: elementId().optional(),
  /** Colour by meaning: the same tone means the same kind of thing across the playlist. */
  tone: z.enum(TONES).optional(),
  /** Drawn with a dashed edge: a boundary that is not a visible line (a margin, an area, a viewport over a list). */
  dashed: z.boolean().optional(),
});
export type BoardElement = z.infer<typeof boardElement>;

export const boardArrow = z.strictObject({
  id: elementId(),
  from: elementId(),
  to: elementId(),
  label: line(40).optional(),
  dashed: z.boolean().optional(),
  both: z.boolean().optional(),
});
export type BoardArrow = z.infer<typeof boardArrow>;

/**
 * A numbered list on the board (requirements, targets): lines one under another, at `at`, `step` rows apart,
 * `slots` of them, each at most `width` cells wide. Its items are notes placed in the order they are written,
 * numbered as they go ("1. ..."), so a learner's own points come first and the rest follow; the items' `at`
 * are the slots in the pack's order (what a lesson that only keeps the list draws).
 */
export const boardList = z.strictObject({
  id: elementId(),
  /** The region the lines sit in. */
  in: elementId(),
  at: point,
  step: z.number().int().min(1).max(4),
  slots: z.number().int().min(1).max(16),
  width: z.number().int().min(8).max(70),
  /** The pack's lines, notes of this pack, in its order. */
  items: z.array(elementId()).min(1).max(16),
});
export type BoardList = z.infer<typeof boardList>;

/**
 * A part of the pack the learner gives first (docs/coach-mode.md, "The learner gives a part first"): the coach
 * asks `question`, puts down each point the learner makes, offers `hints` when they pause, then adds what of
 * `beats` they did not name. Each point goes either on `list` in their words, or, with `ids`, as the plan's
 * element it matches (a box, a region, a line of JSON), where the plan puts it and in the learner's colour.
 * `frame` is what is drawn before asking (by default the list's other ids, or the beats' regions not in `ids`).
 */
export const ask = z.strictObject({
  list: elementId().optional(),
  ids: z.array(elementId()).min(1).max(16).optional(),
  frame: z.array(elementId()).max(8).optional(),
  /** The beats (1-based) whose lines the learner is asked for, in order. */
  beats: z.array(z.number().int().min(1)).min(1).max(8),
  question: line(300),
  hints: z.array(line(200)).max(3),
});
export type Ask = z.infer<typeof ask>;

export const ITEM_KINDS = ['requirement', 'metric', 'component', 'flow', 'decision', 'mechanism', 'failure', 'rule'] as const;

export const beat = z.strictObject({
  /** What the learner should come away with, in one sentence (the item the coach teaches and checks). */
  point: line(300),
  kind: z.enum(ITEM_KINDS),
  /** Core beats are checked and decide the lesson's coverage; supporting ones are taught when time allows. */
  weight: z.enum(['core', 'supporting']),
  /** How to teach it: the explanation, the example, the order of ideas. The coach says it in its own words. */
  teach: z.array(line(400)).min(1).max(5),
  /** Element and arrow ids this beat puts on the board, in drawing order. */
  draw: z.array(elementId()).max(16).optional(),
  /** The question that checks it; a beat without one is taught, not checked. */
  check: line(300).optional(),
  /** What a right answer contains. */
  answer: line(400).optional(),
  /** Wrong ideas the learner may voice, each with its correction ("wrong idea -> correction"). */
  misconceptions: z.array(line(300)).max(6).optional(),
});
export type Beat = z.infer<typeof beat>;

export const pack = z.strictObject({
  /** `<system>/<topic>/<sectionKey>`: the file's path under coaching/packs, without .yaml. */
  id: z.string().regex(PACK_ID),
  title: line(80),
  source: z.strictObject({
    /** The section's hash when the pack was written (coachingSectionHash); a different hash now means the article changed. */
    hash: z.string().regex(/^[a-f0-9]{12}$/),
  }),
  review: z.strictObject({
    status: z.enum(['draft', 'reviewed']),
    provenance: z.enum(['ai-drafted', 'human']),
    author: handle(),
    reviewer: handle().optional(),
    reviewedAt: date().optional(),
  }),
  context: z.strictObject({
    /** The pack this one builds on (the one before it in a playlist), whose board it continues. */
    after: z.string().regex(PACK_ID).nullable(),
    /** Ideas taught earlier that this pack leans on: the coach may refer to them, not reteach them. */
    assumes: z.array(line(200)).max(8),
    /** Ideas this pack establishes that later packs assume. */
    carries: z.array(line(200)).min(1).max(8),
    /** Words used with one meaning throughout. */
    terms: z.array(z.strictObject({ term: line(60), means: line(200) })).max(10),
  }),
  board: z.strictObject({
    /** Elements of earlier packs (by id) that stay on the board; on a fresh lesson they are drawn first. */
    // A design that grows across lessons keeps most of what came before (docs/coaching.md).
    keep: z.array(elementId()).max(120),
    elements: z.array(boardElement).max(60),
    arrows: z.array(boardArrow).max(40),
    lists: z.array(boardList).max(4).optional(),
  }),
  beats: z.array(beat).min(1).max(8),
  /** Parts the learner is asked to give first; the rest of the pack is taught. */
  asks: z.array(ask).max(4).optional(),
  /** What the learner draws once the beats are taught, and the beats (by 1-based index) a drawing should show. */
  task: z.strictObject({ prompt: line(400), expects: z.array(z.number().int().min(1)).min(1) }).optional(),
});
export type Pack = z.infer<typeof pack>;

export const lessonPart = z.strictObject({
  title: line(80),
  minutes: z.number().int().min(3).max(20),
  /** The packs the part teaches, in order: one or two sections. */
  packs: z.array(z.string().regex(PACK_ID)).min(1).max(2),
});

export const lesson = z.strictObject({
  slug: slug(),
  title: line(80),
  /** What the lesson teaches, for the playlist page. */
  summary: line(300),
  parts: z.array(lessonPart).min(1).max(4),
});
export type Lesson = z.infer<typeof lesson>;

export const playlist = z.strictObject({
  /** The playlist's address, /coach/<slug>; never a system's slug. */
  slug: slug(),
  title: line(80),
  summary: line(400),
  /** Where the lessons come from: the sources a reviewer can check the outline against (no text is taken from them). */
  outline: line(400),
  /**
   * The playlist page's words (components/sd/PlaylistView.tsx) where the title doesn't give them: what is designed,
   * after "Design" ("a job scheduler"), and where the lessons end ("the polling race"). Without them the subject
   * comes from the title (coaching/landing.ts).
   */
  landing: z.strictObject({ subject: line(60).optional(), reach: line(40).optional() }).optional(),
  lessons: z.array(lesson).min(1).max(40),
});
export type Playlist = z.infer<typeof playlist>;
