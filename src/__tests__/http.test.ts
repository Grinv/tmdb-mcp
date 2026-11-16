import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HttpClient, nullAsAbsent, type HttpClientOptions } from "../lib/http.ts";
import { ApiError } from "../lib/errors.ts";
import { silentLogger, jsonResponse, mockFetch, installFetch, hangingFetch } from "./helpers.ts";
import { USER_AGENT } from "../version.ts";

function client(
  extra: Partial<Pick<HttpClientOptions, "retries" | "timeoutMs" | "reviver">> = {},
): HttpClient {
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

describe("error mapping by status/body", () => {
  test("does not retry a 404 and maps it to not_found", async (t) => {
    const mock = mockFetch(() => jsonResponse({ error: "nope" }, { status: 404 }));
    installFetch(t, mock);
    await assert.rejects(
      () => client({ retries: 2 }).getJson("missing"),
      (err: unknown) => err instanceof ApiError && err.code === "not_found",
    );
    assert.equal(mock.calls.length, 1);
  });

  test("maps an invalid JSON body to an ApiError instead of throwing a raw SyntaxError", async (t) => {
    const mock = mockFetch(() => new Response("not actually json{{{", { status: 200 }));
    installFetch(t, mock);
    await assert.rejects(
      () => client({ retries: 0 }).getJson("thing"),
      (err: unknown) =>
        err instanceof ApiError && err.code === "bad_response" && /invalid JSON/i.test(err.message),
    );
  });

  // A complete body that isn't JSON (a proxy's HTML page) won't change on a
  // retry — a cut-off body rejects res.text() and is a network error instead.
  test("does not retry a complete but unreadable body", async (t) => {
    let calls = 0;
    installFetch(
      t,
      mockFetch(() => {
        calls += 1;
        return new Response("<html>maintenance</html>", { status: 200 });
      }),
    );
    await assert.rejects(
      () => client({ retries: 2 }).getJson("thing"),
      (err: unknown) => err instanceof ApiError && err.code === "bad_response" && !err.retryable,
    );
    assert.equal(calls, 1);
  });

  test("falls back to the raw body when a failing response isn't JSON", async (t) => {
    const mock = mockFetch(() => new Response("<html>Service Unavailable</html>", { status: 503 }));
    installFetch(t, mock);
    await assert.rejects(
      () => client({ retries: 0 }).getJson("thing"),
      (err: unknown) => err instanceof ApiError && /Service Unavailable/.test(err.message),
    );
  });

  test("caps a verbose structured error `message` at 500 chars in the tool-facing detail", async (t) => {
    const long = "x".repeat(1000);
    const mock = mockFetch(() => jsonResponse({ message: long }, { status: 400 }));
    installFetch(t, mock);
    await assert.rejects(
      () => client({ retries: 0 }).getJson("thing"),
      (err: unknown) =>
        err instanceof ApiError &&
        err.message.includes("x".repeat(500)) &&
        !err.message.includes("x".repeat(501)),
    );
  });

  test("reads the upstream's reason from TMDB's status_message and OMDb's Error", async (t) => {
    const bodies = [
      { status_code: 7, status_message: "Invalid API key: You must be granted a valid key." },
      { Response: "False", Error: "Invalid API key!" },
    ];
    for (const body of bodies) {
      const mock = mockFetch(() => jsonResponse(body, { status: 401 }));
      installFetch(t, mock);
      await assert.rejects(
        () => client({ retries: 0 }).getJson("thing"),
        (err: unknown) =>
          err instanceof ApiError && err.detail === (body.status_message ?? body.Error),
      );
    }
  });

  test("leaves detail unset for an unstructured body, so wire noise never reaches the agent", async (t) => {
    installFetch(
      t,
      mockFetch(() => new Response("<html>502</html>", { status: 502 })),
    );
    await assert.rejects(
      () => client({ retries: 0 }).getJson("thing"),
      (err: unknown) => err instanceof ApiError && err.detail === undefined,
    );
  });

  test("redacts a credential the upstream echoes back in an error body", async (t) => {
    const mock = mockFetch(() =>
      jsonResponse(
        { error: "invalid request: https://www.omdbapi.com/?apikey=SECRETKEY&i=tt0111161" },
        { status: 400 },
      ),
    );
    installFetch(t, mock);
    await assert.rejects(
      () => client({ retries: 0 }).getJson("thing"),
      (err: unknown) =>
        err instanceof ApiError &&
        err.code === "bad_request" &&
        !err.message.includes("SECRETKEY") &&
        err.message.includes("apikey=***"),
    );
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
});

describe("retries", () => {
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
});

describe("Retry-After handling", () => {
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
});

describe("empty body handling", () => {
  for (const body of ["null", "5", '"text"']) {
    test(`a non-object JSON body (${body}) is a bad_response`, async (t) => {
      installFetch(
        t,
        mockFetch(() => new Response(body, { status: 200 })),
      );
      await assert.rejects(
        () => client({ retries: 0, reviver: nullAsAbsent }).getJson("thing"),
        (err: unknown) => err instanceof ApiError && err.code === "bad_response",
      );
    });
  }

  test("a 204 is a bad_response: a JSON resource was expected", async (t) => {
    installFetch(
      t,
      mockFetch(() => new Response(null, { status: 204 })),
    );
    await assert.rejects(
      () => client({ retries: 0 }).getJson("thing"),
      (err: unknown) => err instanceof ApiError && err.code === "bad_response",
    );
  });

  // Both upstreams always send JSON on success, so an empty 200 body is an
  // unreadable response — classified here once, not passed on as undefined
  // for every shaper (or client) to trip over.
  test("a 200 with an empty body is a bad_response, not undefined", async (t) => {
    installFetch(
      t,
      mockFetch(() => new Response("", { status: 200 })),
    );
    await assert.rejects(
      () => client({ retries: 0 }).getJson("thing"),
      (err: unknown) => err instanceof ApiError && err.code === "bad_response",
    );
  });
});

describe("nullAsAbsent", () => {
  test("drops a null property, keeps nulls inside arrays (no holes)", () => {
    const parsed = JSON.parse('{"a":null,"b":1,"c":{"d":null},"e":[null,2]}', nullAsAbsent);
    assert.deepEqual(parsed, { b: 1, c: {}, e: [null, 2] });
    assert.equal("a" in parsed, false);
  });

  test("HttpClient applies a reviver only when one is configured", async (t) => {
    installFetch(
      t,
      mockFetch(() => jsonResponse({ poster_path: null })),
    );
    const plain = await client().getJson<Record<string, unknown>>("x");
    assert.deepEqual(plain, { poster_path: null });
    const revived = await new HttpClient({
      baseUrl: "https://example.test/api",
      logger: silentLogger(),
      reviver: nullAsAbsent,
    }).getJson<Record<string, unknown>>("x");
    assert.deepEqual(revived, {});
  });
});

describe("abort/timeout", () => {
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

  test("times out a body that stalls after the headers arrive", async (t) => {
    // Headers + a partial body, then silence. Like real fetch, aborting the
    // signal errors the body stream mid-read.
    const mock = mockFetch((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'));
          init?.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          );
        },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    });
    installFetch(t, mock);
    await assert.rejects(
      () => client({ retries: 0, timeoutMs: 30 }).getJson("stall"),
      (err: unknown) => err instanceof ApiError && err.code === "timeout",
    );
  });

  test("a cancel during a retry backoff ends the wait at once", async (t) => {
    installFetch(
      t,
      mockFetch(() => jsonResponse({ error: "down" }, { status: 503 })),
    );
    const controller = new AbortController();
    const started = performance.now();
    const call = client({ retries: 2 }).getJson("thing", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20); // inside the first 500ms backoff
    await assert.rejects(
      () => call,
      (err: unknown) => err instanceof ApiError && err.code === "cancelled",
    );
    assert.ok(performance.now() - started < 300, "should not sit out the 500ms backoff");
  });

  test("a caller-aborted request maps to a non-retryable abort error, not a timeout", async (t) => {
    const mock = hangingFetch();
    installFetch(t, mock);
    const controller = new AbortController();
    const call = client({ retries: 2 }).getJson("thing", { signal: controller.signal });
    controller.abort();
    await assert.rejects(
      () => call,
      (err: unknown) =>
        err instanceof ApiError && err.code === "cancelled" && err.retryable === false,
    );
    assert.equal(mock.calls.length, 1); // no retry after a caller cancellation
  });

  test("a signal already aborted before the call starts still cancels the request", async (t) => {
    const mock = hangingFetch();
    installFetch(t, mock);
    const controller = new AbortController();
    controller.abort(); // aborted before getJson is ever called
    await assert.rejects(
      () => client().getJson("thing", { signal: controller.signal }),
      (err: unknown) => err instanceof ApiError && err.code === "cancelled",
    );
  });
});
