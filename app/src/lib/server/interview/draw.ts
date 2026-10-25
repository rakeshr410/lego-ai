import type { BoardGraph } from '../../board/serialise';

// The interviewer, or the coach, drawing on the whiteboard (docs/interview/README.md, "Whiteboard":
// "the interviewer draws"; docs/interview/coach-mode.md, "Drawing"). A reply may carry <draw>
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

export type DrawOp =
  | { op: 'box'; label: string; kind?: BoxKind; group?: string }
  | {
      op: 'arrow';
      from: string;
      to: string;
      label?: string;
      dashed?: boolean;
      both?: boolean;
    }
  /** A sticky note (an estimate, a rule, a number), beside a box when `near` names one. */
  | { op: 'note'; text: string; near?: string }
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
const ELEMENT_RE = /<(box|arrow|note|highlight|rename|erase|clear)\b([^>]*?)\/?>/gi;
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
};

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
  const known = new Map<string, string>();
  // Labels of the author's own elements (serialise.ts marks them), which it may change or erase.
  const own = new Set<string>();
  for (const n of graph?.nodes ?? []) {
    known.set(n.id.toLowerCase(), n.label ?? n.id);
    if (n.label) known.set(n.label.toLowerCase(), n.label);
    if (n.author) {
      own.add(n.id.toLowerCase());
      if (n.label) own.add(n.label.toLowerCase());
    }
  }
  const ops: DrawOp[] = [];
  const dropped: string[] = [];
  let capped = false;
  const drop = (why: string) => {
    if (dropped.length < DRAW_DROPPED_MAX) dropped.push(why);
  };
  const unknown = (what: string, name: string) => drop(`${what} ${quote(name)}: no box with that label is on the board`);
  const element = (body: string): DrawOp[] => {
    const out: DrawOp[] = [];
    for (const el of body.matchAll(ELEMENT_RE)) {
      const tag = el[1].toLowerCase();
      if (ops.length >= maxOps) {
        if (!capped) drop(`past the cap of ${maxOps} operations a reply: the rest were dropped`);
        capped = true;
        break;
      }
      const attrs: Record<string, string> = {};
      for (const a of el[2].matchAll(ATTR_RE)) attrs[a[1].toLowerCase()] = a[2];
      let op: DrawOp | null = null;
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
            ...(group ? { group } : {}),
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
        if (!note) drop('note without text');
        else {
          if (nearName && !near) drop(`note near ${quote(nearName)}: no such box, so it was placed on its own`);
          op = { op: 'note', text: note, ...(near ? { near } : {}) };
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
      }
    }
    return out;
  };
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
      .replace(/(?:[ \t]*\n[ \t]*)+/g, '\n')
      .replace(/ {2,}/g, ' ')
      .replace(/ +([.,;:!?])/g, '$1')
      .trim() || 'Go on.';
  if (!bodies.length) return { text: reply, ops: [], dropped: [] };
  if (!allowed) return { text, ops: [], dropped: [] };
  const parser = drawParser(graph, opts);
  for (const body of bodies) parser.element(body);
  return { text, ops: parser.ops, dropped: parser.dropped };
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
export type DrawAnchor = { words: number };

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
          const end = all.toLowerCase().indexOf(CLOSE);
          if (end < 0) {
            body = all;
            return;
          }
          element(all.slice(0, end));
          body = null;
          text = all.slice(end + CLOSE.length);
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
          text = tail.slice(OPEN.length);
          continue;
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
        if (body.trim()) element(body);
        body = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// The tool path (docs/interview/coach-mode.md, phase 4): the same operations as a `draw` tool call
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
            op: { type: 'string', enum: ['box', 'arrow', 'note', 'highlight', 'rename', 'erase', 'clear'] },
            label: { type: 'string', description: 'box: its label; rename: the new label; arrow: the words on it' },
            kind: { type: 'string', enum: ['box', 'oval', 'diamond'], description: 'box: oval for a store, diamond for a decision' },
            group: { type: 'string', description: 'box: the group it sits with (the article’s)' },
            from: { type: 'string', description: 'arrow: the label of the box it leaves' },
            to: { type: 'string', description: 'arrow: the label of the box it reaches' },
            dashed: { type: 'boolean' },
            both: { type: 'boolean' },
            text: { type: 'string', description: 'note: its words (a number, a rule)' },
            near: { type: 'string', description: 'note: the label of the box it sits by' },
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
      if (!['box', 'arrow', 'note', 'highlight', 'rename', 'erase'].includes(tag)) return '';
      return `<${tag}${attr('label', o.label)}${attr('kind', o.kind)}${attr('group', o.group)}${attr('from', o.from)}${attr('to', o.to)}${attr('dashed', o.dashed === true ? 'true' : undefined)}${attr('both', o.both === true ? 'true' : undefined)}${attr('text', o.text)}${attr('near', o.near)}${attr('target', o.target)}/>`;
    })
    .join('');
}

/** What the model hears back from a `draw` call: what landed, and why the rest did not. */
export function drawToolResult(ops: readonly DrawOp[], dropped: readonly string[], allowed: boolean): string {
  if (!allowed) return 'Not drawn: this move does not draw (the coach element did not say draw="yes"). Go on in words.';
  const landed = ops.length ? `Drawn: ${ops.map((o) => (o.op === 'box' ? `box ${o.label}` : o.op === 'arrow' ? `arrow ${o.from} -> ${o.to}` : o.op === 'note' ? 'note' : o.op === 'clear' ? 'clear' : `${o.op} ${o.target}`)).join('; ')}.` : 'Nothing drawn.';
  return dropped.length ? `${landed} Not drawn: ${dropped.map((d, i) => `${i + 1}. ${d}`).join(' ')}` : landed;
}
