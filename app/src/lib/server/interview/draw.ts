import type { BoardGraph } from '../../board/serialise';
import { asidePlacer, ASIDE_BOX, type Aside } from '../coaching/aside';
import { placeOp, type Layout } from '../coaching/layout';
import type { Tone } from '../coaching/schema';

// The interviewer, or the coach, drawing on the whiteboard (docs/README.md, "Whiteboard":
// "the interviewer draws"; docs/coach-mode.md, "Drawing"). A reply may carry <draw>
// elements of a few operations each, anywhere in its words; the service takes them off the reply,
// checks them against the board the model was shown, and saves the operations on the turn
// (TurnMeta.draw) for the room to apply, marked as the model's (customData.author). While the reply
// streams, each element is parsed as it closes and sent to the room at once (holdDraw), so a box
// lands as the sentence about it is read or spoken. The interviewer draws at most once a stage, and
// only ever what the candidate said: a box the candidate named, an arrow they described. The coach
// draws whenever its director says a teaching turn is drawable, with the wider vocabulary below,
// and may change or erase only its own elements. An operation the board cannot take is dropped with
// a numbered reason (`dropped`), which the next turn shows the model so it can correct itself. The
// matcher sees the model's boxes like any other, so a drawn box is never the candidate's credit
// (serialise.ts marks the author; the evidence stays partial).

export type BoxKind = 'box' | 'oval' | 'diamond';
export type { Tone };

/** A spot and a size on the board, in board pixels: a lesson's placed elements carry them (coaching/layout.ts). */
export type Point = { x: number; y: number };
export type Size = { w: number; h: number };

export type DrawOp =
  /** `dashed`: an edge that is not a visible line (a margin, a boundary): a lesson's board plan only. */
  | { op: 'box'; label: string; kind?: BoxKind; group?: string; at?: Point; size?: Size; tone?: Tone; dashed?: boolean; covers?: string; learner?: boolean }
  /** A labelled panel other elements sit in (a lesson's board plan only). A plan part the learner named is `learner`'s, by `covers`. */
  | { op: 'region'; label: string; at: Point; size: Size; tone?: Tone; dashed?: boolean; covers?: string; learner?: boolean }
  | {
      op: 'arrow';
      from: string;
      to: string;
      label?: string;
      dashed?: boolean;
      both?: boolean;
    }
  /**
   * A sticky note (an estimate, a rule, a number), beside a box when `near` names one. A line of a lesson's list
   * (`list`) is the plan's line it `covers`, if any; `learner` marks a line in the learner's words, written as
   * they gave it (the board colours it as theirs).
   */
  | { op: 'note'; text: string; near?: string; at?: Point; list?: string; covers?: string; learner?: boolean }
  /** A ring around a box, drawing the eye to it (the learner's or the coach's); never changes the box. */
  | { op: 'highlight'; target: string }
  /** The coach's own box, relabelled. */
  | { op: 'rename'; target: string; label: string }
  /** The coach's own box (and the arrows bound to it), removed. */
  | { op: 'erase'; target: string }
  /** Everything the coach drew, removed. */
  | { op: 'clear' };

/** The interviewer's cap (one drawing a stage, a few operations). */
export const DRAW_MAX_OPS = 4;
/** The coach's cap per reply. */
export const COACH_DRAW_MAX_OPS = 8;
export const DRAW_LABEL_MAX = 40;
export const DRAW_NOTE_MAX = 140;
/** Reasons kept per reply (the model reads them on its next turn). */
export const DRAW_DROPPED_MAX = 6;

/** Every <draw> element in a reply; one left open at the end (a cut-off reply) runs to the end. */
const DRAW_RE = /<draw>([\s\S]*?)(?:<\/draw>|$)/gi;
/** A drawing element the model wrote outside a <draw> element: read as one, never left in the words (they are spoken). */
const BARE_TAGS = ['place', 'note', 'box', 'arrow', 'highlight', 'rename', 'erase', 'clear'];
const BARE_RE = new RegExp(`<(?:${BARE_TAGS.join('|')})\\b[^>]*>`, 'gi');
const ELEMENT_RE = /<(box|arrow|note|highlight|rename|erase|clear|place)\b([^>]*?)\/?>/gi;
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;
const KINDS: readonly BoxKind[] = ['box', 'oval', 'diamond'];

