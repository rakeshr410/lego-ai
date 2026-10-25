// Retry policy pieces for calls to a dependency that can be briefly overloaded (Anthropic's 529).
// Retries help a reader through a blip, but every retry is more load on a service that is
// already struggling, and a crowd of callers retrying in step makes the next spike. So: waits
// are randomized (full jitter), and a per-process budget caps retries at a share of recent calls
// so that when most calls fail, retrying stops instead of multiplying the load.

export type BackoffOptions = {
  /** The first retry waits up to this long; each further retry doubles it. */
  baseMs: number;
  /** No wait is longer than this. */
  capMs: number;
};

/**
 * How long to wait before retry number `retry` (1 for the first): a random time between 0 and
 * min(capMs, baseMs * 2^(retry-1)) ("full jitter"), so callers that failed together don't retry
 * together.
 */
export function backoffMs(retry: number, { baseMs, capMs }: BackoffOptions, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, retry - 1));
  return Math.round(random() * ceiling);
}

export type RetryBudgetOptions = {
  /** Retries allowed per call made, over the window (0.2: at most one retry for every five calls). */
  ratio?: number;
  /** Retries allowed in any window regardless of traffic, so a quiet process can still retry. */
  minPerWindow?: number;
  /** The sliding window, in whole seconds' worth of milliseconds. */
  windowMs?: number;
  now?: () => number;
};

type Bucket = { second: number; calls: number; retries: number };

/**
 * Caps retries at `ratio` of the calls made over the last `windowMs`, plus `minPerWindow`.
 * Counts live in one-second buckets, so memory is fixed whatever the traffic.
 */
export class RetryBudget {
  readonly #ratio: number;
  readonly #min: number;
  readonly #now: () => number;
  readonly #buckets: Bucket[];

  constructor({ ratio = 0.2, minPerWindow = 5, windowMs = 10_000, now = Date.now }: RetryBudgetOptions = {}) {
    this.#ratio = ratio;
    this.#min = minPerWindow;
    this.#now = now;
    this.#buckets = Array.from({ length: Math.max(1, Math.round(windowMs / 1000)) }, () => ({ second: -1, calls: 0, retries: 0 }));
  }

  #bucket(): Bucket {
    const second = Math.floor(this.#now() / 1000);
    const b = this.#buckets[second % this.#buckets.length];
    if (b.second !== second) Object.assign(b, { second, calls: 0, retries: 0 });
    return b;
  }

  #totals() {
    const oldest = Math.floor(this.#now() / 1000) - this.#buckets.length;
    let calls = 0;
    let retries = 0;
    for (const b of this.#buckets) {
      if (b.second > oldest) {
        calls += b.calls;
        retries += b.retries;
      }
    }
    return { calls, retries };
  }

  /** Counts a first attempt. */
  recordCall() {
    this.#bucket().calls++;
  }

  /** Takes one retry from the budget; false when it's spent. */
  tryRetry(): boolean {
    const { calls, retries } = this.#totals();
    if (retries >= this.#min + this.#ratio * calls) return false;
    this.#bucket().retries++;
    return true;
  }
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
