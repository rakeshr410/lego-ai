import { parse } from 'yaml';
import { arrowRoute, labelRoom } from '../../board/geometry.ts';
import { BOX_CELLS, CELL, GRID, pack as packSchema, playlist as playlistSchema, type BoardArrow, type BoardElement, type BoardList, type Pack, type Playlist } from './schema.ts';

// The coaching material (docs/coaching.md), read and checked as one catalog: every pack and every
// playlist under app/coaching, parsed against the schema, then checked against each other: a pack's
// id is its path; its board's ids are unique and every reference resolves (an arrow's ends, a
// region an element sits in, a beat's drawing, the elements kept from earlier packs); every element
// is drawn by a beat, never before what it points at; a playlist's packs exist and each continues the
// one before it; and a lesson's board never has two elements with one label (labels are how the
// coach names what it points at), and reads as one picture: everything on the grid, inside the
// region it says it is in, and no two shapes partly over each other. Pure: the files come in as text (catalogFromFiles), so the
// checks run the same in a test, in the build (the module below) and in scripts/coaching.ts.

export type Catalog = {
  packs: Map<string, Pack>;
  playlists: Map<string, Playlist>;
  /** Everything wrong, as `<file>: <what>`; a catalog with errors is not served (catalog() throws). */
  errors: string[];
};

/** A list's line knows its list and its place in the pack's order (1-based), which numbers it when nothing else does. */
type Placed = (BoardElement & { type: 'element'; slot?: { list: string; n: number } }) | (BoardArrow & { type: 'arrow' });

/** A pack's elements and arrows by id. */
export const placedOf = (p: Pack): Map<string, Placed> => {
  const slots = new Map((p.board.lists ?? []).flatMap((l) => l.items.map((id, k) => [id, { list: l.id, n: k + 1 }] as const)));
  return new Map<string, Placed>([
    ...p.board.elements.map((e) => [e.id, { ...e, type: 'element' as const, ...(slots.has(e.id) ? { slot: slots.get(e.id)! } : {}) }] as const),
    ...p.board.arrows.map((a) => [a.id, { ...a, type: 'arrow' as const }] as const),
  ]);
};

/**
 * Everything a pack's board can show: what it keeps from the packs before it (resolved along `after`),
 * then its own elements. Kept ids that resolve to nothing are reported by the catalog's checks.
 */
export function boardOf(packs: ReadonlyMap<string, Pack>, id: string, seen = new Set<string>()): Map<string, Placed> {
  const p = packs.get(id);
  if (!p || seen.has(id)) return new Map();
  seen.add(id);
  const before = p.context.after ? boardOf(packs, p.context.after, seen) : new Map<string, Placed>();
  const out = new Map<string, Placed>();
  for (const k of p.board.keep) {
    const hit = before.get(k);
    if (hit) out.set(k, hit);
  }
  for (const [k, v] of placedOf(p)) out.set(k, v);
  return out;
}