const clean = (s: string, max = DRAW_LABEL_MAX) => s.replace(/\s+/g, ' ').trim().slice(0, max);
const truthy = (v: string | undefined) => v !== undefined && /^(true|yes|1|dashed|both)$/i.test(v.trim());
const quote = (s: string) => `"${s.replace(/"/g, '')}"`;

export type DrawOptions = {
  /** Operations kept per reply (DRAW_MAX_OPS). */
  maxOps?: number;
  /**
   * The wider vocabulary (the coach): notes, highlights, and rename, erase and clear on the author's
   * own elements. The interviewer has boxes and arrows only.
   */
  edit?: boolean;
  /**
   * A lesson's board plan (coaching/layout.ts): <place ids="..."/> draws its elements and arrows where
   * the pack puts them. One place counts as one operation towards the cap, however many ids it names.
   */
  layout?: Layout;
  /**
   * An element body read before the reply's (the board a lesson opens with, as <place> elements): its
   * operations come first in `ops`, and the reply may refer to what it drew.
   */
  prelude?: string;
  /**
   * A lesson's side notes (coaching/aside.ts): where the coach's own boxes and notes go, beyond the board
   * plan, so they never take a spot the plan needs.
   */
  aside?: Aside;
  /** The reply draws only its own sketch: a <place> is dropped (a doubt answered aside); the prelude still places. */
  noPlace?: boolean;
  /**
   * A lesson's numbered lists (coaching/schema.ts boardList): a placed line goes in the next free slot, numbered
   * as written, and only once. With `capture`, the reply writes the learner's points: each <note> goes on that
   * list in their words, the plan's line it `covers` named by id, or as an extra line while room is left for the
   * plan's lines still open (past that, an extra goes in the side notes).
   */
  lists?: { plans: readonly ListPlan[]; earlier: readonly DrawOp[]; capture?: string };
  /**
   * The plan's parts the learner is giving and has not yet (a lesson's ask without a list): a <note covers="id">
   * places that part where the plan puts it, as the learner's; a note covering none goes in the side notes.
   */
  parts?: readonly string[];
};

/** A lesson's list in board pixels: where its first line goes, the step between lines, and its lines by id with their words. */
export type ListPlan = { id: string; x: number; y: number; step: number; slots: number; chars: number; items: readonly { id: string; label: string }[] };

type ListRun = { plan: ListPlan; used: number; covered: Set<string> };

/** Each list as the board has it after `ops`: the slots used, and the plan's lines already on it. */
export function listRuns(plans: readonly ListPlan[], ops: readonly DrawOp[]): Map<string, ListRun> {
  const runs = new Map<string, ListRun>(plans.map((plan) => [plan.id, { plan, used: 0, covered: new Set<string>() }]));
  for (const o of ops) {
    if (o.op !== 'note' || !o.list) continue;
    const run = runs.get(o.list);
    if (!run) continue;
    run.used += 1;
    if (o.covers) run.covered.add(o.covers);
  }
  return runs;
}

/** Words cut to `max` characters at a word, never mid-word. */
const fit = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1).replace(/\s+\S*$/, '');
  return (cut || t.slice(0, max)).replace(/[,;:\s]+$/, '');
};

/** Ids one <place> may name. */
export const PLACE_MAX_IDS = 16;

/**
 * One reply's drawing, element by element: what the board has (by label or n-id), what this reply
 * added, what the author may change, and the cap, carried from one element to the next. The
 * streaming sink feeds it as elements close; `parseDraw` feeds it the whole reply at the end, and
 * both see the same operations.
 */
export type DrawParser = {
  /** The operations of one element's body (the text between <draw> and </draw>). */
  element: (body: string) => DrawOp[];
  /** Everything kept so far. */
  readonly ops: DrawOp[];
  /** Why operations were dropped, numbered as the model reads them. */
  readonly dropped: string[];
};

