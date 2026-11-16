import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ApiError, type ApiErrorCode } from "../lib/errors.ts";
import { apiErrorToResult, errorResult, jsonResult } from "../lib/result.ts";

describe("jsonResult", () => {
  test("carries both text and structuredContent", () => {
    const r = jsonResult({ a: 1 });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.structuredContent, { a: 1 });
    assert.match(r.content[0]!.text, /"a":1/); // compact, no pretty-print whitespace
  });
});

describe("errorResult", () => {
  test("sets content and isError flag", () => {
    const e = errorResult("bad");
    assert.equal(e.isError, true);
    assert.equal(e.content[0]!.text, "bad");
  });
});

describe("apiErrorToResult", () => {
  test("produces an actionable message per error code", () => {
    const cases: [ApiErrorCode, RegExp][] = [
      ["unauthorized", /expired|credentials/i],
      ["forbidden", /denied access/i],
      ["not_found", /no matching resource|404/i],
      ["rate_limited", /rate-limiting/i],
      ["server_error", /5xx|retry later/i],
      ["network", /network/i],
      ["timeout", /timed out/i],
      ["bad_request", /invalid/i],
      ["unknown", /unexpected/i],
    ];
    for (const [code, re] of cases) {
      const r = apiErrorToResult(new ApiError({ code, message: "detail" }));
      assert.equal(r.isError, true);
      assert.match(r.content[0]!.text, re);
    }
  });

  test("keeps the upstream's own reason and the real status", () => {
    const r = apiErrorToResult(
      new ApiError({
        code: "unauthorized",
        status: 401,
        message: "HTTP 401",
        detail: "Request limit reached!",
      }),
    );
    assert.match(
      r.content[0]!.text,
      /credentials \(401\).*The upstream said: "Request limit reached!"/,
    );
  });

  test("names no status when the failure came without one", () => {
    const r = apiErrorToResult(new ApiError({ code: "rate_limited", message: "x" }));
    assert.doesNotMatch(r.content[0]!.text, /\(\d+\)/);
  });
});
