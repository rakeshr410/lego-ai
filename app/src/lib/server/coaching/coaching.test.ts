import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { getSnapshot, topicAt } from '../../content-snapshot';
import { drawParser, parseDraw } from '../interview/draw';
import { catalogFromFiles, footprint, lessonBoard } from './catalog';
import { packRef } from './schema';
import { coachingSectionHash } from './hash';
import { placeOp, startIds } from './layout';
import { lessonPlan } from './lessons';
import { packNotes, recallNotes } from './notes';
import { lessonProgress, recallLines } from './progress';

// The coaching material (docs/coaching.md): the catalog's checks on packs and playlists, a lesson's
// board plan as drawing operations, <place> in the coach's drawing, a lesson as the coach's plan,
// and the learner's thread from one lesson to the next.

vi.mock('../../sd', async (importOriginal) => {
  const sd = await importOriginal<typeof import('../../sd')>();
  return { ...sd, FLAGS: { ...sd.FLAGS, interview: true, reviewedOnly: false } };
});

const pid = (key: string) => `sys/topic/${key}`;

/** A small valid pack; `over` replaces top-level fields. */
function pack(key: string, over: Record<string, unknown> = {}) {
  return {
    id: pid(key),
    title: `Pack ${key}`,
    source: { hash: 'abcdef012345' },
    review: { status: 'draft', provenance: 'ai-drafted', author: 'claude' },
    context: { after: null, assumes: [], carries: ['An idea'], terms: [] },
    board: {
      keep: [],
      elements: [
        { id: `${key}-r`, kind: 'region', label: `Region ${key}`, at: [2, 2], size: [30, 10] },
        { id: `${key}-a`, kind: 'box', label: `A ${key}`, at: [4, 6], in: `${key}-r` },
        { id: `${key}-b`, kind: 'box', label: `B ${key}`, at: [20, 6], in: `${key}-r` },
      ],
      arrows: [{ id: `${key}-ab`, from: `${key}-a`, to: `${key}-b`, label: 'calls' }],
    },
    beats: [
      { point: 'First point', kind: 'mechanism', weight: 'core', teach: ['Say it'], draw: [`${key}-r`, `${key}-a`], check: 'Why?', answer: 'Because' },
      { point: 'Second point', kind: 'mechanism', weight: 'core', teach: ['Say more'], draw: [`${key}-b`, `${key}-ab`], misconceptions: ['wrong -> right'] },
    ],
    task: { prompt: 'Draw it', expects: [1, 2] },
    ...over,
  };
}

const playlist = (lessons: { slug: string; parts: string[][] }[]) => ({
  slug: 'pl',
  title: 'Playlist',
  summary: 'S',
  outline: 'O',
  lessons: lessons.map((l) => ({ slug: l.slug, title: `Lesson ${l.slug}`, summary: 'S', parts: l.parts.map((packs, n) => ({ title: `Part ${n + 1}`, minutes: 5, packs })) })),
});

const filesOf = (packs: ReturnType<typeof pack>[], pl?: ReturnType<typeof playlist>) =>
  Object.fromEntries([...packs.map((p) => [`packs/${p.id}.yaml`, stringify(p)] as const), ...(pl ? [[`playlists/${pl.slug}.yaml`, stringify(pl)] as const] : [])]);

/** The second pack of a lesson: continues `one`, keeps its region, sits to its right. */
const second = () =>
  pack('two', {
    context: { after: pid('one'), assumes: ['An idea'], carries: ['Another'], terms: [] },
    board: {
      keep: ['one-r', 'one-a'],
      elements: [
        { id: 'two-r', kind: 'region', label: 'Region two', at: [40, 2], size: [30, 10] },
        { id: 'two-a', kind: 'box', label: 'A two', at: [42, 6], in: 'two-r' },
        { id: 'two-b', kind: 'box', label: 'B two', at: [56, 6], in: 'two-r' },
        { id: 'two-n', kind: 'note', label: 'a rule', at: [42, 11] },
      ],
      arrows: [
        { id: 'two-ab', from: 'two-a', to: 'two-b' },
        { id: 'two-back', from: 'two-a', to: 'one-r', dashed: true },
      ],
    },
    beats: [
      { point: 'Third', kind: 'mechanism', weight: 'core', teach: ['x'], draw: ['two-r', 'two-a', 'two-b', 'two-ab'] },
      { point: 'Fourth', kind: 'rule', weight: 'supporting', teach: ['y'], draw: ['two-n', 'two-back'] },
    ],
    task: undefined,
  });

