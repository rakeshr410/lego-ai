import type { PenCue, PenSync } from './animator';
import { CUE_WAIT_MS, VOICE_PLAYOUT_MS } from './timing';

// The voice's cues to the pen (docs/coach-mode.md, phase 6; voice/bot/conductor.py). In a voice lesson each
// drawing comes with a reference (`pace`), and for each of its operations the voice service sends two cues in
// the audio's stream: `shape` as the pause before a label starts playing (the pen moves and draws the outline in
// `ms`), and `write` as the label's audio starts (a [start, end] window in ms for each written word, so the pen
// writes a word while it is said). A cue applies when its audio is heard, which is VOICE_PLAYOUT_MS after it
// arrives (the call's audio sits in a jitter buffer; its messages do not). A pen that reaches a mark after its cue
// has applied starts at once, with the time it lost taken off. `release` (the learner cut in, or the call ended)
// stops the drawing where the voice stopped: a mark whose cue came is finished at the pen's own pace, and a mark
// whose cue never came is not drawn (`dropped`), since the voice never got to it. The board is saved as drawn, so
// the coach sees those parts as not yet on the board. A cue that is merely late (CUE_WAIT_MS) still draws.

export type PenCueMessage = {
  at: 'shape' | 'write' | 'release';
  ref?: string;
  i?: number;
  ms?: number;
  words?: [number, number][];
};

type Arrived = { cue: PenCueMessage; at: number };
type Waiter = (cue: PenCue | undefined) => void;

const MIN_SHAPE_MS = 150;

export class VoiceCues {
  private arrived = new Map<string, Arrived>();
  private waiters = new Map<string, Set<Waiter>>();
  private refs = new Set<string>();
  private released = new Set<string>();
  // The marks whose cue came, by drawing and operation: the voice reached them.
  private begun = new Set<string>();

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly playoutMs = VOICE_PLAYOUT_MS,
    private readonly waitMs = CUE_WAIT_MS,
  ) {}

  /** A cue from the call. */
  receive(cue: PenCueMessage): void {
    if (cue.at === 'release') return this.releaseAll();
    if (typeof cue.ref !== 'string' || typeof cue.i !== 'number' || this.released.has(cue.ref)) return;
    const k = key(cue.ref, cue.i, cue.at);
    this.arrived.set(k, { cue, at: this.now() });
    this.begun.add(`${cue.ref}:${cue.i}`);
    const waiting = this.waiters.get(k);
    if (!waiting) return;
    this.waiters.delete(k);
    for (const w of waiting) this.resolveLater(k, w);
  }

  /** The pen's sync for operation `i` of the drawing `ref`: each mark waits for its cue. */
  sync(ref: string, i: number): PenSync {
    this.refs.add(ref);
    const shape = (_: string | undefined, signal: AbortSignal) => this.wait(ref, i, 'shape', signal);
    return {
      beforeShape: shape,
      beforeArrow: shape,
      beforeLabel: (_: string, signal: AbortSignal) => this.wait(ref, i, 'write', signal),
      dropped: () => this.released.has(ref) && !this.begun.has(`${ref}:${i}`),
    };
  }

  /** The voice stopped: what it reached of every drawing so far is finished at the pen's pace, the rest dropped. */
  releaseAll(): void {
    for (const ref of this.refs) this.released.add(ref);
    this.arrived.clear();
    const all = [...this.waiters.values()];
    this.waiters.clear();
    for (const set of all) for (const w of set) w(undefined);
  }

  private wait(ref: string, i: number, at: 'shape' | 'write', signal: AbortSignal): Promise<PenCue | undefined> {
    if (this.released.has(ref)) return Promise.resolve(undefined);
    const k = key(ref, i, at);
    return new Promise((resolve) => {
      let done = false;
      const finish = (cue: PenCue | undefined) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waiters.get(k)?.delete(finish);
        resolve(cue);
      };
      const onAbort = () => finish(undefined);
      const timer = setTimeout(() => finish(undefined), this.waitMs);
      signal.addEventListener('abort', onAbort);
      if (this.arrived.has(k)) this.resolveLater(k, finish);
      else {
        const set = this.waiters.get(k) ?? new Set<Waiter>();
        set.add(finish);
        this.waiters.set(k, set);
      }
    });
  }

  /** Resolves when the cue's audio is heard, or now, shortened by however late the pen is. */
  private resolveLater(k: string, w: Waiter): void {
    const got = this.arrived.get(k);
    if (!got) return w(undefined);
    const due = got.at + this.playoutMs;
    const wait = due - this.now();
    if (wait > 0) setTimeout(() => w(timed(got.cue, 0)), wait);
    else w(timed(got.cue, -wait));
  }
}

const key = (ref: string, i: number, at: string) => `${ref}:${i}:${at}`;

/** The cue as the pen uses it, `late` ms after it applied. */
function timed(cue: PenCueMessage, late: number): PenCue {
  if (cue.at === 'shape') return { ms: Math.max(MIN_SHAPE_MS, (cue.ms ?? 0) - late) };
  return { words: (cue.words ?? []).map(([s, e]) => [Math.max(0, s - late), Math.max(0, e - late)] as const) };
}
