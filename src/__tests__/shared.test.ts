import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../lib/errors.js";
import { READ_ONLY, requireConfigured } from "../tools/shared.js";

test("READ_ONLY marks tools as read-only and open-world", () => {
  assert.deepEqual(READ_ONLY, { readOnlyHint: true, openWorldHint: true });
});

test("requireConfigured short-circuits with the client's message and never calls fn", async () => {
  let called = false;
  const client = { configured: false, notConfiguredMessage: "not configured, set FOO" };
  const res = await requireConfigured(client, async () => {
    called = true;
    return {};
  });
  assert.equal(called, false);
  assert.equal(res.isError, true);
  assert.equal(res.content[0]!.text, "not configured, set FOO");
});

test("requireConfigured runs fn and wraps the result via jsonResult when configured", async () => {
  const client = { configured: true, notConfiguredMessage: "unused" };
  const res = await requireConfigured(client, async () => ({ a: 1 }));
  assert.equal(res.isError, undefined);
  assert.deepEqual(res.structuredContent, { a: 1 });
});

test("requireConfigured guards a thrown ApiError into an actionable error result", async () => {
  const client = { configured: true, notConfiguredMessage: "unused" };
  const res = await requireConfigured(client, async () => {
    throw new ApiError({ code: "not_found", message: "no such id" });
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /no matching resource|404/i);
});
