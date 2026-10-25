import { derivePlans, type DerivedPlan } from '@arrowbox/content-kit';
import { loadContent } from '@arrowbox/content-kit/node';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { escapeTagged } from '../tutor';
import { stageItems } from './director';
import { aggregate, candidateTurns, evaluatorRequest, quoteMatches, toEntry, type Ledger, type LedgerEntry, jsonObjectIn } from './evaluator';
import type { Plan } from './plans';
import type { Turn } from './sessions';

// The evaluator's rules (design section 8): quotes are the candidate's own words or the tag is
// dropped; questions and declines are never evidence; the aggregator lets later evidence win.

const contentDir = fileURLToPath(new URL('../../../../../content', import.meta.url));
const { catalog } = loadContent(contentDir);
const system = catalog.systems.find((s) => s.slug === 'customer-support-agent')!;
const derived: DerivedPlan = derivePlans({ system, topics: catalog.topics.filter((t) => t.system === system.slug).map((t) => ({ slug: t.slug, file: t.file, data: t.data })), override: null }).system!;
const plan: Plan = { system: { slug: system.slug, name: system.name }, plan: derived, version: 'v', briefs: [], scope: null };
const stage = derived.stages[1];
const items = stageItems(stage);

describe('quoteMatches', () => {
  it('accepts a normalized substring or a near-complete word overlap, and refuses short or foreign quotes', () => {
    const said = 'I would keep the conversation state in Redis, keyed by ticket id, with a 24-hour TTL.';
    expect(quoteMatches('keyed by ticket id, with a 24-hour TTL', said)).toBe(true);
    expect(quoteMatches('Keep the conversation state in redis keyed by the ticket id', said)).toBe(true);
    expect(quoteMatches('Redis', said)).toBe(false);
    expect(quoteMatches('a token budget on the summary', said)).toBe(false);
  });

  it('refuses a quote that is really the interviewer’s words', () => {
    const asked = 'Would you keep the state in Redis keyed by ticket id?';
    expect(quoteMatches('keep the state in Redis keyed by ticket id', 'Yes, keep the state in Redis keyed by ticket id, I agree', asked)).toBe(false);
    expect(quoteMatches('state in Redis keyed by ticket', 'Yes, I agree with that, the state in Redis, keyed, by ticket', asked)).toBe(false);
    expect(quoteMatches('and expire it after a day', 'Yes, and expire it after a day so stale tickets go', asked)).toBe(true);
  });
});

