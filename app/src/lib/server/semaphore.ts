// A per-process concurrency limit with a short, bounded queue, for work that saturates a
// dependency when too much of it runs at once: Claude calls (llm-gateway.ts) and sign-ins, which
// are bcrypt-bound in Strapi (auth-routes.ts). Callers past the limit wait up to `waitMs` in a
// queue of at most `maxQueue`; anyone who can't get a slot in time is turned away at once with
// the error `busy()` makes, so overload becomes a fast 503 + Retry-After instead of a pile-up.

type Waiter = { resolve: () => void; reject: (e: Error) => void };

export type SemaphoreErrors = {
  /** The queue is full, or the wait ran out. */
  busy: () => Error;
  /** The caller's signal aborted while it waited. */
  aborted: () => Error;
};

export class Semaphore {
  #active = 0;
  #queue: Waiter[] = [];
  constructor(
    private limit: () => number,
    private maxQueue: () => number,
    private errors: SemaphoreErrors,
  ) {}

  get active() {
    return this.#active;
  }

  get queued() {
    return this.#queue.length;
  }

  /** Waits up to waitMs for a slot and returns its release; throws `busy` when there's none. */
  async acquire(waitMs: number, signal?: AbortSignal): Promise<() => void> {
    const release = () => {
      const next = this.#queue.shift();
      if (next) next.resolve();
      else this.#active--;
    };
    if (this.#active < this.limit()) {
      this.#active++;
      return once(release);
    }
    if (this.#queue.length >= this.maxQueue() || waitMs <= 0) throw this.errors.busy();
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject,
      };
      const drop = (e: Error) => {
        const i = this.#queue.indexOf(waiter);
        if (i >= 0) this.#queue.splice(i, 1);
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      };
      const timer = setTimeout(() => drop(this.errors.busy()), waitMs);
      const onAbort = () => {
        clearTimeout(timer);
        drop(this.errors.aborted());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(waiter);
    });
    // The releasing call handed its slot straight to us (active count unchanged).
    return once(release);
  }

  /** Runs `fn` in a slot (see acquire), releasing it however `fn` ends. */
  async run<T>(waitMs: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(waitMs, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function once(fn: () => void) {
  let done = false;
  return () => {
    if (!done) {
      done = true;
      fn();
    }
  };
}
