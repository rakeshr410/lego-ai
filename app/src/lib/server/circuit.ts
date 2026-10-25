// A small circuit breaker for calls to a dependency (Strapi). After `threshold` failures in a row
// it opens: calls fail at once with CircuitOpenError instead of queueing behind a dependency that
// is down or hanging, which would pile up sockets and handlers until the whole web tier stalls.
// After `cooldownMs` one trial call is let through (half-open); success closes the circuit,
// failure opens it for another cooldown. A neutral outcome (the caller gave up before the
// dependency answered) is neither: it leaves the count and the state as they were and frees the
// trial slot for the next call. Per process: each web instance judges for itself.

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitOpenError extends Error {
  constructor(
    readonly circuit: string,
    /** Seconds until the next trial call, for Retry-After. */
    readonly retryAfter: number,
  ) {
    super(`${circuit} is unavailable (circuit open)`);
    this.name = 'CircuitOpenError';
  }
}

export type CircuitOptions = {
  /** Failures in a row that open the circuit. */
  threshold?: number;
  /** How long it stays open before a trial call. */
  cooldownMs?: number;
  now?: () => number;
  /** Called on every state change (for logs). */
  onChange?: (to: CircuitState, from: CircuitState, failures: number) => void;
};

export class CircuitBreaker {
  readonly name: string;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onChange?: CircuitOptions['onChange'];
  private failures = 0;
  private openedAt = 0;
  private current: CircuitState = 'closed';
  private trial = false;

  constructor(name: string, opts: CircuitOptions = {}) {
    this.name = name;
    this.threshold = Math.max(1, opts.threshold ?? 5);
    this.cooldownMs = opts.cooldownMs ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange;
  }

  get state(): CircuitState {
    return this.current;
  }

  private to(next: CircuitState) {
    if (next === this.current) return;
    const from = this.current;
    this.current = next;
    this.onChange?.(next, from, this.failures);
  }

  /** Throws CircuitOpenError when a call may not go out now; otherwise returns whether it's the trial call. */
  private admit(): boolean {
    if (this.current === 'closed') return false;
    const wait = this.openedAt + this.cooldownMs - this.now();
    if (this.current === 'open' && wait <= 0) this.to('half-open');
    if (this.current === 'half-open' && !this.trial) {
      this.trial = true;
      return true;
    }
    throw new CircuitOpenError(this.name, Math.max(1, Math.ceil(Math.max(wait, 1_000) / 1_000)));
  }

  private succeeded() {
    this.failures = 0;
    this.to('closed');
  }

  private failed(isTrial: boolean) {
    this.failures++;
    if (isTrial || (this.current === 'closed' && this.failures >= this.threshold)) {
      this.openedAt = this.now();
      this.to('open');
    }
  }

  /**
   * Runs `call` through the breaker. `isNeutral` picks errors that say nothing about the
   * dependency either way (the caller's own abort): they count neither as a failure nor as a
   * success, so they can't reset the count or close a half-open circuit while the dependency is
   * still hung. Of the rest, `isFailure` decides which count against the dependency (by default
   * all); a result can count too (e.g. a 5xx response) via `badResult`.
   */
  async run<T>(
    call: () => Promise<T>,
    opts: { isNeutral?: (err: unknown) => boolean; isFailure?: (err: unknown) => boolean; badResult?: (value: T) => boolean } = {},
  ): Promise<T> {
    const isTrial = this.admit();
    try {
      const value = await call();
      if (opts.badResult?.(value)) this.failed(isTrial);
      else this.succeeded();
      return value;
    } catch (err) {
      if (opts.isNeutral?.(err)) {
        // No bookkeeping: the trial slot (if this was it) is freed below, the state stays.
      } else if (opts.isFailure?.(err) ?? true) this.failed(isTrial);
      else this.succeeded(); // it answered, just not with what the caller wanted
      throw err;
    } finally {
      if (isTrial) this.trial = false;
    }
  }

  /** Back to closed, e.g. between tests. */
  reset() {
    this.failures = 0;
    this.trial = false;
    this.current = 'closed';
  }
}
