import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, type ApiErrorCode } from "../lib/errors.ts";
import {
  jsonResult,
  ownProblem,
  PROBLEM_CODES,
  problemResult,
  PROBLEM_META_KEY,
  toProblem,
} from "../lib/result.ts";
import { recordingLogger, silentLogger } from "./helpers.ts";

const TYPE_BASE = "https://github.com/Grinv/tmdb-mcp/blob/main/docs/errors.md#";

describe("jsonResult", () => {
  test("carries both text and structuredContent", () => {
    const r = jsonResult({ a: 1 });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.structuredContent, { a: 1 });
    assert.match(r.content[0]!.text, /"a":1/); // compact, no pretty-print whitespace
  });
});

describe("toProblem: ApiError", () => {
  test("produces an actionable detail and a stable type per error code", () => {
    const cases: [ApiErrorCode, RegExp][] = [
      ["unauthorized", /expired|credentials/i],
      ["forbidden", /denied access/i],
      ["not_found", /no matching resource/i],
      ["rate_limited", /rate-limiting/i],
      ["server_error", /retry later/i],
      ["network", /network/i],
      ["timeout", /timed out/i],
      ["cancelled", /cancelled/i],
      ["bad_request", /invalid/i],
      ["bad_response", /unreadable/i],
      ["unknown", /unexpected/i],
    ];
    for (const [code, re] of cases) {
      const p = toProblem(new ApiError({ code, message: "diagnostics only" }), silentLogger());
      assert.equal(p.type, TYPE_BASE + code);
      assert.match(p.detail, re);
      assert.doesNotMatch(p.detail, /diagnostics only/, `${code} leaked err.message`);
    }
  });

  test("keeps the upstream's own reason, its status and retryability", () => {
    const p = toProblem(
      new ApiError({
        code: "rate_limited",
        status: 429,
        retryable: true,
        message: "HTTP 429",
        detail: "Request limit reached!",
      }),
      silentLogger(),
    );
    assert.equal(p.title, "The upstream service is rate-limiting requests");
    assert.match(p.detail, /requests \(429\).*The upstream said: "Request limit reached!"/);
    assert.equal(p.upstream_status, 429);
    assert.equal(p.retryable, true);
    // RFC 9457's own `status` is this response's HTTP status — there is none.
    assert.equal("status" in p, false);
  });

  test("never shows an error's message, which may hold a raw response body", () => {
    const p = toProblem(
      new ApiError({ code: "bad_request", status: 405, message: "HTTP 405 : <html>oops.</html>" }),
      silentLogger(),
    );
    assert.equal(p.detail, "The request was rejected as invalid (405).");
  });

  test("names no status when the failure came without one", () => {
    const p = toProblem(new ApiError({ code: "rate_limited", message: "x" }), silentLogger());
    assert.doesNotMatch(p.detail, /\(\d+\)/);
    assert.equal("upstream_status" in p, false);
  });
});

describe("toProblem: anything else is an internal error", () => {
  test("is logged in full and replaced by a stable message", () => {
    const { logger, errors } = recordingLogger();
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
    const p = toProblem(bug, logger);
    assert.equal(p.type, TYPE_BASE + "internal");
    assert.equal(p.retryable, false);
    assert.doesNotMatch(p.detail, /Cannot read/);
    assert.match(p.detail, /server log/);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]![1], bug);
  });
});

describe("problemResult", () => {
  test("text is the detail; the Problem rides in _meta, not structuredContent", () => {
    const problem = ownProblem("not_configured", "TMDB is not configured. Set TMDB_API_TOKEN.");
    const r = problemResult(problem);
    assert.equal(r.isError, true);
    assert.equal(r.content[0]!.text, "TMDB is not configured. Set TMDB_API_TOKEN.");
    assert.equal(r.structuredContent, undefined);
    assert.deepEqual((r._meta as Record<string, unknown>)[PROBLEM_META_KEY], problem);
  });
});

// Each problem's `type` URI points at docs/errors.md#<code>; a code without a
// section there would publish a dead link.
test("docs/errors.md has a section for exactly every problem type", () => {
  const doc = readFileSync(join(import.meta.dirname, "../../docs/errors.md"), "utf8");
  const sections = [...doc.matchAll(/^## (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(sections.sort(), [...PROBLEM_CODES].sort());
});
