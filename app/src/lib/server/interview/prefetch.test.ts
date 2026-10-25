import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../llm-gateway';
import { claimPrefetch, dropPrefetch, hasPrefetch, nearSpoken, normalizeSpoken, PREFETCH_TTL_MS, startPrefetch } from './prefetch';

const k = (spoken: string, context = 'c1') => ({ context, spoken });

// The speculative start's shelf: a guess is kept for its session, handed over when the confirmed
// turn fingerprints the same, and dropped (its call aborted) on other words or after its time.

type Fake = { onText: (d: string) => void; signal: AbortSignal; resolve: (r: CallResult) => void; reject: (e: unknown) => void };

function fakeRun() {
  const seen: Fake[] = [];
  const run = (onText: (d: string) => void, signal: AbortSignal) =>
    new Promise<CallResult>((resolve, reject) => {
      seen.push({ onText, signal, resolve, reject });
    });
  return { seen, run };
}
const result = { message: { id: 'm' }, costUsd: 0.001, model: 'x' } as unknown as CallResult;

describe('prefetch', () => {
  afterEach(() => {
    dropPrefetch('s1', 'ended');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('replays the text already streamed, then the rest, when the confirmed turn matches', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { seen, run } = fakeRun();
    startPrefetch('s1', k('so the users are agents'), run, 1000);
    expect(hasPrefetch('s1')).toBe(true);
    seen[0].onText('Right, ');
    seen[0].onText('so ');
    const got = claimPrefetch('s1', k('so the users are agents'), 1400);
    expect(got?.leadMs).toBe(400);
    expect(hasPrefetch('s1')).toBe(false);
    const text: string[] = [];
    const done = got!.feed((d) => text.push(d));
    seen[0].onText('the users…');
    seen[0].resolve(result);
    await expect(done).resolves.toBe(result);
    expect(text.join('')).toBe('Right, so the users…');
    expect(seen[0].signal.aborted).toBe(false);
  });

  it('drops a guess made on other words, aborting its call, and a newer guess replaces an older one', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { seen, run } = fakeRun();
    expect(startPrefetch('s1', k('so the users are agents'), run)).toBe(true);
    expect(startPrefetch('s1', k('then i would add caching'), run)).toBe(true);
    expect(seen[0].signal.aborted).toBe(true);
    expect(claimPrefetch('s1', k('then i would add a queue'))).toBeNull();
    expect(seen[1].signal.aborted).toBe(true);
    expect(hasPrefetch('s1')).toBe(false);
    expect(claimPrefetch('s1', k('then i would add a queue'))).toBeNull();
    // The same words in another context (another transcript, a changed board) are another turn.
    startPrefetch('s1', k('so the users are agents', 'c1'), run);
    expect(claimPrefetch('s1', k('so the users are agents', 'c2'))).toBeNull();
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(lines.map((l) => l.outcome)).toEqual(['replaced', 'mismatch', 'mismatch']);
    // Each says how far apart the words were, never what they were.
    expect(lines[0]).toMatchObject({ sameContext: true, edits: 5, words: [5, 5] });
    expect(lines[1]).toMatchObject({ sameContext: true, edits: 2, words: [5, 6] });
    expect(lines[2]).toMatchObject({ sameContext: false, edits: 0 });
    expect(JSON.stringify(lines)).not.toContain('users');
  });

  it('hands over a guess made on nearly the words confirmed, and keeps it when a closer guess follows', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { seen, run } = fakeRun();
    // The interim at the stop lacks the final's last word; the final arrives and is posted again.
    expect(startPrefetch('s1', k('i would shard by user id then cache the hot'), run, 1000)).toBe(true);
    expect(startPrefetch('s1', k('i would shard by user id then cache the hot ones'), run, 1300)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].signal.aborted).toBe(false);
    const got = claimPrefetch('s1', k('i would shard by user id then cache the hot ones'), 1400);
    expect(got?.leadMs).toBe(400);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ outcome: 'hit', edits: 1 });
  });

  it('counts the words two spoken texts are apart, within one in seven', () => {
    expect(nearSpoken('so the users are agents', 'so the users are agents')).toBe(0);
    expect(nearSpoken('so the users are agent', 'so the users are agents')).toBe(1);
    expect(nearSpoken('a credit of six euro', 'a credit of 6 euro')).toBe(1);
    expect(nearSpoken('then i would add caching', 'then i would add a queue')).toBeNull();
    expect(nearSpoken('yes', 'no')).toBeNull();
    expect(nearSpoken('not yet', 'not quite')).toBeNull();
    expect(nearSpoken('i would cache it', 'i would cache them')).toBe(1);
    expect(nearSpoken('', 'yes')).toBeNull();
    // Fourteen words allow two edits.
    expect(nearSpoken('one two three four five six seven eight nine ten eleven twelve thirteen fourteen', 'one two three four five six seven eight nine ten eleven twelve thirteen')).toBe(1);
    expect(nearSpoken('one two three four five six seven eight nine ten eleven twelve thirteen fourteen', 'one two three four five six seven eight nine ten eleven twelve')).toBe(2);
    expect(nearSpoken('one two three four five six seven eight nine ten eleven twelve thirteen fourteen', 'one two three four five six seven eight nine ten eleven')).toBeNull();
  });

  it('expires an unclaimed guess', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    const { seen, run } = fakeRun();
    startPrefetch('s1', k('so'), run);
    vi.advanceTimersByTime(PREFETCH_TTL_MS + 1);
    expect(hasPrefetch('s1')).toBe(false);
    expect(seen[0].signal.aborted).toBe(true);
  });

  it('normalizes the transcriber’s capitals and punctuation out of the spoken words', () => {
    expect(normalizeSpoken("I'd shard by user ID, then cache.")).toBe("i'd shard by user id then cache");
    expect(normalizeSpoken('  so   the users — are agents ')).toBe('so the users are agents');
  });
});
