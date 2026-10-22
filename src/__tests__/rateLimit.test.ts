import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../lib/rateLimit.ts";

// Small windows keep the test fast while exercising the real timing logic.
async function timeAcquires(limiter: RateLimiter, n: number): Promise<number[]> {
  const start = Date.now();
  const stamps: number[] = [];
  for (let i = 0; i < n; i += 1) {
    await limiter.acquire();
    stamps.push(Date.now() - start);
  }
  return stamps;
}

describe("RateLimiter", () => {
  test("zero interval imposes no delay", async (t) => {
    // Assert on the timer itself rather than elapsed wall time, which a loaded
    // machine can stretch past any small threshold.
    const setTimeoutSpy = t.mock.method(globalThis, "setTimeout");
    const limiter = new RateLimiter(0);
    for (let i = 0; i < 5; i += 1) await limiter.acquire();
    assert.equal(setTimeoutSpy.mock.callCount(), 0, "no acquisition should schedule a wait");
  });

  test("min interval spaces consecutive acquisitions", async () => {
    const stamps = await timeAcquires(new RateLimiter(40), 3);
    assert.ok(stamps[1]! >= 35, `2nd should wait ~40ms, got ${stamps[1]}ms`);
    assert.ok(stamps[2]! >= 75, `3rd should wait ~80ms, got ${stamps[2]}ms`);
  });

  test("first acquisition never waits, even when the clock starts at/near the epoch", async (t) => {
    // Regression: #delayUntilAllowed used to compare against a `#lastStart = 0`
    // sentinel, silently relying on Date.now() always being far from 0 — true
    // for any real clock, but not for one mocked to start at 0. Mock only Date
    // and spy on (not fake) setTimeout: if the bug were back, the first
    // acquire() would schedule a ~40ms wait. Checking the timer call instead of
    // elapsed wall time keeps this deterministic on a loaded machine.
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const setTimeoutSpy = t.mock.method(globalThis, "setTimeout");
    const limiter = new RateLimiter(40);
    await limiter.acquire();
    assert.equal(setTimeoutSpy.mock.callCount(), 0, "first acquisition should not wait");
    // The spy itself must see a real wait, or the zero above proves nothing.
    await limiter.acquire();
    assert.equal(setTimeoutSpy.mock.callCount(), 1, "second acquisition should wait");
  });
});