export function drawParser(graph: BoardGraph | null, opts: DrawOptions = {}): DrawParser {
  const maxOps = opts.maxOps ?? DRAW_MAX_OPS;
  // Labels as the board has them, wrapped over lines or not.
  const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const known = new Map<string, string>();
  // Labels of the author's own elements (serialise.ts marks them), which it may change or erase.
  const own = new Set<string>();
  for (const n of graph?.nodes ?? []) {
    known.set(n.id.toLowerCase(), n.label ?? n.id);
    if (n.label) known.set(key(n.label), n.label);
    if (n.author) {
      own.add(n.id.toLowerCase());
      if (n.label) own.add(key(n.label));
    }
  }
  // A lesson's regions are frames on the board: placing one that is there already draws nothing.
  const frames = new Set((graph?.frames ?? []).flatMap((f) => (f.label ? [key(f.label)] : [])));
  const ops: DrawOp[] = [];
  const dropped: string[] = [];
  let capped = false;
  // Operations kept, counted towards the cap: one per element kept, a <place> that drew anything included.
  let units = 0;
  const drop = (why: string) => {
    if (dropped.length < DRAW_DROPPED_MAX) dropped.push(why);
  };
  const unknown = (what: string, name: string) => drop(`${what} ${quote(name)}: no box with that label is on the board`);
  const aside = opts.aside ? asidePlacer(opts.aside) : null;
  const lists = opts.lists ? listRuns(opts.lists.plans, opts.lists.earlier) : null;
  const listOf = (id: string) => (lists ? [...lists.values()].find((l) => l.plan.items.some((i) => i.id === id)) : undefined);
  /** The next line of a list, numbered; null when it is full. */
  const line = (run: ListRun, text: string, extra: Partial<Extract<DrawOp, { op: 'note' }>>): DrawOp | null => {
    if (run.used >= run.plan.slots) return null;
    const at = { x: run.plan.x, y: run.plan.y + run.used * run.plan.step };
    run.used += 1;
    if (extra.covers) run.covered.add(extra.covers);
    return { op: 'note', text: `${run.used}. ${text}`, at, list: run.plan.id, ...extra };
  };
  const capture = opts.lists?.capture ? (lists?.get(opts.lists.capture) ?? null) : null;
  const open = new Set(opts.parts ?? []);
  let prelude = false;
  const element = (body: string): DrawOp[] => {
    const out: DrawOp[] = [];
    for (const el of body.matchAll(ELEMENT_RE)) {
      const tag = el[1].toLowerCase();
      if (units >= maxOps) {
        if (!capped) drop(`past the cap of ${maxOps} operations a reply: the rest were dropped`);
        capped = true;
        break;
      }
      const attrs: Record<string, string> = {};
      for (const a of el[2].matchAll(ATTR_RE)) attrs[a[1].toLowerCase()] = a[2];
      let op: DrawOp | null = null;
      if (tag === 'place') {
        if (opts.noPlace && !prelude) {
          drop('<place>: this reply answers aside; the lesson’s parts are placed when they are taught');
          continue;
        }
        if (!opts.edit || !opts.layout) {
          drop('<place>: there is no board plan in this session');
          continue;
        }
        const ids = (attrs.ids ?? attrs.id ?? '').split(/[\s,]+/).filter(Boolean);
        if (!ids.length) drop('place without ids');
        if (ids.length > PLACE_MAX_IDS) drop(`place: ${ids.length} ids, past the ${PLACE_MAX_IDS} one place takes; the rest were dropped`);
        let placed = false;
        for (const id of ids.slice(0, PLACE_MAX_IDS)) {
          const got = placeOp(opts.layout, id.toLowerCase());
          if ('error' in got) {
            drop(got.error);
            continue;
          }
          let p = got.op;
          // A list's line goes in the list's next slot, once.
          const run = p.op === 'note' ? listOf(id.toLowerCase()) : undefined;
          if (run) {
            const key = id.toLowerCase();
            if (run.covered.has(key)) continue;
            const next = line(run, run.plan.items.find((i) => i.id === key)!.label, { covers: key });
            if (!next) {
              drop(`place "${id}": the list is full`);
              continue;
            }
            p = next;
          }
          // Already on the board: placing it again is a no-op, not a mistake (a beat may repeat a kept element).
          if ((p.op === 'box' || p.op === 'region') && (known.has(key(p.label)) || frames.has(key(p.label)))) continue;
          if (p.op === 'arrow') {
            const from = known.get(p.from.toLowerCase());
            const to = known.get(p.to.toLowerCase());
            if (!from || !to) {
              drop(`place "${id}": draw ${quote(from ? p.to : p.from)} first`);
              continue;
            }
            p.from = from;
            p.to = to;
          }
          if (p.op === 'box' || p.op === 'region') {
            known.set(p.label.toLowerCase(), p.label);
            own.add(p.label.toLowerCase());
          }
          ops.push(p);
          out.push(p);
          placed = true;
        }
        if (placed) units += 1;
        continue;
      }
      if (tag === 'box') {
        const label = clean(attrs.label ?? '');
        if (!label) drop('box without a label');
        else if (known.has(label.toLowerCase())) drop(`box ${quote(label)}: already on the board`);
        else {
          known.set(label.toLowerCase(), label);
          own.add(label.toLowerCase());
          const kind = attrs.kind?.toLowerCase();
          const group = opts.edit ? clean(attrs.group ?? '') : '';
          op = {
            op: 'box',
            label,
            ...(opts.edit && kind && kind !== 'box' && KINDS.includes(kind as BoxKind) ? { kind: kind as BoxKind } : {}),
            ...(group && !aside ? { group } : {}),
            ...(aside ? { at: aside.box(), size: ASIDE_BOX } : {}),
          };
        }
      } else if (tag === 'arrow') {
        const fromName = clean(attrs.from ?? '');
        const toName = clean(attrs.to ?? '');
        const from = known.get(fromName.toLowerCase());
        const to = known.get(toName.toLowerCase());
        if (!from) unknown('arrow from', fromName);
        else if (!to) unknown('arrow to', toName);
        else if (from === to) drop(`arrow from ${quote(from)} to itself`);
        else {
          const label = clean(attrs.label ?? '');
          op = {
            op: 'arrow',
            from,
            to,
            ...(label ? { label } : {}),
            ...(opts.edit && (truthy(attrs.dashed) || attrs.style?.toLowerCase() === 'dashed') ? { dashed: true } : {}),
            ...(opts.edit && (truthy(attrs.both) || attrs.direction?.toLowerCase() === 'both') ? { both: true } : {}),
          };
        }
      } else if (!opts.edit) {
        drop(`<${tag}>: only boxes and arrows here`);
      } else if (tag === 'note') {
        const note = clean(attrs.text ?? '', DRAW_NOTE_MAX);
        const nearName = clean(attrs.near ?? '');
        const near = nearName ? known.get(nearName.toLowerCase()) : undefined;
        // The learner named parts of the plan: each is placed where the plan puts it, as theirs.
        const named = opts.parts && opts.layout && !prelude ? (attrs.covers ?? '').split(/[\s,]+/).map((c) => c.toLowerCase()).filter((c) => open.has(c)) : [];
        if (note && named.length) {
          for (const id of named) {
            const got = placeOp(opts.layout!, id);
            if ('error' in got || got.op.op === 'arrow' || got.op.op === 'highlight') continue;
            const p = { ...got.op, covers: id, learner: true } as DrawOp;
            open.delete(id);
            if (p.op === 'box' || p.op === 'region') {
              known.set(p.label.toLowerCase(), p.label);
              own.add(p.label.toLowerCase());
            }
            ops.push(p);
            out.push(p);
          }
          units += 1;
          continue;
        }
        const run = capture && !prelude ? capture : null;
        // The learner's point, on the list being given: the plan's line it covers, or an extra while there is room.
        const covers = run ? (attrs.covers ?? '').trim().toLowerCase() : '';
        const planned = run && run.plan.items.some((i) => i.id === covers) && !run.covered.has(covers);
        const room = run ? run.plan.slots - run.used - (run.plan.items.length - run.covered.size) : 0;
        const given = run && note && (planned || room > 0) ? line(run, fit(note.replace(/^\d+[.)]\s*/, ''), run.plan.chars - 4), { learner: true, ...(planned ? { covers } : {}) }) : null;
        if (!note) drop('note without text');
        else if (given) op = given;
        else {
          if (nearName && !near && !aside) drop(`note near ${quote(nearName)}: no such box, so it was placed on its own`);
          // A point of the learner's beyond the plan, while they give a part: theirs, in the side notes.
          const theirs = opts.parts && !prelude ? { learner: true } : {};
          op = aside ? { op: 'note', text: note, at: aside.note(), ...theirs } : { op: 'note', text: note, ...(near ? { near } : {}), ...theirs };
        }
      } else if (tag === 'highlight') {
        const name = clean(attrs.target ?? attrs.label ?? '');
        const target = known.get(name.toLowerCase());
        if (target) op = { op: 'highlight', target };
        else unknown('highlight', name);
      } else if (tag === 'rename') {
        const name = clean(attrs.target ?? attrs.from ?? '');
        const key = name.toLowerCase();
        const target = known.get(key);
        const label = clean(attrs.label ?? attrs.to ?? '');
        if (!target) unknown('rename', name);
        else if (!own.has(key)) drop(`rename ${quote(target)}: not yours to change (the learner drew it)`);
        else if (!label) drop(`rename ${quote(target)}: no new label`);
        else if (known.has(label.toLowerCase())) drop(`rename ${quote(target)} to ${quote(label)}: a box with that label is already there`);
        else {
          known.delete(key);
          own.delete(key);
          known.set(label.toLowerCase(), label);
          own.add(label.toLowerCase());
          op = { op: 'rename', target, label };
        }
      } else if (tag === 'erase') {
        const name = clean(attrs.target ?? attrs.label ?? '');
        const key = name.toLowerCase();
        const target = known.get(key);
        if (!target) unknown('erase', name);
        else if (!own.has(key)) drop(`erase ${quote(target)}: not yours to erase (the learner drew it)`);
        else {
          known.delete(key);
          own.delete(key);
          op = { op: 'erase', target };
        }
      } else if (tag === 'clear') {
        for (const key of own) known.delete(key);
        own.clear();
        op = { op: 'clear' };
      }
      if (op) {
        ops.push(op);
        out.push(op);
        units += 1;
      }
    }
    return out;
  };
  if (opts.prelude) {
    prelude = true;
    element(opts.prelude);
    prelude = false;
  }
  return { element, ops, dropped };
}