function checkPack(file: string, p: Pack, packs: ReadonlyMap<string, Pack>, errors: string[]) {
  const err = (what: string) => errors.push(`${file}: ${what}`);
  const own = new Set<string>();
  for (const x of [...p.board.elements, ...p.board.arrows]) {
    if (own.has(x.id)) err(`board id "${x.id}" is used twice`);
    own.add(x.id);
  }
  if (p.context.after && !packs.has(p.context.after)) err(`context.after "${p.context.after}" is not a pack`);
  const before = p.context.after ? boardOf(packs, p.context.after) : new Map<string, Placed>();
  for (const k of p.board.keep) {
    if (!before.has(k)) err(`board.keep "${k}" is not on the board of the packs before it`);
    if (own.has(k)) err(`board.keep "${k}" is also one of its own ids`);
  }
  // A kept frame comes back with something in it: an empty one reads as a section with nothing to say.
  const kept = new Set(p.board.keep);
  for (const k of kept) {
    const x = before.get(k);
    if (x?.type !== 'element' || x.kind !== 'region') continue;
    const members = [...before.values()].filter((m) => m.type === 'element' && m.in === k);
    if (members.length && !members.some((m) => kept.has(m.id) || [...p.board.elements].some((e) => e.in === k)))
      err(`board.keep "${k}" keeps the frame without anything that was in it; keep some of its contents, or leave it out`);
  }
  const board = boardOf(packs, p.id);
  const isElement = (id: string) => board.get(id)?.type === 'element';
  for (const e of p.board.elements) {
    if (e.kind === 'region' && !e.size) err(`region "${e.id}" needs a size`);
    if (e.in && board.get(e.in)?.type !== 'element') err(`element "${e.id}" sits in "${e.in}", which is not on the board`);
    else if (e.in && (board.get(e.in) as BoardElement).kind !== 'region') err(`element "${e.id}" sits in "${e.in}", which is not a region`);
  }
  for (const a of p.board.arrows) {
    if (!isElement(a.from)) err(`arrow "${a.id}" leaves "${a.from}", which is not an element on the board`);
    if (!isElement(a.to)) err(`arrow "${a.id}" reaches "${a.to}", which is not an element on the board`);
    if (a.from === a.to) err(`arrow "${a.id}" points at itself`);
    // The board joins arrows to shapes by label; a note is free text, not a shape.
    for (const end of [a.from, a.to]) if ((board.get(end) as BoardElement | undefined)?.kind === 'note') err(`arrow "${a.id}" ends at the note "${end}"; arrows join regions and shapes`);
  }
  // Drawing order: kept elements are there from the start; each beat may draw only what exists by then.
  const drawn = new Set<string>(p.board.keep);
  p.beats.forEach((b, n) => {
    for (const id of b.draw ?? []) {
      const x = board.get(id);
      if (!x || !own.has(id)) {
        err(`beat ${n + 1} draws "${id}", which is not one of this pack's elements or arrows`);
        continue;
      }
      if (drawn.has(id)) err(`beat ${n + 1} draws "${id}" a second time`);
      if (x.type === 'arrow') for (const end of [x.from, x.to]) if (!drawn.has(end)) err(`beat ${n + 1} draws arrow "${id}" before "${end}" is on the board`);
      if (x.type === 'element' && x.in && !drawn.has(x.in)) err(`beat ${n + 1} draws "${id}" before its region "${x.in}"`);
      drawn.add(id);
    }
  });
  for (const id of own) if (!drawn.has(id)) err(`"${id}" is never drawn by a beat`);
  checkLists(p, err);
  for (const i of p.task?.expects ?? []) if (i > p.beats.length) err(`task expects beat ${i}, but the pack has ${p.beats.length}`);
}

/** The cells a list's slot covers: [x, y, w, h] (`k` from 0). */
export const slotCells = (l: BoardList, k: number): [number, number, number, number] => [l.at[0], l.at[1] + k * l.step, l.width, 1];
/** The characters a list line may have, its number ("12. ") included. */
export const listChars = (l: BoardList) => Math.floor((l.width - 1) / NOTE_CHAR_CELLS);

/**
 * A pack's lists and asks: a list's lines are its own notes in its region, each on its slot in order and short
 * enough for its width once numbered; every slot, used or not, is inside the region and clear of everything
 * else; an ask names a list of the pack and beats that draw its lines, and every line of an asked list is drawn by
 * an asked beat (what the learner leaves out is added from those beats).
 */
