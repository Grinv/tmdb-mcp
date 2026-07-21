import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../lib/logger.js";

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
    assert.match(lines[0]!, /unhandled rejection boom/); // Error → .message
    assert.match(lines[1]!, /"code":"E_FAIL"/); // plain object → JSON.stringify
    // JSON.stringify throws on a circular structure; must fall back to String(value)
    // instead of throwing and breaking the caller (server.ts's own error handler).
    assert.match(lines[2]!, /circular payload \[object Object\]/);
  });
});