/**
 * Splits a reply into its words and its <draw> operations (none when it has no element, or the
 * drawing is not allowed on this turn). The elements come off the text wherever they stand; an
 * operation that names a box the board does not have (by label or n-id, or a box this reply adds)
 * is dropped with a reason, as is an edit of a box the author did not draw; at most `maxOps` are
 * kept. `dropped` is empty when the drawing was not allowed: the model was told not to draw.
 */
export function parseDraw(reply: string, graph: BoardGraph | null, allowed: boolean, opts: DrawOptions = {}): { text: string; ops: DrawOp[]; dropped: string[] } {
  const bodies: string[] = [];
  const text =
    reply
      .replace(DRAW_RE, (_, body: string) => {
        bodies.push(body);
        return ' ';
      })
      .replace(BARE_RE, (el: string) => {
        bodies.push(el);
        return ' ';
      })
      .replace(/(?:[ \t]*\n[ \t]*)+/g, '\n')
      .replace(/ {2,}/g, ' ')
      .replace(/ +([.,;:!?])/g, '$1')
      .trim() || 'Go on.';
  if (!bodies.length && !opts.prelude) return { text: reply, ops: [], dropped: [] };
  const words = bodies.length ? text : reply;
  if (!allowed) return { text: words, ops: [], dropped: [] };
  const parser = drawParser(graph, opts);
  for (const body of bodies) parser.element(body);
  return { text: words, ops: parser.ops, dropped: parser.dropped };
}

