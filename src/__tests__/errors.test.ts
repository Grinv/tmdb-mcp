import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  classifyStatus,
  redact,
  isOutage,
  unlessOutage,
  type ApiErrorCode,
} from "../lib/errors.ts";

describe("classifyStatus", () => {
  test("maps HTTP codes to error codes", () => {
    assert.equal(classifyStatus(401), "unauthorized");
    assert.equal(classifyStatus(403), "forbidden");
    assert.equal(classifyStatus(404), "not_found");
    assert.equal(classifyStatus(405), "bad_request");
    assert.equal(classifyStatus(422), "bad_request");
    assert.equal(classifyStatus(429), "rate_limited");
    assert.equal(classifyStatus(503), "server_error");
    assert.equal(classifyStatus(400), "bad_request");
    // A status matching none of the known cases must not throw — "unknown".
    assert.equal(classifyStatus(418), "unknown");
    assert.equal(classifyStatus(408), "timeout");
  });
});

// Transience and outage are properties of the code (errors.ts's KIND),
// decided in one place, not by whichever construction site passes a flag.
describe("ApiError.retryable and isOutage", () => {
  // A Record, so adding an ApiErrorCode fails to compile until both are
  // stated here too.
  const expected: Record<ApiErrorCode, [transient: boolean, outage: boolean]> = {
    unauthorized: [false, false],
    forbidden: [false, false],
    not_found: [false, false],
    rate_limited: [true, true],
    server_error: [true, true],
    network: [true, true],
    timeout: [true, true],
    cancelled: [false, false],
    bad_request: [false, false],
    bad_response: [false, true],
    unknown: [false, false],
  };

  test("follow the code; an occurrence may override only retryable", () => {
    for (const [code, [transient, outage]] of Object.entries(expected) as [
      ApiErrorCode,
      [boolean, boolean],
    ][]) {
      const err = new ApiError({ code, message: "x" });
      assert.equal(err.retryable, transient, code);
      assert.equal(isOutage(err), outage, code);
    }
    // OMDb's daily quota: rate_limited, not retryable, still an outage.
    const quota = new ApiError({ code: "rate_limited", message: "x", retryable: false });
    assert.equal(quota.retryable, false);
    assert.equal(isOutage(quota), true);
    assert.equal(isOutage(new TypeError("bug")), false);
  });
});

describe("redact", () => {
  test("removes bearer tokens and credential params", () => {
    assert.equal(redact("Authorization: Bearer abc.def-123=="), "Authorization: Bearer ***");
    assert.match(redact("grant&refresh_token=SECRET&x=1"), /refresh_token=\*\*\*/);
    assert.ok(!redact("client_secret=zzz999").includes("zzz999"));
    assert.ok(!redact("access_token=TOK").includes("TOK"));
    // OMDb's key is sent as ?apikey=... (clients/omdb.ts) — a retried request's
    // full URL is logged at debug level (lib/http.ts), so this param must be
    // stripped too or OMDB_API_KEY leaks into stderr under LOG_LEVEL=debug.
    assert.ok(
      !redact("https://www.omdbapi.com/?apikey=SECRETKEY&i=tt0111161").includes("SECRETKEY"),
    );
  });
});

describe("unlessOutage", () => {
  test("tolerates an upstream outage, but never an authoritative failure or a bug", async () => {
    assert.equal(await unlessOutage(Promise.resolve(1)), 1);
    const outage = new ApiError({ code: "server_error", message: "x" });
    assert.equal(await unlessOutage(Promise.reject(outage)), undefined);
    const revoked = new ApiError({ code: "unauthorized", message: "x" });
    await assert.rejects(
      () => unlessOutage(Promise.reject(revoked)),
      (e) => e === revoked,
    );
    await assert.rejects(() => unlessOutage(Promise.reject(new TypeError("bug"))), TypeError);
  });
});