function checkLists(p: Pack, err: (what: string) => void) {
  const els = new Map(p.board.elements.map((e) => [e.id, e] as const));
  const lists = new Map((p.board.lists ?? []).map((l) => [l.id, l] as const));
  const listed = new Map<string, string>();
  for (const l of lists.values()) {
    if (els.has(l.id)) err(`list "${l.id}" has the id of an element`);
    const region = els.get(l.in);
    if (region?.kind !== 'region') err(`list "${l.id}" sits in "${l.in}", which is not a region of this pack`);
    if (l.items.length > l.slots) err(`list "${l.id}" has ${l.items.length} items for ${l.slots} slots`);
    l.items.forEach((id, k) => {
      const e = els.get(id);
      if (listed.has(id)) err(`"${id}" is in two lists`);
      listed.set(id, l.id);
      if (e?.kind !== 'note') return err(`list "${l.id}" item "${id}" is not a note of this pack`);
      if (e.in !== l.in) err(`list "${l.id}" item "${id}" should sit in "${l.in}"`);
      const [x, y] = slotCells(l, k);
      if (e.at[0] !== x || e.at[1] !== y) err(`list "${l.id}" item "${id}" should be at its slot, [${x}, ${y}]`);
      if (/^\d+\.\s/.test(e.label)) err(`list "${l.id}" item "${id}" carries a number; the board numbers the lines`);
      if (e.label.length + 4 > listChars(l)) err(`list "${l.id}" item "${id}" is ${e.label.length} characters; numbered, a line of ${l.width} cells holds ${listChars(l) - 4}`);
    });
    if (region?.kind === 'region' && region.size) {
      const r = footprint(region);
      for (let k = 0; k < l.slots; k++) {
        const slot = slotCells(l, k);
        if (!within(slot, r, REGION_LABEL_ROWS)) err(`list "${l.id}" slot ${k + 1} (${slot.join(', ')}) is not inside "${l.in}" below its label`);
        for (const e of p.board.elements) if (e.id !== l.in && !l.items.includes(e.id) && meets(slot, footprint(e)) && !(e.kind === 'region' && within(slot, footprint(e)))) err(`list "${l.id}" slot ${k + 1} meets "${e.id}"`);
      }
    }
  }
  const asked = new Set<string>();
  const askedBeats = new Set<number>();
  for (const a of p.asks ?? []) {
    for (const n of a.beats) {
      if (askedBeats.has(n)) err(`beat ${n} is in two asks`);
      askedBeats.add(n);
    }
    const drawn = new Set(a.beats.flatMap((n) => p.beats[n - 1]?.draw ?? []));
    for (const id of a.frame ?? []) if (!drawn.has(id) || a.ids?.includes(id)) err(`ask frame "${id}" should be drawn by its beats and not be one of its ids`);
    if (!a.list === !a.ids) {
      err(`an ask names a list or ids, one of them`);
      continue;
    }
    if (a.ids) {
      const what = `ask on beats ${a.beats.join(', ')}`;
      for (const n of a.beats) if (!p.beats[n - 1]) err(`${what}: the pack has ${p.beats.length} beats`);
      for (const id of a.ids) {
        if (!els.has(id)) err(`${what}: "${id}" is not an element of this pack`);
        else if (!drawn.has(id)) err(`${what}: "${id}" is not drawn by any of its beats`);
        if (listed.has(id)) err(`${what}: "${id}" is a list's line; ask for the list`);
      }
      continue;
    }
    const l = lists.get(a.list!);
    if (!l) {
      err(`ask names list "${a.list}", which is not one of this pack's lists`);
      continue;
    }
    for (const n of a.beats) {
      const b = p.beats[n - 1];
      if (!b) {
        err(`ask on "${a.list}" names beat ${n}, but the pack has ${p.beats.length}`);
        continue;
      }
      for (const id of b.draw ?? []) {
        const of = listed.get(id);
        if (of && of !== a.list) err(`ask on "${a.list}": beat ${n} draws "${id}" of list "${of}"`);
        if (of === a.list) asked.add(id);
      }
    }
    for (const id of l.items) if (!asked.has(id)) err(`ask on "${a.list}": "${id}" is not drawn by any of its beats`);
  }
}

function checkPlaylist(file: string, pl: Playlist, packs: ReadonlyMap<string, Pack>, errors: string[]) {
  const err = (what: string) => errors.push(`${file}: ${what}`);
  const lessons = new Set<string>();
  const earlier = new Set<string>();
  for (const l of pl.lessons) {
    if (lessons.has(l.slug)) err(`lesson "${l.slug}" appears twice`);
    lessons.add(l.slug);
    const ids = l.parts.flatMap((part) => part.packs);
    ids.forEach((id, k) => {
      const p = packs.get(id);
      if (!p) return err(`lesson "${l.slug}" uses "${id}", which is not a pack`);
      // Inside a lesson each pack continues the one before; a lesson's first pack starts fresh or continues an earlier lesson's.
      const want = k > 0 ? ids[k - 1] : null;
      if (want && p.context.after !== want) err(`lesson "${l.slug}": "${id}" should continue "${want}" (context.after)`);
      if (!want && p.context.after && !earlier.has(p.context.after)) err(`lesson "${l.slug}": "${id}" continues "${p.context.after}", which no earlier lesson teaches`);
    });
    for (const id of ids) earlier.add(id);
    // Labels name elements on the board: one meaning per label across the lesson.
    const labels = new Map<string, string>();
    for (const [id, x] of lessonBoard(packs, ids)) {
      if (x.type !== 'element') continue;
      const key = x.label.trim().toLowerCase();
      const other = labels.get(key);
      if (other && other !== id) err(`lesson "${l.slug}": label "${x.label}" is on both "${other}" and "${id}"`);
      labels.set(key, id);
    }
    // A list's empty slots are room the region keeps for lines still to come.
    const board = lessonBoard(packs, ids);
    const slots = new Map<string, [number, number, number, number][]>();
    for (const p of packs.values())
      for (const list of p.board.lists ?? []) if (board.has(list.in)) slots.set(list.in, [...(slots.get(list.in) ?? []), ...Array.from({ length: list.slots }, (_, k) => slotCells(list, k))]);
    checkGeometry(l.slug, board, err, slots);
    // One section key per part: two systems' topics with one slug would be ambiguous in the plan.
    const keys = ids.map((id) => id.split('/').slice(1).join('/'));
    if (new Set(keys).size !== keys.length) err(`lesson "${l.slug}" teaches one topic section twice`);
  }
}