/**
 * A text sink that keeps <draw> elements out of what it forwards: from a `<` that may open one,
 * text is held until it is known not to be a draw, so the room never shows (and the voice never
 * speaks) the operations. Each element's body goes to `onElement` the moment it closes (the room
 * draws it then); `flush` releases a held tail that was not an element, and hands over an element
 * still open when the reply ended (a cut-off reply), as `parseDraw` reads it.
 */
/**
 * Where a drawing stands in the reply's words (coach-mode.md, phase 5): the number of words spoken before
 * its element. The voice service holds the drawing until that many words have played, so the box lands as
 * its sentence is heard; the typed room draws at once.
 */
export type DrawAnchor = { words: number; /** The board a lesson opens with: drawn at once, before a word. */ prelude?: boolean };

export const countWords = (text: string): number => (text.match(/\S+/g) ?? []).length;

export function holdDraw(
  forward: (delta: string) => void,
  onElement?: (body: string, anchor: DrawAnchor) => void,
): {
  onText: (delta: string) => void;
  flush: () => void;
} {
  let held = '';
  let body: string | null = null;
  let spoken = '';
  const OPEN = '<draw>';
  const CLOSE = '</draw>';
  // A bare <place .../>, <note .../> and the like (outside <draw>) is an element too, closed by its own `>`.
  const BARE = BARE_TAGS.map((t) => `<${t}`);
  let close = CLOSE;
  let keep = '';
  const onText = (delta: string) => {
    spoken += delta;
    forward(delta);
  };
  const element = (b: string) => onElement?.(b, { words: countWords(spoken) });
  return {
    onText: (delta) => {
      let text = held + delta;
      held = '';
      for (;;) {
        if (body !== null) {
          const all = body + text;
          const end = all.toLowerCase().indexOf(close);
          if (end < 0) {
            body = all;
            return;
          }
          element(keep + all.slice(0, end + (close === '>' ? 1 : 0)));
          body = null;
          text = all.slice(end + close.length);
          continue;
        }
        const lt = text.indexOf('<');
        if (lt < 0) {
          if (text) onText(text);
          return;
        }
        const tail = text.slice(lt);
        if (tail.toLowerCase().startsWith(OPEN)) {
          if (lt) onText(text.slice(0, lt));
          body = '';
          close = CLOSE;
          keep = '';
          text = tail.slice(OPEN.length);
          continue;
        }
        const bare = BARE.find((b) => tail.length > b.length && tail.toLowerCase().startsWith(b) && /[\s/>]/.test(tail[b.length]));
        if (bare) {
          if (lt) onText(text.slice(0, lt));
          body = '';
          close = '>';
          keep = tail.slice(0, bare.length);
          text = tail.slice(bare.length);
          continue;
        }
        // Could still become a bare element: hold it.
        if (BARE.some((b) => tail.length <= b.length && b.startsWith(tail.toLowerCase()))) {
          if (lt) onText(text.slice(0, lt));
          held = tail;
          return;
        }
        if (tail.length < OPEN.length && OPEN.startsWith(tail.toLowerCase())) {
          // Could still become <draw>: hold it.
          if (lt) onText(text.slice(0, lt));
          held = tail;
          return;
        }
        // Some other `<`: forward it and look further on.
        onText(text.slice(0, lt + 1));
        text = text.slice(lt + 1);
      }
    },
    flush: () => {
      if (held) onText(held);
      held = '';
      if (body !== null) {
        if (body.trim()) element(keep + body);
        body = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// The tool path (docs/coach-mode.md, phase 4): the same operations as a `draw` tool call
// instead of elements in the words. The service runs the call inside the turn and answers with what
// landed and what was dropped, so the model can put a dropped operation right in a second call; the
// price is a second model call per drawing (the cached prefix makes it cheap). The validation is the
// one above: a tool input is rendered as an element body and read by the same parser.

/** The `draw` tool, as the request declares it (the coach lane, when INTERVIEW_COACH_DRAW_TOOLS is on). */
export const DRAW_TOOL = {
  name: 'draw',
  description:
    'Draw on the shared whiteboard: boxes, arrows between boxes, notes, highlights, and changes to your own elements. ' +
    'Name boxes by their labels as the board has them. The result says which operations landed and why any were dropped; fix a dropped one in a second call only if it matters. ' +
    'Call it only on a move that says draw="yes", right after the sentence that introduces what you draw, and keep speaking around it.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ops'],
    properties: {
      ops: {
        type: 'array',
        maxItems: COACH_DRAW_MAX_OPS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['op'],
          properties: {
            op: { type: 'string', enum: ['box', 'arrow', 'note', 'highlight', 'rename', 'erase', 'clear', 'place'] },
            ids: { type: 'array', items: { type: 'string' }, maxItems: PLACE_MAX_IDS, description: 'place: ids from the lesson’s board plan, drawn where the plan puts them' },
            label: { type: 'string', description: 'box: its label; rename: the new label; arrow: the words on it' },
            kind: { type: 'string', enum: ['box', 'oval', 'diamond'], description: 'box: oval for a store, diamond for a decision' },
            group: { type: 'string', description: 'box: the group it sits with (the article’s)' },
            from: { type: 'string', description: 'arrow: the label of the box it leaves' },
            to: { type: 'string', description: 'arrow: the label of the box it reaches' },
            dashed: { type: 'boolean' },
            both: { type: 'boolean' },
            text: { type: 'string', description: 'note: its words (a number, a rule)' },
            near: { type: 'string', description: 'note: the label of the box it sits by' },
            covers: { type: 'string', description: "note, while the learner gives a part: the id of the plan's line or part their point matches (comma-separated for several)" },
            target: { type: 'string', description: 'highlight, rename, erase: the label of the box' },
          },
        },
      },
    },
  },
} as const;

const attr = (k: string, v: unknown) => (v === undefined || v === null || v === '' ? '' : ` ${k}="${String(v).replace(/"/g, '″').replace(/[<>]/g, '')}"`);

/** A tool call's input as an element body for the parser (unknown operations and fields are left out). */
export function drawToolBody(input: unknown): string {
  const ops = input && typeof input === 'object' && Array.isArray((input as { ops?: unknown }).ops) ? ((input as { ops: unknown[] }).ops as Record<string, unknown>[]) : [];
  return ops
    .filter((o) => o && typeof o === 'object' && typeof o.op === 'string')
    .map((o) => {
      const tag = o.op as string;
      if (tag === 'clear') return '<clear/>';
      if (tag === 'place') return Array.isArray(o.ids) ? `<place${attr('ids', o.ids.filter((x) => typeof x === 'string').join(','))}/>` : '';
      if (!['box', 'arrow', 'note', 'highlight', 'rename', 'erase'].includes(tag)) return '';
      return `<${tag}${attr('label', o.label)}${attr('kind', o.kind)}${attr('group', o.group)}${attr('from', o.from)}${attr('to', o.to)}${attr('dashed', o.dashed === true ? 'true' : undefined)}${attr('both', o.both === true ? 'true' : undefined)}${attr('text', o.text)}${attr('near', o.near)}${attr('covers', o.covers)}${attr('target', o.target)}/>`;
    })
    .join('');
}

/** What the model hears back from a `draw` call: what landed, and why the rest did not. */
export function drawToolResult(ops: readonly DrawOp[], dropped: readonly string[], allowed: boolean): string {
  if (!allowed) return 'Not drawn: this move does not draw (the coach element did not say draw="yes"). Go on in words.';
  const landed = ops.length ? `Drawn: ${ops.map((o) => (o.op === 'box' || o.op === 'region' ? `${o.op} ${o.label}` : o.op === 'arrow' ? `arrow ${o.from} -> ${o.to}` : o.op === 'note' ? 'note' : o.op === 'clear' ? 'clear' : `${o.op} ${o.target}`)).join('; ')}.` : 'Nothing drawn.';
  return dropped.length ? `${landed} Not drawn: ${dropped.map((d, i) => `${i + 1}. ${d}`).join(' ')}` : landed;
}

/** Whether `a` already draws the plan's operation `b`. */
const same = (a: DrawOp, b: DrawOp) =>
  a.op === b.op &&
  (a.op === 'arrow' && b.op === 'arrow'
    ? a.from.toLowerCase() === b.from.toLowerCase() && a.to.toLowerCase() === b.to.toLowerCase()
    : a.op === 'note' && b.op === 'note'
      ? b.covers
        ? a.covers === b.covers
        : a.text === b.text
      : 'label' in a && 'label' in b && (a.label ?? '').toLowerCase() === (b.label ?? '').toLowerCase());

/** The plan's ids among `ids` that `earlier` (the lesson's drawing so far) already put on the board. */
export function onBoard(layout: Layout, ids: readonly string[], earlier: readonly DrawOp[]): Set<string> {
  return new Set(
    ids.filter((id) => {
      const got = placeOp(layout, id);
      return !('error' in got) && earlier.some((o) => same(o, got.op));
    }),
  );
}

/**
 * The operations that put a move's planned ids on the board that `ops` (the reply's drawing) did not: an id
 * already drawn by the reply, or a box already on the board, is left alone; an arrow whose ends are not there is
 * dropped as the parser drops it.
 */
export function fillPlanned(
  planned: readonly string[],
  ops: readonly DrawOp[],
  graph: BoardGraph | null,
  drawOpts: DrawOptions,
  earlier: readonly DrawOp[] = [],
): { ops: DrawOp[]; ids: string[] } {
  if (!drawOpts.layout) return { ops: [], ids: [] };
  const missing = planned.filter((id) => {
    const got = placeOp(drawOpts.layout!, id);
    return !('error' in got) && ![...earlier, ...ops].some((o) => same(o, got.op));
  });
  if (!missing.length) return { ops: [], ids: [] };
  // The board as the reply leaves it: what it had, and the boxes this lesson's replies drew (the room may
  // not have saved the board since an earlier one).
  const drawnBoxes = [...earlier, ...ops].flatMap((o, k) =>
    o.op === 'box' || o.op === 'region' ? [{ id: `r${k}`, eid: `r${k}`, label: o.label, shape: 'box' as const, frame: null, x: 0, y: 0, w: 0, h: 0, author: 'coach' as const }] : [],
  );
  const board: BoardGraph = graph
    ? { ...graph, nodes: [...graph.nodes, ...drawnBoxes] }
    : { nodes: drawnBoxes, frames: [], edges: [], freehand: { count: 0, clusters: [] }, layout: { direction: 'left-to-right', rows: [] } };
  // A list's lines go after what the reply wrote on it.
  const lists = drawOpts.lists && { plans: drawOpts.lists.plans, earlier: [...earlier, ...ops] };
  const parser = drawParser(board, { ...drawOpts, prelude: undefined, noPlace: false, lists, maxOps: Math.ceil(missing.length / PLACE_MAX_IDS) });
  for (let i = 0; i < missing.length; i += PLACE_MAX_IDS) parser.element(`<place ids="${missing.slice(i, i + PLACE_MAX_IDS).join(',')}"/>`);
  return { ops: parser.ops, ids: parser.ops.length ? missing : [] };
}

const MINOR = new Set(['the', 'and', 'with', 'from', 'into', 'over', 'what', 'that', 'this', 'one', 'two', 'its', 'for']);

/**
 * The reply as the model reads it back on later turns: the words with its own drawing elements in place, and the
 * plan's `ids` the service drew for it each as a <place> element at the end of the sentence that names it (its
 * label's first real word), or at the end. The model then sees every move of its own drawing as it speaks.
 */
export function readBack(reply: string, ids: readonly string[], layout: Layout | undefined): string {
  if (!ids.length || !layout) return reply;
  const at = new Map<number, string[]>();
  // Where the words are: outside the reply's own elements.
  const masked = reply.replace(DRAW_RE, (m) => ' '.repeat(m.length)).replace(BARE_RE, (m) => ' '.repeat(m.length));
  const lower = masked.toLowerCase();
  for (const id of ids) {
    const got = placeOp(layout, id);
    if ('error' in got) continue;
    const op = got.op;
    const name = op.op === 'arrow' ? op.to : op.op === 'note' ? op.text : 'label' in op ? (op.label ?? '') : '';
    const word = name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .find((w) => w.length >= 3 && !MINOR.has(w));
    let pos = reply.length;
    const hit = word ? lower.search(new RegExp(`\\b${word}`)) : -1;
    if (hit >= 0) {
      const end = masked.slice(hit).search(/[.!?](\s|$)/);
      pos = end >= 0 ? hit + end + 1 : reply.length;
    }
    at.set(pos, [...(at.get(pos) ?? []), id]);
  }
  let out = '';
  let from = 0;
  for (const pos of [...at.keys()].sort((a, b) => a - b)) {
    out += `${reply.slice(from, pos)} <draw><place ids="${at.get(pos)!.join(',')}"/></draw>`;
    from = pos;
  }
  return out + reply.slice(from);
}
