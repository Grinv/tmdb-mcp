// Serializes calls and spaces them at least `minIntervalMs` apart.
//
// Acquisitions are ordered through a tail-promise chain, so only one runs at a
// time and the spacing bookkeeping stays consistent. In-flight network time still
// overlaps because acquire() resolves before the request itself runs.

export class RateLimiter {
  readonly #minIntervalMs: number;
  #tail: Promise<void> = Promise.resolve();
  // `null` is an explicit "no acquisition yet" sentinel — NOT a stand-in for
  // "far in the past". Using 0 for that purpose implicitly relied on real
  // Date.now() always being far from the epoch, which breaks if the clock is
  // ever mocked to start at/near 0 (e.g. Node 20's t.mock.timers in tests).
  #lastStart: number | null = null;

  constructor(minIntervalMs: number) {
    this.#minIntervalMs = Math.max(0, minIntervalMs);
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
      this.#lastStart = Date.now();
      // Release the next waiter's gate; the spacing above keeps them in line.
      release();
    });
  }

  /** Delay (ms) before the next acquisition may start. */
  #delayUntilAllowed(): number {
    if (this.#lastStart === null) return 0;
    return Math.max(0, this.#lastStart + this.#minIntervalMs - Date.now());
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