/** An arrow's label size on the board (ExcalidrawCanvas.tsx). */
const ARROW_LABEL_PX = 16;
/** A note's text, in cells across (the board writes notes at 14px, about 0.45 of a cell per character). */
const NOTE_CHAR_CELLS = 0.45;
/** Rows at a region's top that its label takes. */
const REGION_LABEL_ROWS = 2;

/** The cells an element covers: [x, y, w, h]. */
export function footprint(e: BoardElement): [number, number, number, number] {
  const [x, y] = e.at;
  if (e.kind === 'note') return [x, y, Math.ceil(e.label.length * NOTE_CHAR_CELLS) + 1, 1];
  const [w, h] = e.size ?? BOX_CELLS;
  return [x, y, w, h];
}

const within = ([x, y, w, h]: number[], [rx, ry, rw, rh]: number[], top = 0) => x >= rx && y >= ry + top && x + w <= rx + rw && y + h <= ry + rh;
const meets = ([x, y, w, h]: number[], [ox, oy, ow, oh]: number[]) => x < ox + ow && ox < x + w && y < oy + oh && oy < y + h;

/** A box label's characters, in cells across (the board writes labels at 20px, about 0.55 of a cell each). */
const LABEL_CHAR_CELLS = 0.55;
/** The most a region may run past its contents, in cells (below them, and beside them), and its widest. */
const REGION_SLACK = { rows: 4, cols: 6 };
const REGION_MAX_COLS = 70;

/** The lines a label wraps to in a box `w` cells wide (word by word, as the board wraps it). */
function labelLines(label: string, w: number): number {
  const room = Math.max(1, Math.floor(Math.max(1, w - 1) / LABEL_CHAR_CELLS));
  let lines = 1;
  let used = 0;
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const n = word.length;
    if (used && used + 1 + n <= room) used += 1 + n;
    else {
      // A new line (none needed for the first word), and more for a word longer than a line.
      lines += (used ? 1 : 0) + Math.ceil(n / room) - 1;
      used = n % room || room;
    }
  }
  return lines;
}

/**
 * The lesson's board as one picture: on the grid, inside its region, no shapes partly over each other (one wholly
 * inside a region is how regions work), regions no larger than what they hold, labels that fit their boxes, and
 * arrows that run straight from box to box without crossing another, with room for their words (lib/board/geometry.ts
 * routes any other arrow around, which reads worse).
 */
