import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../lib/errors.ts";
import { TtlCache, cacheKey, degraded, callNotes, type CallNotes } from "../lib/cache.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("cacheKey", () => {
  test("dim insertion order does not affect the resulting key", () => {
    assert.equal(
      cacheKey("movie:1", { region: "US", language: "en-US" }),
      cacheKey("movie:1", { language: "en-US", region: "US" }),
    );
  });

  test("different dim values produce different keys", () => {
    assert.notEqual(
      cacheKey("movie:1", { region: "US", language: "en-US" }),
      cacheKey("movie:1", { region: "GB", language: "en-US" }),
    );
  });

  test("a missing dim is not conflated with an empty-string dim", () => {
    assert.notEqual(cacheKey("watch:1"), cacheKey("watch:1", { region: "" }));
  });

  test("no dims returns the resource unchanged", () => {
    assert.equal(cacheKey("find:imdb_id:tt123"), "find:imdb_id:tt123");
  });
});

describe("TtlCache", () => {
  test("wrapStaleOnError caches and reuses the fresh value", async () => {
    const cache = new TtlCache({ ttlMs: 60_000 });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 42;
    };
    assert.equal(await cache.wrapStaleOnError("k", compute), 42);
    assert.equal(await cache.wrapStaleOnError("k", compute), 42);
    assert.equal(calls, 1);
  });

  test("wrapStaleOnError serves the stale value when compute fails", async () => {
    let now = 0;
    const cache = new TtlCache({ ttlMs: 1, now: () => now }); // 1ms TTL; `now` is the cache's clock
    await cache.wrapStaleOnError("k", async () => 1);
    now += 5;
    const v = await cache.wrapStaleOnError("k", async () => {
      throw new ApiError({ code: "server_error", message: "upstream down" });
    });
    assert.equal(v, 1);
  });

  test("wrapStaleOnError logs a warning when serving stale data", async () => {
    let now = 0;
    const warnings: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    };
    const cache = new TtlCache({ ttlMs: 1, logger, now: () => now });
    await cache.wrapStaleOnError("k", async () => 1);
    now += 5;
    await cache.wrapStaleOnError("k", async () => {
      throw new ApiError({ code: "server_error", message: "upstream down" });
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /stale/);
    assert.match(warnings[0]!, /"k"/);
  });

  test("records a stale fallback's age in the call's notes, and only then", async () => {
    let now = 0;
    const cache = new TtlCache({ ttlMs: 1, now: () => now });
    const fresh: CallNotes = {};
    await callNotes.run(fresh, () => cache.wrapStaleOnError("k", async () => 1));
    assert.equal(fresh.staleAgeMs, undefined, "a successful fresh compute is not stale");

    now += 5;
    const stale: CallNotes = {};
    const v = await callNotes.run(stale, () =>
      cache.wrapStaleOnError("k", async () => {
        throw new ApiError({ code: "server_error", message: "upstream down" });
      }),
    );
    assert.equal(v, 1);
    assert.equal(stale.staleAgeMs, 5); // ms since the value was fetched
  });

  // Two calls share one deduplicated fetch, but each keeps its own record:
  // the context, not a shared flag, decides who is told the data is stale.
  test("each concurrent caller's own notes are the ones written", async () => {
    let now = 0;
    const cache = new TtlCache({ ttlMs: 1, now: () => now });
    await cache.wrapStaleOnError("k", async () => 1);
    now += 5;
    let fail!: (err: Error) => void;
    const compute = () => new Promise<number>((_, reject) => (fail = reject));
    const a: CallNotes = {};
    const b: CallNotes = {};
    const pa = callNotes.run(a, () => cache.wrapStaleOnError("k", compute));
    const pb = callNotes.run(b, () => cache.wrapStaleOnError("k", compute));
    const pc = cache.wrapStaleOnError("k", compute); // outside any tool call
    fail(new ApiError({ code: "server_error", message: "upstream down" }));
    assert.deepEqual(await Promise.all([pa, pb, pc]), [1, 1, 1]);
    assert.equal(a.staleAgeMs, 5);
    assert.equal(b.staleAgeMs, 5);
  });

  // A degraded (partial) result is used but never cached; a complete stale
  // copy within the window wins over it.
  test("a degraded result is not cached, and a complete stale copy beats it", async () => {
    let now = 0;
    const cache = new TtlCache({ ttlMs: 1, now: () => now });
    assert.equal(await cache.wrapStaleOnError("k", async () => degraded("partial")), "partial");
    assert.equal(await cache.wrapStaleOnError("k", async () => "full"), "full", "not cached");
    now += 5;
    const record: CallNotes = {};
    const v = await callNotes.run(record, () =>
      cache.wrapStaleOnError("k", async () => degraded("partial")),
    );
    assert.equal(v, "full");
    assert.equal(record.staleAgeMs, 5);
  });

  // RFC 5861's stale-if-error is a window: past it, the failure surfaces.
  test("serves stale only within maxStaleMs past expiry", async () => {
    let now = 0;
    const cache = new TtlCache({ ttlMs: 10, maxStaleMs: 100, now: () => now });
    await cache.wrapStaleOnError("k", async () => 1);
    const fail = async () => {
      throw new ApiError({ code: "server_error", message: "upstream down" });
    };
    now = 110; // expired 100ms ago: still inside the window
    assert.equal(await cache.wrapStaleOnError("k", fail), 1);
    now = 111;
    await assert.rejects(() => cache.wrapStaleOnError("k", fail), /upstream down/);
  });

  test("wrapStaleOnError rethrows when nothing was ever cached", async () => {
    const cache = new TtlCache({ ttlMs: 60_000 });
    await assert.rejects(() =>
      cache.wrapStaleOnError("missing", async () => {
        throw new Error("boom");
      }),
    );
  });

  test("ttl <= 0 disables caching", async () => {
    const cache = new TtlCache({ ttlMs: 0 });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 1;
    };
    await cache.wrapStaleOnError("k", compute);
    await cache.wrapStaleOnError("k", compute);
    assert.equal(calls, 2);
  });

  test("wrapStaleOnError: concurrent calls on a cold key share one in-flight compute()", async () => {
    const cache = new TtlCache({ ttlMs: 60_000 });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      await tick(5);
      return 7;
    };
    // Two callers race on the same key before either resolves.
    const [a, b] = await Promise.all([
      cache.wrapStaleOnError("k", compute),
      cache.wrapStaleOnError("k", compute),
    ]);
    assert.equal(a, 7);
    assert.equal(b, 7);
    assert.equal(calls, 1); // only one real compute(), not two
    // A later, non-concurrent call still gets the (now cached) value without recomputing.
    assert.equal(await cache.wrapStaleOnError("k", compute), 7);
    assert.equal(calls, 1);
  });

  test("wrapStaleOnError: a failed in-flight compute() clears the slot so the next call retries", async () => {
    const cache = new TtlCache({ ttlMs: 60_000 });
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("boom");
    };
    await assert.rejects(() => cache.wrapStaleOnError("k", failing));
    await assert.rejects(() => cache.wrapStaleOnError("k", failing));
    assert.equal(calls, 2); // second call retried, not stuck on a resolved rejection
  });

  test("wrapStaleOnError: concurrent calls on a cold key share one in-flight compute()", async () => {
    const cache = new TtlCache({ ttlMs: 60_000 });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      await tick(5);
      return 9;
    };
    const [a, b] = await Promise.all([
      cache.wrapStaleOnError("k", compute),
      cache.wrapStaleOnError("k", compute),
    ]);
    assert.equal(a, 9);
    assert.equal(b, 9);
    assert.equal(calls, 1);
  });

  // Stale data may only stand in for an outage: a bug, a 404 or a rejected
  // key must surface, not be hidden behind yesterday's copy.
  test("serves stale only during an upstream outage", async () => {
    let now = 0;
    const cache = new TtlCache({ ttlMs: 1, now: () => now });
    await cache.wrapStaleOnError("k", async () => 1);
    now += 5;
    for (const err of [
      new TypeError("bug"),
      new ApiError({ code: "not_found", message: "gone" }),
      new ApiError({ code: "unauthorized", message: "bad key" }),
      new ApiError({ code: "unknown", message: "418" }),
    ]) {
      await assert.rejects(
        () =>
          cache.wrapStaleOnError("k", async () => {
            throw err;
          }),
        (e) => e === err,
      );
    }
    for (const outage of [
      new ApiError({ code: "network", message: "down" }),
      // OMDb's daily quota: not worth retrying now, yet still an outage.
      new ApiError({ code: "rate_limited", message: "quota", retryable: false }),
      // A proxy's HTML page instead of the API.
      new ApiError({ code: "bad_response", message: "html" }),
    ]) {
      assert.equal(
        await cache.wrapStaleOnError("k", async () => {
          throw outage;
        }),
        1,
        outage.message,
      );
    }
  });

  test("a clock stepped back makes an entry stale, not fresh for longer", async () => {
    let now = 10_000;
    const cache = new TtlCache({ ttlMs: 1_000, now: () => now });
    cache.set("k", 1);
    now -= 3_600_000;
    assert.equal(cache.get("k"), undefined);
  });

  test("a degraded compute's notes are dropped when a complete stale copy wins", async () => {
    let now = 0;
    const cache = new TtlCache({ ttlMs: 1, now: () => now });
    await cache.wrapStaleOnError("k", async () => "full");
    now += 5;
    const notes: CallNotes = {};
    const v = await callNotes.run(notes, () =>
      cache.wrapStaleOnError("k", async () => {
        callNotes.getStore()!.partial = true; // an inner part was partial
        return degraded("part");
      }),
    );
    assert.equal(v, "full");
    assert.equal(notes.partial, undefined);
    assert.equal(notes.staleAgeMs, 5);
  });

  // A shared compute that itself used stale data: every caller it serves is
  // told, and the result built from it is not cached as fresh.
  test("a compute built from stale input notes every caller and isn't cached", async () => {
    let now = 0;
    const inner = new TtlCache({ ttlMs: 1, now: () => now });
    const outer = new TtlCache({ ttlMs: 60_000, now: () => now });
    await inner.wrapStaleOnError("detail", async () => "d");
    now += 5;
    const down = async (): Promise<string> => {
      throw new ApiError({ code: "server_error", message: "down" });
    };
    let computes = 0;
    const compute = async () => {
      computes += 1;
      return `list from ${await inner.wrapStaleOnError("detail", down)}`;
    };
    const a: CallNotes = {};
    const b: CallNotes = {};
    const [va, vb] = await Promise.all([
      callNotes.run(a, () => outer.wrapStaleOnError("list", compute)),
      callNotes.run(b, () => outer.wrapStaleOnError("list", compute)),
    ]);
    assert.deepEqual([va, vb], ["list from d", "list from d"]);
    assert.equal(computes, 1, "deduplicated");
    assert.equal(a.staleAgeMs, 5);
    assert.equal(b.staleAgeMs, 5, "the second caller is told too");
    await outer.wrapStaleOnError("list", compute);
    assert.equal(computes, 2, "not cached as fresh");
  });

  test("a degraded result with no stale copy is noted as partial", async () => {
    const cache = new TtlCache({ ttlMs: 60_000 });
    const notes: CallNotes = {};
    const v = await callNotes.run(notes, () =>
      cache.wrapStaleOnError("k", async () => degraded(1)),
    );
    assert.equal(v, 1);
    assert.equal(notes.partial, true);
  });

  test("an entry past the stale window is dropped, not kept alive", async () => {
    let now = 0;
    const cache = new TtlCache({ ttlMs: 10, max: 2, maxStaleMs: 100, now: () => now });
    await cache.wrapStaleOnError("old", async () => "o");
    now = 200; // far past ttl + maxStale
    const down = async (): Promise<string> => {
      throw new ApiError({ code: "server_error", message: "down" });
    };
    await assert.rejects(() => cache.wrapStaleOnError("old", down));
    cache.set("x", 1);
    cache.set("y", 2); // with "old" dropped, both fit in max 2
    assert.equal(cache.get("x"), 1);
    assert.equal(cache.get("y"), 2);
  });

  test("set evicts the oldest entry once at max size, keeping the cache bounded", () => {
    const cache = new TtlCache({ ttlMs: 60_000, max: 2 }); // max 2 entries
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // should evict "a" (the oldest), not "b"
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), 2);
    assert.equal(cache.get("c"), 3);
  });

  test("set does not evict when overwriting an existing key at max size", () => {
    const cache = new TtlCache({ ttlMs: 60_000, max: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 99); // same key, size stays at 2 — must not evict "b"
    assert.equal(cache.get("a"), 99);
    assert.equal(cache.get("b"), 2);
  });

  test("evicts the least recently used entry, not the first inserted", () => {
    const cache = new TtlCache({ ttlMs: 60_000, max: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // a read makes "a" recent, leaving "b" the eviction candidate
    cache.set("c", 3);
    assert.equal(cache.get("a"), 1);
    assert.equal(cache.get("b"), undefined);
    cache.set("a", 10); // a rewrite makes "a" recent too
    cache.set("d", 4);
    assert.equal(cache.get("c"), undefined);
    assert.equal(cache.get("a"), 10);
  });

  test("wrapStaleOnError: concurrent failures each independently fall back to the same stale value", async () => {
    let now = 0;
    const cache = new TtlCache({ ttlMs: 1, now: () => now }); // 1ms TTL; `now` is the cache's clock
    await cache.wrapStaleOnError("k", async () => 5);
    now += 5;
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new ApiError({ code: "server_error", message: "upstream down" });
    };
    const [a, b] = await Promise.all([
      cache.wrapStaleOnError("k", failing),
      cache.wrapStaleOnError("k", failing),
    ]);
    assert.equal(a, 5);
    assert.equal(b, 5);
    assert.equal(calls, 1); // shared failure, not two independent upstream hits
  });
});