describe('toEntry', () => {
  const turns: Turn[] = [
    { role: 'interviewer', stage: stage.key, text: 'What state does one request need?', at: 't0' },
    { role: 'candidate', stage: stage.key, text: 'The ticket, the customer profile and the last few turns, loaded from a store keyed by ticket id.', at: 't1', meta: { section: stage.sections[0] } },
  ];

  it('keeps a partial tag above its own, lower floor and a covered one only above the general floor', () => {
    const e = toEntry(plan, { turns }, 1, 1, {
      utterance: 'answer',
      tags: [
        { item: 2, status: 'partial', conf: 0.35, quote: 'the customer profile' },
        { item: 1, status: 'covered', conf: 0.5, quote: 'loaded from a store keyed by ticket id' },
      ],
    });
    expect(e.tags.map((t) => [t.item, t.status])).toEqual([[items[1].id, 'partial']]);
    expect(e.dropped.map((t) => t.item)).toEqual([items[0].id]);
  });

  it('reads the JSON object out of a reply with text around it', () => {
    expect(jsonObjectIn('<thinking>brief</thinking>{"a":1}')).toEqual({ a: 1 });
    expect(() => jsonObjectIn('no json here')).toThrow(SyntaxError);
  });

  it('resolves item numbers, verifies quotes, floors confidence and ignores unknown numbers', () => {
    const e = toEntry(plan, { turns }, 1, 1, {
      utterance: 'answer',
      tags: [
        { item: 1, status: 'covered', conf: 0.9, quote: 'loaded from a store keyed by ticket id' },
        { item: 2, status: 'partial', conf: 0.2, quote: 'the customer profile' },
        { item: 3, status: 'wrong', conf: 0.8, quote: 'we never need the profile' },
        { item: 99, status: 'covered', conf: 1, quote: 'anything' },
      ],
    });
    expect(e.tags).toEqual([{ item: items[0].id, status: 'covered', conf: 0.9, quote: 'loaded from a store keyed by ticket id' }]);
    expect(e.dropped.map((t) => t.item)).toEqual([items[1].id, items[2].id]);
    expect(e.utterance).toBe('answer');
    expect(e.section).toBe(stage.sections[0]);
  });

  it('never takes a question or a decline as evidence', () => {
    const q = toEntry(plan, { turns: [turns[0], { ...turns[1], text: 'Do we need the customer profile loaded from a store keyed by ticket id?' }] }, 1, 1, {
      utterance: 'question',
      tags: [{ item: 1, status: 'covered', conf: 0.9, quote: 'loaded from a store keyed by ticket id' }],
    });
    expect(q.tags).toEqual([]);
    expect(q.dropped).toHaveLength(1);
  });

  it('builds a request with the stage’s numbered items, the question before and the candidate’s words', () => {
    const req = evaluatorRequest(plan, { turns }, 1);
    const text = req.messages[0].content as string;
    expect(text).toContain(`1. ${escapeTagged(items[0].text)}`);
    expect(text).toContain('<interviewer>What state does one request need?</interviewer>');
    expect(text).toContain('<candidate>The ticket, the customer profile');
  });
});

describe('aggregate', () => {
  const entry = (seq: number, tags: LedgerEntry['tags'], utterance: LedgerEntry['utterance'] = 'answer'): LedgerEntry => ({ turn: seq, seq, stage: stage.key, section: stage.sections[0], utterance, tags, dropped: [], at: 't' });
  const tag = (n: number, status: 'covered' | 'partial' | 'wrong', conf = 0.9) => ({ item: items[n].id, status, conf, quote: 'q' });

  it('lets later evidence win: wrong then covered is covered, covered then wrong is contested, partial never demotes', () => {
    const ledger: Ledger = { entries: { 1: entry(1, [tag(0, 'wrong'), tag(1, 'covered'), tag(2, 'covered')]), 2: entry(2, [tag(0, 'covered'), tag(1, 'wrong'), tag(2, 'partial')]) } };
    const signal = aggregate(ledger, derived);
    const status = (n: number) => signal.items.find((i) => i.id === items[n].id)?.status;
    expect(status(0)).toBe('covered');
    expect(status(1)).toBe('contested');
    expect(status(2)).toBe('covered');
    expect(signal.basedOnTurn).toBe(2);
    expect(signal.recent).toEqual(['answer', 'answer']);
  });

  it('marks the director’s declined items and leaves untouched items out', () => {
    const signal = aggregate({ entries: { 1: entry(1, [tag(0, 'partial')], 'clarify') } }, derived, [items[3].id]);
    expect(signal.items).toEqual([
      { id: items[0].id, status: 'partial', conf: 0.9, probed: false },
      { id: items[3].id, status: 'declined', conf: 0, probed: false },
    ]);
  });

  it('is empty with no entries', () => {
    expect(aggregate({ entries: {} }, derived)).toEqual({ basedOnTurn: 0, items: [], recent: [] });
  });
});

describe('candidateTurns', () => {
  it('numbers the candidate turns from 1 in order', () => {
    const turns: Turn[] = [
      { role: 'interviewer', stage: 'a', text: 'x', at: 't' },
      { role: 'candidate', stage: 'a', text: 'y', at: 't' },
      { role: 'event', stage: 'b', text: 'z', at: 't' },
      { role: 'candidate', stage: 'b', text: 'w', at: 't' },
    ];
    expect(candidateTurns(turns).map((c) => [c.index, c.seq])).toEqual([
      [1, 1],
      [3, 2],
    ]);
  });
});
