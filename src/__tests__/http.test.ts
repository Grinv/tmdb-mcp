import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpClient } from "../lib/http.js";
import { ApiError } from "../lib/errors.js";
import { silentLogger, jsonResponse, mockFetch, installFetch } from "./helpers.js";
import { USER_AGENT } from "../version.js";

function client(extra: { retries?: number; timeoutMs?: number } = {}): HttpClient {
  return new HttpClient({ baseUrl: "https://example.test/api", logger: silentLogger(), ...extra });
}

test("getJson parses the body and sends a User-Agent + query params", async (t) => {
  const mock = mockFetch((_url) => jsonResponse({ ok: true }));
  installFetch(t, mock);
  const res = await client().getJson<{ ok: boolean }>("thing", {
    query: { q: "frieren", limit: 5, skip: undefined },
  });
  assert.equal(res.ok, true);
  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0]!;
  assert.match(call.url, /q=frieren/);
  assert.match(call.url, /limit=5/);
  assert.ok(!call.url.includes("skip")); // undefined dropped
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers["User-Agent"], USER_AGENT);
});

test("does not retry a 404 and maps it to not_found", async (t) => {
  const mock = mockFetch(() => jsonResponse({ error: "nope" }, { status: 404 }));
  installFetch(t, mock);
  await assert.rejects(
    () => client({ retries: 2 }).getJson("missing"),
    (err: unknown) => err instanceof ApiError && err.code === "not_found",
  );
  assert.equal(mock.calls.length, 1);
});

test("retries a 5xx then succeeds", async (t) => {
  let n = 0;
  const mock = mockFetch(() => {
    n += 1;
    return n === 1 ? jsonResponse({ e: 1 }, { status: 500 }) : jsonResponse({ ok: true });
  });
  installFetch(t, mock);
  const res = await client({ retries: 1 }).getJson<{ ok: boolean }>("flaky");
  assert.equal(res.ok, true);
  assert.equal(mock.calls.length, 2);
});

test("honors Retry-After on 429", async (t) => {
  let n = 0;
  const mock = mockFetch(() => {
    n += 1;
    return n === 1
      ? jsonResponse({}, { status: 429, headers: { "retry-after": "0" } })
      : jsonResponse({ ok: true });
  });
  installFetch(t, mock);
  const res = await client({ retries: 1 }).getJson<{ ok: boolean }>("limited");
  assert.equal(res.ok, true);
  assert.equal(mock.calls.length, 2);
});

test("maps an invalid JSON body to an ApiError instead of throwing a raw SyntaxError", async (t) => {
  const mock = mockFetch(() => new Response("not actually json{{{", { status: 200 }));
  installFetch(t, mock);
  await assert.rejects(
    () => client().getJson("thing"),
    (err: unknown) =>
      err instanceof ApiError && err.code === "unknown" && /invalid JSON/i.test(err.message),
  );
});

test("falls back to the raw body when a failing response isn't JSON", async (t) => {
  const mock = mockFetch(() => new Response("<html>Service Unavailable</html>", { status: 503 }));
  installFetch(t, mock);
  await assert.rejects(
    () => client({ retries: 0 }).getJson("thing"),
    (err: unknown) => err instanceof ApiError && /Service Unavailable/.test(err.message),
  );
});

test("retries a genuine network failure (fetch rejects, not just a bad status)", async (t) => {
  let n = 0;
  const mock = mockFetch(() => {
    n += 1;
    if (n === 1) throw new TypeError("fetch failed"); // e.g. DNS/connection refused
    return jsonResponse({ ok: true });
  });
  installFetch(t, mock);
  const res = await client({ retries: 1 }).getJson<{ ok: boolean }>("thing");
  assert.equal(res.ok, true);
  assert.equal(mock.calls.length, 2);
});

