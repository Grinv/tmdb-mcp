import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ApiError, classifyStatus, redact, type ApiErrorCode } from "../lib/errors.ts";

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
  });
});

// Transience is a property of the code (errors.ts's TRANSIENT), decided in
// one place — not by whichever construction site remembers to pass a flag.
describe("ApiError.retryable", () => {
  // A Record, so adding an ApiErrorCode fails to compile until its expected
  // transience is stated here too.
  const expected: Record<ApiErrorCode, boolean> = {
    unauthorized: false,
    forbidden: false,
    not_found: false,
    rate_limited: true,
    server_error: true,
    network: true,
    timeout: true,
    cancelled: false,
    bad_request: false,
    bad_response: false,
    unknown: false,
  };

  test("follows the code's transience unless an occurrence overrides it", () => {
    for (const [code, transient] of Object.entries(expected) as [ApiErrorCode, boolean][]) {
      assert.equal(new ApiError({ code, message: "x" }).retryable, transient, code);
    }
    // e.g. OMDb's daily quota: rate_limited, yet not transient.
    assert.equal(
      new ApiError({ code: "rate_limited", message: "x", retryable: false }).retryable,
      false,
    );
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