function checkGeometry(slug: string, board: ReadonlyMap<string, Placed>, err: (what: string) => void, slots: ReadonlyMap<string, readonly number[][]> = new Map()) {
  const els = [...board.values()].filter((x): x is BoardElement & { type: 'element' } => x.type === 'element');
  const fp = new Map(els.map((e) => [e.id, footprint(e)] as const));
  for (const g of els.filter((e) => e.kind === 'region')) {
    const [rx, ry, rw, rh] = fp.get(g.id)!;
    if (rw > REGION_MAX_COLS) err(`lesson "${slug}": region "${g.id}" is ${rw} cells wide, past the ${REGION_MAX_COLS} a view shows at a readable size`);
    const inside = [...els.filter((e) => e.in === g.id).map((e) => fp.get(e.id)!), ...(slots.get(g.id) ?? [])];
    if (!inside.length) continue;
    const low = Math.max(...inside.map(([, y, , h]) => y + h));
    const far = Math.max(...inside.map(([x, , w]) => x + w));
    if (ry + rh - low > REGION_SLACK.rows) err(`lesson "${slug}": region "${g.id}" runs ${ry + rh - low} rows below what it holds; make it ${low - ry + 2} rows tall`);
    if (rx + rw - far > REGION_SLACK.cols) err(`lesson "${slug}": region "${g.id}" runs ${rx + rw - far} cells right of what it holds; make it ${far - rx + 2} cells wide`);
  }
  for (const e of els.filter((x) => x.kind === 'box' || x.kind === 'oval' || x.kind === 'diamond')) {
    const [, , w, h] = fp.get(e.id)!;
    // An oval or a diamond writes inside about two thirds of its box.
    const usable = e.kind === 'box' ? w : Math.floor(w * 0.7);
    const fits = Math.max(1, Math.floor((h * CELL - 8) / 25));
    const lines = labelLines(e.label, usable);
    if (lines > fits) err(`lesson "${slug}": "${e.id}" label "${e.label}" wraps to ${lines} lines in a box ${w} × ${h}, which holds ${fits}`);
  }
  const rect = (id: string) => {
    const [x, y, w, h] = fp.get(id)!;
    return { x: x * CELL, y: y * CELL, w: w * CELL, h: h * CELL };
  };
  const shapes = els.filter((e) => e.kind !== 'region' && e.kind !== 'note');
  for (const a of [...board.values()].filter((x): x is BoardArrow & { type: 'arrow' } => x.type === 'arrow')) {
    if (!fp.has(a.from) || !fp.has(a.to)) continue;
    const [ra, rb] = [rect(a.from), rect(a.to)];
    const obstacles = shapes.filter((e) => e.id !== a.from && e.id !== a.to).map((e) => rect(e.id));
    const route = arrowRoute(ra, rb, obstacles, labelRoom(a.label ?? '', ARROW_LABEL_PX));
    if (route.points.length <= 2) continue;
    const straight = arrowRoute(ra, rb, [], 0);
    const [p, q] = straight.points;
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const crossed = obstacles.length && arrowRoute(ra, rb, obstacles, 0).points.length > 2;
    err(
      `lesson "${slug}": arrow "${a.id}" (${a.from} -> ${a.to}) ` +
        (crossed ? `crosses another box on its way` : `has ${Math.round(length)}px between its boxes, short of the ${Math.round(labelRoom(a.label ?? '', ARROW_LABEL_PX))}px its label "${a.label}" needs`),
    );
  }
  for (const e of els) {
    const r = fp.get(e.id)!;
    if (r[0] < 0 || r[1] < 0 || r[0] + r[2] > GRID.cols || r[1] + r[3] > GRID.rows) err(`lesson "${slug}": "${e.id}" runs off the ${GRID.cols} × ${GRID.rows} grid (covers ${r.join(', ')})`);
    const region = e.in ? fp.get(e.in) : null;
    if (region && !within(r, region, REGION_LABEL_ROWS)) err(`lesson "${slug}": "${e.id}" is not inside its region "${e.in}" below the region's label (covers ${r.join(', ')}; the region ${region.join(', ')})`);
  }
  for (let i = 0; i < els.length; i++)
    for (let j = i + 1; j < els.length; j++) {
      const [a, b] = [els[i], els[j]];
      const [ra, rb] = [fp.get(a.id)!, fp.get(b.id)!];
      if (!meets(ra, rb)) continue;
      if ((a.kind === 'region' && within(rb, ra)) || (b.kind === 'region' && within(ra, rb))) continue;
      err(`lesson "${slug}": "${a.id}" (${ra.join(', ')}) and "${b.id}" (${rb.join(', ')}) overlap`);
    }
}

/** Everything a lesson's board can show, across its packs in order (the first pack's kept elements included). */
export function lessonBoard(packs: ReadonlyMap<string, Pack>, ids: readonly string[]): Map<string, Placed> {
  const out = new Map<string, Placed>();
  for (const id of ids) for (const [k, v] of boardOf(packs, id)) if (!out.has(k)) out.set(k, v);
  return out;
}

/** The catalog from the files' text, by path relative to app/coaching (`packs/<id>.yaml`, `playlists/<slug>.yaml`). */
export function catalogFromFiles(files: Readonly<Record<string, string>>): Catalog {
  const errors: string[] = [];
  const packs = new Map<string, Pack>();
  const playlists = new Map<string, Playlist>();
  const packFiles = new Map<string, string>();
  const playlistFiles = new Map<string, string>();
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    let data: unknown;
    try {
      data = parse(text);
    } catch (e) {
      errors.push(`${path}: not YAML (${(e as Error).message.split('\n')[0]})`);
      continue;
    }
    const pm = /^packs\/(.+)\.yaml$/.exec(path);
    const lm = /^playlists\/([^/]+)\.yaml$/.exec(path);
    const schema = pm ? packSchema : lm ? playlistSchema : null;
    if (!schema) {
      errors.push(`${path}: not under packs/ or playlists/`);
      continue;
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 8)) errors.push(`${path}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      continue;
    }
    if (pm) {
      const p = parsed.data as Pack;
      if (p.id !== pm[1]) errors.push(`${path}: id "${p.id}" should be its path, "${pm[1]}"`);
      packs.set(p.id, p);
      packFiles.set(p.id, path);
    } else {
      const pl = parsed.data as Playlist;
      if (pl.slug !== lm![1]) errors.push(`${path}: slug "${pl.slug}" should be its file name, "${lm![1]}"`);
      playlists.set(pl.slug, pl);
      playlistFiles.set(pl.slug, path);
    }
  }
  for (const [id, p] of packs) checkPack(packFiles.get(id)!, p, packs, errors);
  for (const [slug, pl] of playlists) checkPlaylist(playlistFiles.get(slug)!, pl, packs, errors);
  return { packs, playlists, errors };
}