test("maps a persistent network failure to a network ApiError once retries are exhausted", async (t) => {
  const mock = mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  installFetch(t, mock);
  await assert.rejects(
    () => client({ retries: 1 }).getJson("thing"),
    (err: unknown) => err instanceof ApiError && err.code === "network" && err.retryable === true,
  );
  assert.equal(mock.calls.length, 2); // initial attempt + 1 retry, then give up
});

test("honors Retry-After as an HTTP-date, not just a plain seconds count", async (t) => {
  let n = 0;
  const mock = mockFetch(() => {
    n += 1;
    if (n === 1) {
      const soon = new Date(Date.now() + 10).toUTCString();
      return jsonResponse({}, { status: 429, headers: { "retry-after": soon } });
    }
    return jsonResponse({ ok: true });
  });
  installFetch(t, mock);
  const res = await client({ retries: 1 }).getJson<{ ok: boolean }>("thing");
  assert.equal(res.ok, true);
  assert.equal(mock.calls.length, 2);
});

test("falls back to the default backoff when Retry-After is neither a number nor a date", async (t) => {
  let n = 0;
  const mock = mockFetch(() => {
    n += 1;
    return n === 1
      ? jsonResponse({}, { status: 429, headers: { "retry-after": "not-a-valid-value" } })
      : jsonResponse({ ok: true });
  });
  installFetch(t, mock);
  const res = await client({ retries: 1 }).getJson<{ ok: boolean }>("thing");
  assert.equal(res.ok, true);
  assert.equal(mock.calls.length, 2); // still recovers, just via the default backoff
});

test("a 204 response resolves to undefined instead of throwing on empty body", async (t) => {
  const mock = mockFetch(() => new Response(null, { status: 204 }));
  installFetch(t, mock);
  const res = await client().getJson<{ ok: boolean } | undefined>("thing");
  assert.equal(res, undefined);
});

test("a 200 with an empty text body resolves to undefined, not a JSON-parse error", async (t) => {
  const mock = mockFetch(() => new Response("", { status: 200 }));
  installFetch(t, mock);
  const res = await client().getJson<{ ok: boolean } | undefined>("thing");
  assert.equal(res, undefined);
});

test("maps a persistent 5xx to a retryable server_error once retries are exhausted", async (t) => {
  const mock = mockFetch(() => jsonResponse({ error: "down" }, { status: 503 }));
  installFetch(t, mock);
  await assert.rejects(
    () => client({ retries: 1 }).getJson("thing"),
    (err: unknown) =>
      err instanceof ApiError && err.code === "server_error" && err.retryable === true,
  );
  assert.equal(mock.calls.length, 2); // initial attempt + 1 retry, then give up
});

test("maps a persistent 429 to a retryable rate_limited error once retries are exhausted", async (t) => {
  const mock = mockFetch(() => jsonResponse({}, { status: 429 }));
  installFetch(t, mock);
  await assert.rejects(
    () => client({ retries: 1 }).getJson("thing"),
    (err: unknown) =>
      err instanceof ApiError && err.code === "rate_limited" && err.retryable === true,
  );
  assert.equal(mock.calls.length, 2);
});

test("falls back to an empty detail when reading the error body itself throws", async (t) => {
  const fakeRes = {
    ok: false,
    status: 500,
    statusText: "Internal Server Error",
    headers: new Headers(),
    text: () => {
      throw new Error("stream already consumed");
    },
  } as unknown as Response;
  const mock = mockFetch(() => fakeRes);
  installFetch(t, mock);
  await assert.rejects(
    () => client({ retries: 0 }).getJson("thing"),
    (err: unknown) => err instanceof ApiError && err.message === "HTTP 500 Internal Server Error",
  );
});

test("aborts on timeout and maps to a timeout error", async (t) => {
  const mock = mockFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
  installFetch(t, mock);
  await assert.rejects(
    () => client({ retries: 0, timeoutMs: 30 }).getJson("slow"),
    (err: unknown) => err instanceof ApiError && err.code === "timeout",
  );
});
