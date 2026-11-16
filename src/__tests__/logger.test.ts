import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../lib/errors.ts";
import { createLogger } from "../lib/logger.ts";

function captureStderr<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    return { result: fn(), lines };
  } finally {
    console.error = original;
  }
}

describe("createLogger", () => {
  test("every level writes to stderr", () => {
    const { lines } = captureStderr(() => {
      const log = createLogger("debug");
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
    });
    assert.equal(lines.length, 4);
    assert.match(lines[0]!, /debug: d/);
    assert.match(lines[1]!, /info: i/);
    assert.match(lines[2]!, /warn: w/);
    assert.match(lines[3]!, /error: e/);
  });

  test("lines below the threshold are dropped", () => {
    const { lines } = captureStderr(() => {
      const log = createLogger("warn");
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
    });
    assert.equal(lines.length, 2);
  });

  test("silent level emits nothing", () => {
    const { lines } = captureStderr(() => {
      const log = createLogger("silent");
      log.error("e");
    });
    assert.equal(lines.length, 0);
  });

  test("messages are redacted before reaching stderr", () => {
    const { lines } = captureStderr(() => {
      const log = createLogger("info");
      log.info("calling https://api.example.test/x?access_token=supersecret&v=1");
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /access_token=\*\*\*/);
    assert.doesNotMatch(lines[0]!, /supersecret/);
  });

  test("extra Error/object/circular arguments are stringified safely (as used by server.ts's process handlers)", () => {
    const { lines } = captureStderr(() => {
      const log = createLogger("info");
      log.error("unhandled rejection", new Error("boom"));
      log.error("uncaught exception", { code: "E_FAIL", detail: "x" });
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      log.error("circular payload", circular);
    });
    assert.equal(lines.length, 3);
    // Error → its stack ("Error: boom" then frames): the diagnostics an
    // internal error only ever shows in the log.
    assert.match(lines[0]!, /unhandled rejection Error: boom\n\s+at /);
    assert.match(lines[1]!, /code: 'E_FAIL'/); // plain object → util.inspect
    // A circular structure must not throw and break the caller (server.ts's
    // own error handler).
    assert.match(lines[2]!, /circular payload <ref \*1> \{ a: 1, self: \[Circular \*1\] \}/);
  });

  test("a cause chain that loops back on itself is logged, not recursed forever", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    const { lines } = captureStderr(() => createLogger("info").error("loop", a));
    assert.match(lines[0]!, /Error: a[\s\S]*cause: Error: b[\s\S]*\[cause\]: \[Circular \*1\]/);
  });

  test("an Error's cause chain is logged and redacted", () => {
    const { lines } = captureStderr(() => {
      const log = createLogger("info");
      const root = new Error("socket hang up https://x.test/?apikey=supersecret");
      log.error("failed", new Error("Network error", { cause: root }));
    });
    assert.match(lines[0]!, /Error: Network error[\s\S]*\[cause\]: Error: socket hang up/);
    assert.doesNotMatch(lines[0]!, /supersecret/);
  });

  // What an outage log must carry: the classification (code, status) and
  // the system error's code deep in the cause chain, not just messages.
  test("an ApiError is logged with its code, status and the causes' codes", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED ::1:443"), {
      code: "ECONNREFUSED",
    });
    const agg = Object.assign(new AggregateError([refused], ""), { code: "ECONNREFUSED" });
    const err = new ApiError({
      code: "network",
      status: 502,
      message: "Network error",
      cause: new TypeError("fetch failed", { cause: agg }),
    });
    const { lines } = captureStderr(() => createLogger("info").warn("refresh failed", err));
    // Unminified "ApiError: …"; the minified bundle prints "i [ApiError]: …".
    assert.match(lines[0]!, /ApiError\]?: Network error\n\s+at /);
    assert.match(lines[0]!, /code: 'network'/);
    assert.match(lines[0]!, /status: 502/);
    assert.match(lines[0]!, /\[cause\]: TypeError: fetch failed/);
    assert.match(lines[0]!, /code: 'ECONNREFUSED'/);
  });

  test("a value whose own inspect throws is still logged, without throwing", () => {
    const hostile = {
      [Symbol.for("nodejs.util.inspect.custom")]() {
        throw new Error("inspect boom");
      },
    };
    const { lines } = captureStderr(() => createLogger("info").error("bad", hostile));
    assert.match(lines[0]!, /bad \[object Object\]/);
  });
});
