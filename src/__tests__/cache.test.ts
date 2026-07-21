import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TtlCache, cacheKey } from "../lib/cache.js";

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
  test("wrap caches and reuses the fresh value", async () => {
    const cache = new TtlCache(60_000);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 42;
    };
    assert.equal(await cache.wrap("k", compute), 42);
    assert.equal(await cache.wrap("k", compute), 42);
    assert.equal(calls, 1);
  });

  test("wrapStaleOnError serves the stale value when compute fails", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const cache = new TtlCache(1); // 1ms TTL → expires almost immediately
    await cache.wrapStaleOnError("k", async () => 1);
    t.mock.timers.tick(5);
    const v = await cache.wrapStaleOnError("k", async () => {
      throw new Error("upstream down");
    });
    assert.equal(v, 1);
  });

  test("wrapStaleOnError logs a warning when serving stale data", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const warnings: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    };
    const cache = new TtlCache(1, 500, logger);
    await cache.wrapStaleOnError("k", async () => 1);
    t.mock.timers.tick(5);
    await cache.wrapStaleOnError("k", async () => {
      throw new Error("upstream down");
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /stale/);
    assert.match(warnings[0]!, /"k"/);
  });

  test("wrapStaleOnError fires onStale only when actually falling back to stale data", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const cache = new TtlCache(1);
    let onStaleCalls = 0;
    const onStale = () => (onStaleCalls += 1);

    await cache.wrapStaleOnError("k", async () => 1, onStale);
    assert.equal(onStaleCalls, 0, "a successful fresh compute is not stale");

    t.mock.timers.tick(5);
    await cache.wrapStaleOnError(
      "k",
      async () => {
        throw new Error("upstream down");
      },
      onStale,
    );
    assert.equal(onStaleCalls, 1);
  });

  test("wrapStaleOnError rethrows when nothing was ever cached", async () => {
    const cache = new TtlCache(60_000);
    await assert.rejects(() =>
      cache.wrapStaleOnError("missing", async () => {
        throw new Error("boom");
      }),
    );
  });

  test("ttl <= 0 disables caching", async () => {
    const cache = new TtlCache(0);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 1;
    };
    await cache.wrap("k", compute);
    await cache.wrap("k", compute);
    assert.equal(calls, 2);
  });

  test("wrap: concurrent calls on a cold key share one in-flight compute()", async () => {
    const cache = new TtlCache(60_000);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      await tick(5);
      return 7;
    };
    // Two callers race on the same key before either resolves.
    const [a, b] = await Promise.all([cache.wrap("k", compute), cache.wrap("k", compute)]);
    assert.equal(a, 7);
    assert.equal(b, 7);
    assert.equal(calls, 1); // only one real compute(), not two
    // A later, non-concurrent call still gets the (now cached) value without recomputing.
    assert.equal(await cache.wrap("k", compute), 7);
    assert.equal(calls, 1);
  });

  test("wrap: a failed in-flight compute() clears the slot so the next call retries", async () => {
    const cache = new TtlCache(60_000);
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("boom");
    };
    await assert.rejects(() => cache.wrap("k", failing));
    await assert.rejects(() => cache.wrap("k", failing));
    assert.equal(calls, 2); // second call retried, not stuck on a resolved rejection
  });

  test("wrapStaleOnError: concurrent calls on a cold key share one in-flight compute()", async () => {
    const cache = new TtlCache(60_000);
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

  test("set evicts the oldest entry once at max size, keeping the cache bounded", () => {
    const cache = new TtlCache(60_000, 2); // max 2 entries
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // should evict "a" (the oldest), not "b"
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), 2);
    assert.equal(cache.get("c"), 3);
  });

  test("set does not evict when overwriting an existing key at max size", () => {
    const cache = new TtlCache(60_000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 99); // same key, size stays at 2 — must not evict "b"
    assert.equal(cache.get("a"), 99);
    assert.equal(cache.get("b"), 2);
  });

  test("wrapStaleOnError: concurrent failures each independently fall back to the same stale value", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const cache = new TtlCache(1); // 1ms TTL → expires almost immediately
    await cache.wrapStaleOnError("k", async () => 5);
    t.mock.timers.tick(5);
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("upstream down");
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
