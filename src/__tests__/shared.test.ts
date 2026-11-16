import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../lib/errors.ts";
import { READ_ONLY, requireConfigured, STALE_META_KEY } from "../tools/shared.ts";
import { TtlCache } from "../lib/cache.ts";
import { PROBLEM_META_KEY } from "../lib/result.ts";
import { recordingLogger, silentLogger } from "./helpers.ts";

describe("READ_ONLY", () => {
  test("marks tools as read-only and open-world", () => {
    assert.deepEqual(READ_ONLY, { readOnlyHint: true, openWorldHint: true });
  });
});

describe("requireConfigured", () => {
  test("short-circuits with the client's message and never calls fn", async () => {
    let called = false;
    const client = {
      configured: false,
      notConfiguredMessage: "not configured, set FOO",
      logger: silentLogger(),
    };
    const res = await requireConfigured(client, async () => {
      called = true;
      return {};
    });
    assert.equal(called, false);
    assert.equal(res.isError, true);
    assert.equal(res.content[0]!.text, "not configured, set FOO");
  });

  test("runs fn and wraps the result via jsonResult when configured", async () => {
    const client = { configured: true, notConfiguredMessage: "unused", logger: silentLogger() };
    const res = await requireConfigured(client, async () => ({ a: 1 }));
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent, { a: 1 });
  });

  test("guards a thrown ApiError into an actionable error result", async () => {
    const client = { configured: true, notConfiguredMessage: "unused", logger: silentLogger() };
    const res = await requireConfigured(client, async () => {
      throw new ApiError({ code: "not_found", message: "no such id" });
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /no matching resource|404/i);
  });

  // A non-ApiError is a bug in this server: logged in full, never shown.
  test("turns a thrown plain Error into a logged internal error, not its message", async () => {
    const { logger, errors } = recordingLogger();
    const client = { configured: true, notConfiguredMessage: "unused", logger };
    const res = await requireConfigured(client, async () => {
      throw new Error("boom");
    });
    assert.equal(res.isError, true);
    assert.doesNotMatch(res.content[0]!.text, /boom/);
    assert.match(res.content[0]!.text, /^Internal error in tmdb-mcp\./);
    const problem = (res._meta as Record<string, { type: string }>)[PROBLEM_META_KEY]!;
    assert.match(problem.type, /#internal$/);
    assert.equal((errors[0]![1] as Error).message, "boom");
  });

  test("treats a non-Error throw value the same way", async () => {
    const { logger, errors } = recordingLogger();
    const client = { configured: true, notConfiguredMessage: "unused", logger };
    const res = await requireConfigured(client, async () => {
      throw "just a string";
    });
    assert.doesNotMatch(res.content[0]!.text, /just a string/);
    assert.equal(errors[0]![1], "just a string");
  });

  // fn() itself always eventually settles (via a real timer) rather than
  // hanging forever — it may be a cache-shared upstream fetch still wanted by
  // another concurrent caller, so it keeps running; only the OUTER call this
  // caller is awaiting should settle early. Each test waits out fn()'s own
  // timer before returning, so nothing is left dangling past the test itself.
  function delayedResolve(ms: number): Promise<Record<string, unknown>> {
    return new Promise((resolve) => setTimeout(() => resolve({}), ms));
  }

  test("resolves promptly with an error result when the signal is already aborted", async () => {
    const client = { configured: true, notConfiguredMessage: "unused", logger: silentLogger() };
    const controller = new AbortController();
    controller.abort();
    const res = await requireConfigured(
      client,
      () => delayedResolve(10),
      undefined,
      controller.signal,
    );
    assert.equal(res.isError, true);
    assert.equal(res.content[0]!.text, "The request was cancelled.");
    await delayedResolve(15); // let fn()'s own timer settle before returning
  });

  test("resolves promptly with an error result when the signal fires mid-flight, without waiting for fn", async () => {
    const client = { configured: true, notConfiguredMessage: "unused", logger: silentLogger() };
    const controller = new AbortController();
    const call = requireConfigured(client, () => delayedResolve(20), undefined, controller.signal);
    controller.abort();
    const result = await call;
    assert.equal(result.isError, true);
    assert.equal(result.content[0]!.text, "The request was cancelled.");
    await delayedResolve(25); // let fn()'s own timer settle before returning
  });

  test("a signal that never aborts doesn't change normal resolution", async () => {
    const client = { configured: true, notConfiguredMessage: "unused", logger: silentLogger() };
    const controller = new AbortController();
    const res = await requireConfigured(
      client,
      async () => ({ a: 1 }),
      undefined,
      controller.signal,
    );
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent, { a: 1 });
  });
});

// Stale/partial notes travel in the call's async context (lib/cache.ts's callNotes),
// so nothing between fn and the cache has to wire a callback through.
describe("requireConfigured: stale-cache signal", () => {
  test("a stale fallback anywhere inside fn surfaces as _meta with its age", async () => {
    let now = 0;
    const cache = new TtlCache({ ttlMs: 1, now: () => now });
    await cache.wrapStaleOnError("k", async () => ({ a: 1 }));
    now += 2500;
    const client = { configured: true, notConfiguredMessage: "unused", logger: silentLogger() };
    const res = await requireConfigured(client, () =>
      cache.wrapStaleOnError("k", async () => {
        throw new ApiError({ code: "server_error", message: "upstream down" });
      }),
    );
    assert.deepEqual(res.structuredContent, { a: 1 });
    assert.deepEqual(res._meta, { [STALE_META_KEY]: { age_seconds: 3 } });
  });

  test("omits _meta when nothing stale was served", async () => {
    const client = { configured: true, notConfiguredMessage: "unused", logger: silentLogger() };
    const res = await requireConfigured(client, async () => ({ a: 1 }));
    assert.equal(res._meta, undefined);
  });
});
