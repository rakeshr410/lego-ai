// Answering on time when a dependency is slow. `within` stops waiting for a piece of work after a
// time budget without cancelling it: the work finishes (or fails) in the background, its failure
// handled, while the caller answers with what it has. For work that is safe to abandon but not
// to interrupt, such as a session check that may be rotating a refresh token half way through.
// Reads that are safe to cut off take an AbortSignal instead (AbortSignal.timeout).

export class DeadlineExceeded extends Error {
  constructor(
    readonly what: string,
    readonly ms: number,
  ) {
    super(`${what} took longer than ${ms} ms`);
    this.name = 'DeadlineExceeded';
  }
}

/** Settles like `work`, or rejects with DeadlineExceeded once `ms` have passed. */
export function within<T>(work: Promise<T>, ms: number, what = 'the call'): Promise<T> {
  // Once we stop waiting, a later failure of the work is nobody's to handle: don't let it
  // surface as an unhandled rejection.
  work.catch(() => {});
  if (ms <= 0) return Promise.reject(new DeadlineExceeded(what, 0));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(what, ms)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A budget for a whole request: how many milliseconds are left of it. */
export function budget(ms: number, now: () => number = Date.now) {
  const until = now() + ms;
  return { left: () => Math.max(0, until - now()) };
}