describe('catalogFromFiles', () => {
  it('reads a lesson of two chained packs with no errors', () => {
    const c = catalogFromFiles(filesOf([pack('one'), second()], playlist([{ slug: 'l1', parts: [[pid('one')], [pid('two')]] }])));
    expect(c.errors).toEqual([]);
    expect(c.packs.size).toBe(2);
    expect([...lessonBoard(c.packs, [pid('one'), pid('two')]).keys()]).toEqual(['one-r', 'one-a', 'one-b', 'one-ab', 'two-r', 'two-a', 'two-b', 'two-n', 'two-ab', 'two-back']);
  });

  it('checks a pack: its path, its references, and its drawing order', () => {
    const bad = pack('one', {
      id: pid('elsewhere'),
      board: {
        keep: ['ghost'],
        elements: [
          { id: 'r', kind: 'region', label: 'R', at: [0, 0] },
          { id: 'a', kind: 'box', label: 'A', at: [2, 3], in: 'b' },
          { id: 'b', kind: 'box', label: 'B', at: [12, 3] },
          { id: 'n', kind: 'note', label: 'N', at: [2, 9] },
        ],
        arrows: [
          { id: 'ab', from: 'a', to: 'b' },
          { id: 'an', from: 'a', to: 'n' },
          { id: 'aa', from: 'a', to: 'a' },
        ],
      },
      beats: [
        { point: 'P', kind: 'mechanism', weight: 'core', teach: ['t'], draw: ['ab', 'a', 'b', 'b'] },
        { point: 'Q', kind: 'mechanism', weight: 'core', teach: ['t'], draw: ['n', 'an', 'nope'] },
      ],
      task: { prompt: 'p', expects: [3] },
    });
    const errors = catalogFromFiles({ 'packs/sys/topic/one.yaml': stringify(bad) }).errors.map((e) => e.replace(/^[^:]+: /, ''));
    expect(errors).toEqual(
      expect.arrayContaining([
        'id "sys/topic/elsewhere" should be its path, "sys/topic/one"',
        'board.keep "ghost" is not on the board of the packs before it',
        'region "r" needs a size',
        'element "a" sits in "b", which is not a region',
        'arrow "an" ends at the note "n"; arrows join regions and shapes',
        'arrow "aa" points at itself',
        'beat 1 draws arrow "ab" before "a" is on the board',
        'beat 1 draws "b" a second time',
        'beat 2 draws "nope", which is not one of this pack\'s elements or arrows',
        '"r" is never drawn by a beat',
        '"aa" is never drawn by a beat',
        'task expects beat 3, but the pack has 2',
      ]),
    );
  });

  it('reports what does not parse, by file and field', () => {
    const c = catalogFromFiles({ 'packs/sys/topic/one.yaml': 'id: [', 'packs/sys/topic/two.yaml': stringify(pack('two', { beats: [] })), 'notes.yaml': 'a: 1' });
    expect(c.errors).toEqual([expect.stringMatching(/^notes\.yaml: not under packs\//), expect.stringMatching(/^packs\/sys\/topic\/one\.yaml: not YAML/), expect.stringMatching(/^packs\/sys\/topic\/two\.yaml: beats: /)]);
  });

  it('checks a playlist: its packs exist and chain, and a lesson has one label per element', () => {
    const loose = pack('two', { board: { ...pack('two').board, elements: pack('two').board.elements.map((e) => (e.id === 'two-a' ? { ...e, label: 'a ONE' } : e)) } });
    const c = catalogFromFiles(filesOf([pack('one'), loose], playlist([{ slug: 'l1', parts: [[pid('one')], [pid('two'), pid('three')]] }, { slug: 'l1', parts: [[pid('one')]] }])));
    expect(c.errors).toEqual(
      expect.arrayContaining([
        'playlists/pl.yaml: lesson "l1": "sys/topic/two" should continue "sys/topic/one" (context.after)',
        'playlists/pl.yaml: lesson "l1" uses "sys/topic/three", which is not a pack',
        'playlists/pl.yaml: lesson "l1": label "a ONE" is on both "one-a" and "two-a"',
        'playlists/pl.yaml: lesson "l1" appears twice',
      ]),
    );
  });

  it('checks a lesson board as one picture: on the grid, inside its region, nothing partly over anything', () => {
    const p2 = second();
    (p2.board as { elements: unknown[] }).elements = [
      { id: 'two-r', kind: 'region', label: 'Region two', at: [20, 2], size: [30, 12] },
      { id: 'two-a', kind: 'box', label: 'A two', at: [22, 2], in: 'two-r' },
      { id: 'two-b', kind: 'box', label: 'B two', at: [115, 6] },
      { id: 'two-n', kind: 'note', label: 'a rule that is long', at: [40, 11] },
    ];
    const errors = catalogFromFiles(filesOf([pack('one'), p2], playlist([{ slug: 'l1', parts: [[pid('one')], [pid('two')]] }]))).errors;
    expect(errors).toEqual([
      // A region no bigger than what it holds.
      'playlists/pl.yaml: lesson "l1": region "two-r" runs 9 rows below what it holds; make it 5 rows tall',
      'playlists/pl.yaml: lesson "l1": region "two-r" runs 20 cells right of what it holds; make it 12 cells wide',
      'playlists/pl.yaml: lesson "l1": "two-a" is not inside its region "two-r" below the region\'s label (covers 22, 2, 8, 3; the region 20, 2, 30, 12)',
      'playlists/pl.yaml: lesson "l1": "two-b" runs off the 120 × 110 grid (covers 115, 6, 8, 3)',
      'playlists/pl.yaml: lesson "l1": "one-r" (2, 2, 30, 10) and "two-r" (20, 2, 30, 12) overlap',
    ]);
    // A label that does not fit its box, an arrow with no room for its words, an arrow through a box.
    const p3 = second();
    (p3.board as { elements: unknown[] }).elements = [
      { id: 'two-r', kind: 'region', label: 'Region two', at: [40, 2], size: [22, 10] },
      { id: 'two-a', kind: 'box', label: 'A two with far too many words for it', at: [42, 6], in: 'two-r' },
      { id: 'two-b', kind: 'box', label: 'B two', at: [52, 6], in: 'two-r' },
      { id: 'two-n', kind: 'note', label: 'a rule', at: [42, 11] },
    ];
    (p3.board as { arrows: unknown[] }).arrows = [
      { id: 'two-ab', from: 'two-a', to: 'two-b', label: 'calls often' },
      { id: 'two-back', from: 'two-a', to: 'one-a', dashed: true },
    ];
    const more = catalogFromFiles(filesOf([pack('one'), p3], playlist([{ slug: 'l1', parts: [[pid('one')], [pid('two')]] }]))).errors;
    expect(more).toEqual([
      'playlists/pl.yaml: lesson "l1": "two-a" label "A two with far too many words for it" wraps to 3 lines in a box 8 × 3, which holds 2',
      'playlists/pl.yaml: lesson "l1": arrow "two-ab" (two-a -> two-b) has 40px between its boxes, short of the 141px its label "calls often" needs',
      'playlists/pl.yaml: lesson "l1": arrow "two-back" (two-a -> one-a) crosses another box on its way',
    ]);
    // A note is as wide as its words.
    expect(footprint({ id: 'n', kind: 'note', label: 'x'.repeat(20), at: [1, 1] })).toEqual([1, 1, 10, 1]);
  });
});

describe('a backend pack', () => {
  it('is named backend/<system>/<topic>/<section>, its system keeping the prefix', () => {
    expect(packRef('backend/url-shortener/short-links-end-to-end/api')).toEqual({ system: 'backend/url-shortener', topic: 'short-links-end-to-end', sectionKey: 'api', section: 'short-links-end-to-end/api' });
    expect(packRef('twitter/news-feed-end-to-end/api')).toEqual({ system: 'twitter', topic: 'news-feed-end-to-end', sectionKey: 'api', section: 'news-feed-end-to-end/api' });
  });

  it('checks beside a frontend pack of the same system, topic and section', () => {
    const front = pack('a');
    const back = { ...pack('a'), id: `backend/${pid('a')}` };
    const c = catalogFromFiles({ [`packs/${front.id}.yaml`]: stringify(front), [`packs/${back.id}.yaml`]: stringify(back) });
    expect(c.errors).toEqual([]);
    expect([...c.packs.keys()].sort()).toEqual([`backend/${pid('a')}`, pid('a')]);
  });
});

describe('the board plan', () => {
  const c = catalogFromFiles(filesOf([pack('one'), second()]));
  const layout = lessonBoard(c.packs, [pid('one'), pid('two')]);

  it('turns an id into the operation that draws it, in board pixels', () => {
    expect(placeOp(layout, 'one-r')).toEqual({ op: { op: 'region', label: 'Region one', at: { x: 40, y: 40 }, size: { w: 600, h: 200 } } });
    expect(placeOp(layout, 'one-a')).toEqual({ op: { op: 'box', label: 'A one', at: { x: 80, y: 120 }, size: { w: 160, h: 60 } } });
    expect(placeOp(layout, 'two-n')).toEqual({ op: { op: 'note', text: 'a rule', at: { x: 840, y: 220 } } });
    expect(placeOp(layout, 'two-back')).toEqual({ op: { op: 'arrow', from: 'A two', to: 'Region one', dashed: true } });
    expect(placeOp(layout, 'nope')).toEqual({ error: 'place "nope": no such id in this lesson\'s board plan' });
  });

  it('opens a board with regions, then shapes, then arrows', () => {
    expect(startIds(layout, ['one-ab', 'one-a', 'one-r', 'one-b'])).toEqual(['one-r', 'one-a', 'one-b', 'one-ab']);
  });

  it('draws <place> where the plan puts it, as one operation of the cap, and skips what is already there at no cost', () => {
    const out = parseDraw('Here. <draw><place ids="one-r,one-a,one-b,one-ab"/><place ids="one-a, ghost"/><box label="X"/><box label="Y"/></draw>', null, true, { edit: true, layout, maxOps: 2 });
    // The second place draws nothing (one-a is there, ghost is not in the plan), so it costs nothing.
    expect(out.ops.map((o) => o.op)).toEqual(['region', 'box', 'box', 'arrow', 'box']);
    expect(out.dropped).toEqual(['place "ghost": no such id in this lesson\'s board plan', 'past the cap of 2 operations a reply: the rest were dropped']);
    // An arrow waits for both its ends.
    expect(parseDraw('<draw><place ids="one-ab"/></draw>', null, true, { edit: true, layout }).dropped).toEqual(['place "one-ab": draw "A one" first']);
    // No plan, no place.
    expect(parseDraw('<draw><place ids="one-r"/></draw>', null, true, { edit: true }).dropped).toEqual(['<place>: there is no board plan in this session']);
  });

  it('draws the opening board before the reply, which may build on it', () => {
    const out = parseDraw('Picking up from last time.', null, true, { edit: true, layout, prelude: '<place ids="one-r,one-a"/>' });
    expect(out.text).toBe('Picking up from last time.');
    expect(out.ops.map((o) => o.op)).toEqual(['region', 'box']);
    const p = drawParser(null, { edit: true, layout, prelude: '<place ids="one-r,one-a,one-b"/>' });
    expect(p.element('<place ids="one-ab"/>').map((o) => o.op)).toEqual(['arrow']);
  });
});

describe('the learner’s thread', () => {
  it('records a lesson by the words of its points, and recalls the newest lessons first', () => {
    const plan = { plan: { stages: [{ items: [{ id: 'a/1', text: 'Boxes stack' }, { id: 'a/2', text: 'Margins merge' }, { id: 'a/3', text: 'Lines wrap' }] }] } } as never;
    const state = { items: { 'a/1': 'understood', 'a/2': 'shaky' } } as never;
    const one = lessonProgress(plan, state, ['What about grid?'], true, '2026-10-01T00:00:00Z');
    expect(one).toEqual({ status: 'finished', at: '2026-10-01T00:00:00Z', understood: ['Boxes stack'], shaky: ['Margins merge'], parked: ['What about grid?'] });
    const two = { status: 'started' as const, at: '2026-10-02T00:00:00Z', understood: [], shaky: [], parked: [] };
    const titles = new Map([['box', 'Box model'], ['fc', 'Formatting contexts'], ['now', 'Now']]);
    const lines = recallLines({ lessons: { box: one, fc: two, now: two, gone: two } }, titles, 'now');
    expect(lines).toEqual(['"Formatting contexts" (started)', '"Box model" (finished) — held: Boxes stack — shaky: Margins merge — asked and parked: What about grid?']);
    expect(recallNotes(lines)).toContain('<learner>');
    expect(recallNotes([])).toBe('');
  });
});

// The material in this repository: every file checks, and every pack is still true to its section.
describe('app/coaching', () => {
  const root = join(process.cwd(), 'coaching');
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.yaml')) files[relative(root, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  const c = catalogFromFiles(files);

  it('checks', () => {
    expect(c.errors).toEqual([]);
  });

  it('names sections the content has, and no playlist takes a system’s slug', () => {
    const snap = getSnapshot();
    for (const id of c.packs.keys()) {
      const { system, topic, sectionKey } = packRef(id);
      const t = topicAt(snap, system, topic);
      expect(t && coachingSectionHash(t.content ?? [], sectionKey), id).toBeTruthy();
    }
    const systems = new Set(snap.topics.map((t) => t.system));
    for (const slug of c.playlists.keys()) expect(systems.has(slug), slug).toBe(false);
  });

  it('turns a lesson into a coach plan, beats into items, with its pack notes', () => {
    const plan = lessonPlan('frontend-foundations', 'box-model');
    expect(plan).not.toBeNull();
    const { plan: p, lesson } = plan!;
    expect(p.system).toBe('frontend-foundations');
    expect(p.stages.map((s) => s.key)).toEqual(['part-1', 'part-2']);
    const box = c.packs.get('formatting-contexts-and-css-positioning/box-model-and-normal-flow/key-idea')!;
    const items = p.stages[0].items;
    if (lesson!.sections[0].pack) {
      expect(items.map((i) => i.text)).toEqual(box.beats.map((b) => b.point));
      expect(items[0].id).toBe('box-model-and-normal-flow/key-idea/1');
      const notes = packNotes(lesson!, lesson!.sections[0].key, (id) => items.findIndex((i) => i.id === id) + 1);
      expect(notes).toContain('<place ids="card,content-box,padding-box,border-box,margin-box"/>');
    } else {
      // A stale or unreviewed pack falls back to the article: one item for the section.
      expect(items).toHaveLength(1);
    }
    expect(lessonPlan('frontend-foundations', 'nope')).toBeNull();
    expect(lessonPlan('nope', 'box-model')).toBeNull();
  });
});

describe('a numbered list the learner can give', () => {
  // A region with two lines on slots two rows apart, and an ask on the beat that writes them.
  const listPack = (over: { items?: unknown[]; list?: Record<string, unknown>; asks?: unknown[] } = {}) => {
    const p = pack('l');
    return {
      ...p,
      board: {
        keep: [],
        elements: over.items ?? [
          { id: 'l-r', kind: 'region', label: 'Requirements', at: [2, 2], size: [28, 12] },
          { id: 'l-1', kind: 'note', label: 'newest first', at: [3, 5], in: 'l-r' },
          { id: 'l-2', kind: 'note', label: 'endless', at: [3, 7], in: 'l-r' },
        ],
        arrows: [],
        lists: [{ id: 'l-list', in: 'l-r', at: [3, 5], step: 2, slots: 4, width: 26, items: ['l-1', 'l-2'], ...over.list }],
      },
      beats: [{ point: 'What it does', kind: 'requirement', weight: 'core', teach: ['Say it'], draw: ['l-r', 'l-1', 'l-2'] }],
      asks: over.asks ?? [{ list: 'l-list', beats: [1], question: 'What should it do?', hints: ['Think about scrolling.'] }],
      task: undefined,
    };
  };
  const errorsOf = (p: ReturnType<typeof listPack>) => catalogFromFiles(filesOf([p as never])).errors;

  it('accepts lines on their slots, and numbers them in the plan', () => {
    expect(errorsOf(listPack())).toEqual([]);
    const plan = lessonBoard(catalogFromFiles(filesOf([listPack() as never])).packs, [pid('l')]);
    expect(placeOp(plan, 'l-2')).toEqual({ op: { op: 'note', text: '2. endless', at: { x: 60, y: 140 }, list: 'l-list', covers: 'l-2' } });
  });

  it('reports a line off its slot or numbered by hand, a slot past the region, and an ask that misses a line', () => {
    const items = [
      { id: 'l-r', kind: 'region', label: 'Requirements', at: [2, 2], size: [30, 12] },
      { id: 'l-1', kind: 'note', label: '1. newest first', at: [3, 5], in: 'l-r' },
      { id: 'l-2', kind: 'note', label: 'endless', at: [3, 8], in: 'l-r' },
    ];
    expect(errorsOf(listPack({ items }))).toEqual(
      expect.arrayContaining([expect.stringContaining('"l-1" carries a number'), expect.stringContaining('"l-2" should be at its slot, [3, 7]')]),
    );
    expect(errorsOf(listPack({ list: { slots: 6 } }))).toEqual([expect.stringContaining('slot 6 (3, 15, 26, 1) is not inside "l-r"')]);
    expect(errorsOf(listPack({ asks: [{ list: 'l-list', beats: [2], question: 'Q?', hints: [] }] }))).toEqual(
      expect.arrayContaining([expect.stringContaining('names beat 2'), expect.stringContaining('"l-1" is not drawn by any of its beats')]),
    );
  });

  it('keeps its empty slots as room in a lesson’s board checks', () => {
    const files = filesOf([listPack() as never], playlist([{ slug: 'one', parts: [[pid('l')]] }]));
    const catalog = catalogFromFiles(files);
    expect(catalog.errors).toEqual([]);
  });
});

describe('an ask for parts of the plan', () => {
  const errorsOf = (asks: unknown[]) => catalogFromFiles(filesOf([pack('p', { asks }) as never])).errors;

  it('accepts parts its beats draw, and reports a part they do not, an unknown one, both a list and ids, or a beat asked twice', () => {
    expect(errorsOf([{ ids: ['p-a'], beats: [1], question: 'What sits there?', hints: [] }])).toEqual([]);
    expect(errorsOf([{ ids: ['p-b', 'nope'], beats: [1], question: 'Q?', hints: [] }])).toEqual([
      expect.stringContaining('"p-b" is not drawn by any of its beats'),
      expect.stringContaining('"nope" is not an element of this pack'),
    ]);
    expect(errorsOf([{ ids: ['p-a'], list: 'x', beats: [1], question: 'Q?', hints: [] }])).toEqual([expect.stringContaining('names a list or ids')]);
    expect(errorsOf([{ ids: ['p-a'], beats: [1], question: 'Q?', hints: [] }, { ids: ['p-b'], beats: [1, 2], question: 'Q?', hints: [] }])).toEqual([expect.stringContaining('beat 1 is in two asks')]);
  });

  it('puts the beats’ regions up first and keeps their arrows for the fill (the feed’s components)', () => {
    const asks = lessonPlan('frontend-foundations', 'news-feed')!.lesson!.asks;
    const ui = asks.find((a) => a.lines['news-feed-end-to-end/components/1']?.length)!;
    expect(ui.list).toBeUndefined();
    expect(ui.before).toEqual(['components']);
    expect(ui.rest['news-feed-end-to-end/components/1']).toEqual(['screen-holds-list', 'list-holds-card']);
    expect(asks.find((a) => a.list === 'fr-list')!.before).toEqual(['requirements', 'fr-heading']);
  });
});

