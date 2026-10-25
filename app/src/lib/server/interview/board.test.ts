import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compactElements, fingerprint, type BoardElement } from '../../board/serialise';

// The board store: versions by compare-and-set, the room's fingerprint checked, PNG slots, the
// text the interviewer gets, and the snapshots the grader gets.

const { store } = vi.hoisted(() => {
  const map = new Map<string, string>();
  const store = {
    map,
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => void map.set(k, v),
    setNx: async (k: string, v: string) => (map.has(k) ? false : (map.set(k, v), true)),
    del: async (k: string) => void map.delete(k),
    cas: async (k: string, expected: string, v: string) => (map.get(k) !== expected ? false : (map.set(k, v), true)),
  };
  return { store };
});
vi.mock('../store', () => ({ getStore: async () => store }));

const board = await import('./board');
const { BoardConflict, BoardInvalid, boardTextFor, deleteBoard, readBoard, readPng, saveBoard, savePng, withSnapshot, CURRENT_PNG, PNG_MAX_PER_SESSION, SNAPSHOTS_MAX } = board;

const SESSION = { id: 'a'.repeat(24), startedAt: '2026-10-23T09:00:00Z' };
let n = 0;
const box = (label: string, x: number, extra: Partial<BoardElement> = {}): BoardElement[] => {
  const id = `b${++n}`;
  return [
    { id, type: 'rectangle', x, y: 0, width: 120, height: 60, version: 1, ...extra },
    { id: `${id}t`, type: 'text', x: x + 10, y: 20, width: 100, height: 20, version: 1, text: label, containerId: id },
  ];
};
const arrow = (from: string, to: string): BoardElement => ({ id: `a${++n}`, type: 'arrow', x: 0, y: 0, width: 10, height: 0, version: 1, points: [[0, 0], [10, 0]], startBinding: { elementId: from }, endBinding: { elementId: to }, endArrowhead: 'arrow' });
const body = (elements: BoardElement[], baseVersion: number) => ({ baseVersion, fingerprint: fingerprint(compactElements(elements)), elements });

beforeEach(() => {
  store.map.clear();
  vi.useRealTimers();
});

describe('saving the board', () => {
  it('numbers versions, keeps short ids stable across them, and answers only the version and fingerprint', async () => {
    const [gw, gwt] = box('Gateway', 0);
    const [db, dbt] = box('DB', 300);
    const v1 = await saveBoard(SESSION, 30, body([gw, gwt], 0));
    expect(v1).toEqual({ version: 1, fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(Object.keys(v1)).toEqual(['version', 'fingerprint']);
    const v2 = await saveBoard(SESSION, 30, body([gw, gwt, db, dbt, arrow(gw.id, db.id)], 1));
    expect(v2.version).toBe(2);
    const record = (await readBoard(SESSION.id))!;
    expect(record.graph.nodes.map((x) => [x.id, x.label])).toEqual([
      ['n1', 'Gateway'],
      ['n2', 'DB'],
    ]);
    expect(record.graph.edges).toMatchObject([{ id: 'e1', from: 'n1', to: 'n2' }]);
    expect(record.elements[0]).not.toHaveProperty('seed');
  });

  it('refuses a stale base with the server’s scene, a wrong fingerprint, and a malformed body', async () => {
    const els = box('Gateway', 0);
    await saveBoard(SESSION, 30, body(els, 0));
    const other = box('Cache', 100);
    const stale = saveBoard(SESSION, 30, body(other, 0));
    await expect(stale).rejects.toBeInstanceOf(BoardConflict);
    await stale.catch((err: InstanceType<typeof BoardConflict>) => {
      expect(err.current.version).toBe(1);
      expect(err.current.elements.map((e) => e.id)).toEqual(els.map((e) => e.id));
    });
    await expect(saveBoard(SESSION, 30, { ...body(other, 1), fingerprint: 'deadbeef' })).rejects.toBeInstanceOf(BoardInvalid);
    await expect(saveBoard(SESSION, 30, { elements: [] })).rejects.toBeInstanceOf(BoardInvalid);
    await expect(saveBoard(SESSION, 30, { ...body(other, 1), elements: Array.from({ length: 401 }, () => other[0]) })).rejects.toBeInstanceOf(BoardInvalid);
  });

  it('saves nothing for the same scene again, or for the room’s parting beacon', async () => {
    const els = box('Gateway', 0);
    await saveBoard(SESSION, 30, body(els, 0));
    expect(await saveBoard(SESSION, 30, body(els, 1))).toMatchObject({ version: 1 });
    expect(await saveBoard(SESSION, 30, { baseVersion: 1, fingerprint: 'abcdef01' })).toMatchObject({ version: 1 });
    expect((await readBoard(SESSION.id))!.version).toBe(1);
  });
});

describe('the PNGs', () => {
  it('keeps one per stage up to the cap, the current slot aside, each with the board version it shows', async () => {
    await saveBoard(SESSION, 30, body(box('Gateway', 0), 0));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
    for (let i = 0; i < PNG_MAX_PER_SESSION; i++) expect(await savePng(SESSION, 30, `s${i}`, png, 1)).toEqual({ stored: true });
    expect(await savePng(SESSION, 30, 'one-too-many', png, 1)).toEqual({ stored: false });
    expect(await savePng(SESSION, 30, 's0', png, 1)).toEqual({ stored: true });
    expect(await savePng(SESSION, 30, CURRENT_PNG, png, 1)).toEqual({ stored: true });
    expect(await readPng(SESSION.id, 's0')).toEqual({ version: 1, data: png.toString('base64') });
    expect(await readPng(SESSION.id, 'nope')).toBeNull();
    await expect(savePng(SESSION, 30, 's0', Buffer.from('not a png'), 1)).rejects.toBeInstanceOf(BoardInvalid);
    await expect(savePng(SESSION, 30, 's0', Buffer.alloc(201 * 1024), 1)).rejects.toBeInstanceOf(BoardInvalid);
    expect(await savePng({ ...SESSION, id: 'b'.repeat(24) }, 30, 's0', png, 1)).toEqual({ stored: false });
  });

  it('deletes them with the board', async () => {
    await saveBoard(SESSION, 30, body(box('Gateway', 0), 0));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8)]);
    await savePng(SESSION, 30, 's1', png, 1);
    await savePng(SESSION, 30, CURRENT_PNG, png, 1);
    expect([...store.map.keys()]).toHaveLength(3);
    await deleteBoard(SESSION.id);
    expect([...store.map.keys()]).toEqual([]);
  });
});

