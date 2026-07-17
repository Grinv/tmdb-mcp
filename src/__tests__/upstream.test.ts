import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpstream } from "../lib/upstream.js";
import { silentLogger, jsonResponse, mockFetch, installFetch } from "./helpers.js";

function upstream(extra: Partial<Parameters<typeof createUpstream>[0]> = {}) {
  return createUpstream({
    baseUrl: "https://example.test/api",
    logger: silentLogger(),
    timeoutMs: 5000,
    retries: 0,
    minIntervalMs: 0,
    cacheTtlMs: 60_000,
    ...extra,
  });
}

test("createUpstream passes defaultHeaders through to every request", async (t) => {
  const mock = mockFetch(() => jsonResponse({ ok: true }));
  installFetch(t, mock);
  const { http } = upstream({ defaultHeaders: { Authorization: "Bearer secret" } });
  await http.getJson("thing");
  const headers = mock.calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer secret");
});

test("createUpstream works without defaultHeaders (OMDb-style client)", async (t) => {
  const mock = mockFetch(() => jsonResponse({ ok: true }));
  installFetch(t, mock);
  const { http } = upstream();
  const res = await http.getJson<{ ok: boolean }>("thing");
  assert.equal(res.ok, true);
});

test("createUpstream's cache stores and reuses values", async () => {
  const { cache } = upstream();
  let calls = 0;
  const compute = async () => {
    calls += 1;
    return { n: calls };
  };
  const first = await cache.wrap("key", compute);
  const second = await cache.wrap("key", compute);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
});

test("createUpstream gates requests through a rate limiter honoring minIntervalMs", async (t) => {
  const mock = mockFetch(() => jsonResponse({ ok: true }));
  installFetch(t, mock);
  const { http } = upstream({ minIntervalMs: 60 });
  const start = performance.now();
  await http.getJson("thing");
  await http.getJson("thing");
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 55, `second call should wait ~60ms for spacing, took ${elapsed}ms`);
});
