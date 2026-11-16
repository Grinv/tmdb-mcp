// Serializes calls and spaces them at least `minIntervalMs` apart.
//
// Acquisitions are ordered through a tail-promise chain, so only one runs at a
// time and the spacing bookkeeping stays consistent. In-flight network time still
// overlaps because acquire() resolves before the request itself runs.

export class RateLimiter {
  readonly #minIntervalMs: number;
  #tail: Promise<void> = Promise.resolve();
  // `null` is an explicit "no acquisition yet" sentinel — NOT a stand-in for
  // "far in the past": the monotonic clock starts near 0 at process start.
  #lastStart: number | null = null;
  readonly #now: () => number;

  /** `now` is a monotonic clock (ms): wall-clock jumps would stall or skip
   *  the spacing. Tests pass their own. */
  constructor(minIntervalMs: number, now: () => number = () => performance.now()) {
    this.#minIntervalMs = Math.max(0, minIntervalMs);
    this.#now = now;
  }

  /** Resolves when the caller is allowed to proceed. */
  acquire(): Promise<void> {
    const prev = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return prev.then(async () => {
      const wait = this.#delayUntilAllowed();
      if (wait > 0) await delay(wait);
      this.#lastStart = this.#now();
      // Release the next waiter's gate; the spacing above keeps them in line.
      release();
    });
  }

  /** Delay (ms) before the next acquisition may start. */
  #delayUntilAllowed(): number {
    if (this.#lastStart === null) return 0;
    return Math.max(0, this.#lastStart + this.#minIntervalMs - this.#now());
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
