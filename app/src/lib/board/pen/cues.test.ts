import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceCues } from './cues';
import { CUE_WAIT_MS, VOICE_PLAYOUT_MS } from './timing';

// The voice's cues to the pen (cues.ts): a cue applies when its audio is heard, a late pen starts at once with
// the time it lost taken off, a release finishes what the voice reached and drops the rest, and a cue that never
// comes lets the pen go at its own pace.

describe('VoiceCues', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => vi.useRealTimers());

  const signal = () => new AbortController().signal;

  it('gives the pen its cue when the audio behind it is heard', async () => {
    const cues = new VoiceCues();
    const sync = cues.sync('r.1', 0);
    let got: unknown = 'waiting';
    void sync.beforeShape('Border box', signal()).then((c) => (got = c));
    cues.receive({ at: 'shape', ref: 'r.1', i: 0, ms: 900 });
    await vi.advanceTimersByTimeAsync(VOICE_PLAYOUT_MS - 1);
    expect(got).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toEqual({ ms: 900 });
  });

  it('starts a late pen at once, with the time it lost taken off', async () => {
    const cues = new VoiceCues();
    cues.receive({ at: 'write', ref: 'r.1', i: 2, words: [[100, 400], [500, 800]] });
    await vi.advanceTimersByTimeAsync(VOICE_PLAYOUT_MS + 200);
    expect(await cues.sync('r.1', 2).beforeLabel('Border box', signal())).toEqual({ words: [[0, 200], [300, 600]] });
    cues.receive({ at: 'shape', ref: 'r.1', i: 3, ms: 900 });
    await vi.advanceTimersByTimeAsync(VOICE_PLAYOUT_MS + 2000);
    expect(await cues.sync('r.1', 3).beforeShape(undefined, signal())).toEqual({ ms: 150 });
  });

  it('lets the pen go when the learner cuts in, for the drawings it has, and when a cue never comes', async () => {
    const cues = new VoiceCues();
    const waiting = cues.sync('r.1', 0).beforeShape('A', signal());
    cues.receive({ at: 'release' });
    expect(await waiting).toBeUndefined();
    expect(await cues.sync('r.1', 1).beforeLabel('B', signal())).toBeUndefined();
    // A drawing that comes after the release waits for its cues as before, up to CUE_WAIT_MS.
    let got: unknown = 'waiting';
    void cues
      .sync('r.2', 0)
      .beforeShape('C', signal())
      .then((c) => (got = c));
    await vi.advanceTimersByTimeAsync(CUE_WAIT_MS - 1);
    expect(got).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toBeUndefined();
  });

  it('on a cut-in, drops the marks the voice never reached and keeps the one it was on', async () => {
    const cues = new VoiceCues();
    const reached = cues.sync('r.1', 0);
    const next = cues.sync('r.1', 1);
    cues.receive({ at: 'shape', ref: 'r.1', i: 0, ms: 600 });
    expect(reached.dropped!()).toBe(false);
    expect(next.dropped!()).toBe(false);
    cues.receive({ at: 'release' });
    expect(reached.dropped!()).toBe(false);
    expect(next.dropped!()).toBe(true);
    // A cue for it arriving after the cut changes nothing, and a later drawing is drawn as usual.
    cues.receive({ at: 'shape', ref: 'r.1', i: 1, ms: 600 });
    expect(next.dropped!()).toBe(true);
    expect(cues.sync('r.2', 0).dropped!()).toBe(false);
  });
});