describe('what the interviewer and the grader get', () => {
  it('gives the whole board the first time, a delta after, and nothing when unchanged', async () => {
    const [gw, gwt] = box('Gateway', 0);
    await saveBoard(SESSION, 30, body([gw, gwt], 0));
    const r1 = (await readBoard(SESSION.id))!;
    const first = boardTextFor(r1, undefined, 's1')!;
    expect(first.version).toBe(1);
    expect(first.text).toMatch(/^<board v="1" stage="s1" nodes="1" edges="0">/);
    expect(first.text).toContain('n1 "Gateway"');
    expect(boardTextFor(r1, { seen: 1, graph: r1.graph }, 's1')).toBeNull();
    const [db, dbt] = box('DB', 300);
    await saveBoard(SESSION, 30, body([gw, gwt, db, dbt, arrow(gw.id, db.id)], 1));
    const r2 = (await readBoard(SESSION.id))!;
    const delta = boardTextFor(r2, { seen: 1, graph: r1.graph }, 's1')!;
    expect(delta.text).toMatch(/^<board-delta from="1" v="2"/);
    expect(delta.text).toContain('+ n2 "DB"');
    expect(delta.text).toContain('+ e1 n1 -> n2');
    // The base graph lost: the whole board again.
    expect(boardTextFor(r2, { seen: 1, graph: null }, 's1')!.text).toMatch(/^<board v="2"/);
  });

  it('snapshots the board once per stage and version, capped', async () => {
    await saveBoard(SESSION, 30, body(box('Gateway', 0), 0));
    const record = (await readBoard(SESSION.id))!;
    const s0 = { boardSnapshots: undefined } as unknown as Parameters<typeof withSnapshot>[0];
    const s1 = withSnapshot(s0, record, 's1');
    expect(s1.boardSnapshots).toMatchObject([{ stage: 's1', version: 1, text: expect.stringContaining('<board v="1" stage="s1"') }]);
    expect(withSnapshot(s1, record, 's1')).toBe(s1);
    expect(withSnapshot(s1, null, 's2')).toBe(s1);
    let s = s1;
    for (let i = 0; i < SNAPSHOTS_MAX + 3; i++) s = withSnapshot(s, { ...record, version: 10 + i }, `s${i}`);
    expect(s.boardSnapshots).toHaveLength(SNAPSHOTS_MAX);
    // An empty board is not worth a snapshot.
    expect(withSnapshot(s0, { ...record, graph: { ...record.graph, nodes: [] } }, 's1')).toBe(s0);
  });
});
