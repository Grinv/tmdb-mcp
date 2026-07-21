import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../lib/rateLimit.js";

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
  test("no rules and zero interval imposes no delay", async () => {
    const stamps = await timeAcquires(new RateLimiter(0), 5);
    assert.ok(stamps[4]! < 30, `expected near-instant, got ${stamps[4]}ms`);
  });

  test("min interval spaces consecutive acquisitions", async () => {
    const stamps = await timeAcquires(new RateLimiter(40), 3);
    assert.ok(stamps[1]! >= 35, `2nd should wait ~40ms, got ${stamps[1]}ms`);
    assert.ok(stamps[2]! >= 75, `3rd should wait ~80ms, got ${stamps[2]}ms`);
  });

  test("a sliding window caps a burst beyond its limit", async () => {
    // Allow 3 per 100ms window, no min interval: the 4th must wait for the
    // first to fall out of the window (~100ms).
    const limiter = new RateLimiter(0, [{ limit: 3, windowMs: 100 }]);
    const stamps = await timeAcquires(limiter, 4);
    assert.ok(stamps[2]! < 30, `first 3 should burst, got ${stamps[2]}ms`);
    assert.ok(stamps[3]! >= 90, `4th should wait for the window, got ${stamps[3]}ms`);
  });

  test("multiple simultaneous rules (per-second AND per-minute) both constrain acquisitions", async () => {
    // A tight per-2-window (limit 2/60ms) and a looser per-4-window (limit
    // 4/200ms) active together — the documented "N req/s AND M req/min" use
    // case. The 3rd acquire must wait for the tighter rule's window even
    // though the looser rule alone would still allow it.
    const limiter = new RateLimiter(0, [
      { limit: 2, windowMs: 60 },
      { limit: 4, windowMs: 200 },
    ]);
    const stamps = await timeAcquires(limiter, 5);
    assert.ok(stamps[1]! < 30, `first 2 should burst under both rules, got ${stamps[1]}ms`);
    assert.ok(stamps[2]! >= 50, `3rd must wait for the 60ms window, got ${stamps[2]}ms`);
    // 4th piggybacks on the 3rd's wait (same 60ms boundary) — not a fresh wait.
    assert.ok(stamps[3]! >= 50, `4th should not fire before the 60ms window, got ${stamps[3]}ms`);
    // 5th exceeds the looser rule's limit (4 per 200ms) on top of the tighter
    // one — must wait for the 200ms window, proving the two rules combine
    // (the tighter 60ms rule alone would allow it much sooner).
    assert.ok(stamps[4]! >= 190, `5th must wait for the looser 200ms window, got ${stamps[4]}ms`);
  });

  test("first acquisition never waits, even when the clock starts at/near the epoch", async (t) => {
    // Regression: #delayUntilAllowed used to compare against a `#lastStart = 0`
    // sentinel, silently relying on Date.now() always being far from 0 — true
    // for any real clock, but not for one mocked to start at 0. Mock only Date
    // (not setTimeout) and measure REAL elapsed time via performance.now()
    // (unaffected by the Date mock): if the bug were back, the first acquire()
    // would await a genuine ~40ms setTimeout, which this would catch.
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const limiter = new RateLimiter(40);
    const realStart = performance.now();
    await limiter.acquire();
    const realElapsed = performance.now() - realStart;
    assert.ok(realElapsed < 20, `first acquisition should not really wait, took ${realElapsed}ms`);
  });
});
