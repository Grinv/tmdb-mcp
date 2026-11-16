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

  test("states the upstream's reason once, not again via err.message", () => {
    for (const code of ["bad_request", "unknown"] as const) {
      const text = apiErrorToResult(
        new ApiError({ code, status: 422, message: "HTTP 422 Unprocessable: X", detail: "X" }),
      ).content[0]!.text;
      assert.equal(text.split("X").length - 1, 1, text);
      assert.match(text, /\(422\)/, "the status stays when err.message is dropped");
    }
    // An HTTP error's message is the raw body: never shown, and no stray "..".
    const html = apiErrorToResult(
      new ApiError({ code: "bad_request", status: 405, message: "HTTP 405 : <html>oops.</html>" }),
    ).content[0]!.text;
    assert.equal(html, "The request was rejected as invalid (405).");
    // Without a status or detail, err.message is our own wording and stays.
    const bare = apiErrorToResult(
      new ApiError({ code: "unknown", message: "Upstream returned invalid JSON" }),
    );
    assert.match(bare.content[0]!.text, /invalid JSON/);
  });

  test("names no status when the failure came without one", () => {
    const r = apiErrorToResult(new ApiError({ code: "rate_limited", message: "x" }));
    assert.doesNotMatch(r.content[0]!.text, /\(\d+\)/);
  });
});
