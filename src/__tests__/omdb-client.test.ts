import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OmdbClient } from "../clients/omdb.ts";
import { ApiError } from "../lib/errors.ts";
import { loadConfig } from "../config.ts";
import { silentLogger, installFetch, mockFetch, jsonResponse } from "./helpers.ts";

// Direct tests against OmdbClient's own interface, no MCP transport.

function client(): OmdbClient {
  return new OmdbClient(
    loadConfig({ OMDB_API_KEY: "k", OMDB_MIN_INTERVAL_MS: "0" }),
    silentLogger(),
  );
}

const OMDB_OK = { Response: "True", Title: "The Matrix", imdbID: "tt0133093" };

describe("OmdbClient: query params", () => {
  test("ratingsByImdbId sends the id as OMDb's `i` query param", async (t) => {
    const mock = mockFetch(() => jsonResponse(OMDB_OK));
    installFetch(t, mock);
    await client().ratingsByImdbId("tt0133093");
    assert.match(mock.calls[0]!.url, /[?&]i=tt0133093/);
  });

  test("ratingsByTitle sends `t` and, when given, `y`", async (t) => {
    const mock = mockFetch(() => jsonResponse(OMDB_OK));
    installFetch(t, mock);
    await client().ratingsByTitle("The Matrix", 1999);
    assert.match(mock.calls[0]!.url, /[?&]t=The\+Matrix/);
    assert.match(mock.calls[0]!.url, /[?&]y=1999/);
  });

  test("ratingsByTitle omits `y` entirely when no year is given", async (t) => {
    const mock = mockFetch(() => jsonResponse(OMDB_OK));
    installFetch(t, mock);
    await client().ratingsByTitle("The Matrix");
    assert.ok(!/[?&]y=/.test(mock.calls[0]!.url));
  });

  test("ratingsByTitle sends `type` when given, omits it otherwise", async (t) => {
    const mock = mockFetch(() => jsonResponse(OMDB_OK));
    installFetch(t, mock);
    await client().ratingsByTitle("Chuck", undefined, "movie");
    assert.match(mock.calls[0]!.url, /[?&]type=movie/);

    const mock2 = mockFetch(() => jsonResponse(OMDB_OK));
    installFetch(t, mock2);
    await client().ratingsByTitle("Chuck");
    assert.ok(!/[?&]type=/.test(mock2.calls[0]!.url));
  });
});

describe("OmdbClient: cache is wired through the real client, not just TtlCache in isolation", () => {
  test("ratingsByImdbId dedupes repeat lookups of the same id", async (t) => {
    const mock = mockFetch(() => jsonResponse(OMDB_OK));
    installFetch(t, mock);
    const c = client();
    await c.ratingsByImdbId("tt0133093");
    await c.ratingsByImdbId("tt0133093");
    assert.equal(mock.calls.length, 1);
  });

  test("ratingsByTitle does not conflate different years under the same cache slot", async (t) => {
    const mock = mockFetch(() => jsonResponse(OMDB_OK));
    installFetch(t, mock);
    const c = client();
    await c.ratingsByTitle("Dune", 1984);
    await c.ratingsByTitle("Dune", 2021);
    assert.equal(mock.calls.length, 2);
  });

  // Same title, different type, are genuinely different OMDb entries (e.g.
  // "Chuck" the 2007 series vs. "Chuck" the 2016 movie) — conflating them
  // under one cache slot would serve one type's rating for the other.
  test("ratingsByTitle does not conflate different types under the same cache slot", async (t) => {
    const mock = mockFetch(() => jsonResponse(OMDB_OK));
    installFetch(t, mock);
    const c = client();
    await c.ratingsByTitle("Chuck", undefined, "series");
    await c.ratingsByTitle("Chuck", undefined, "movie");
    assert.equal(mock.calls.length, 2);
  });
});

// OMDb reports failures in the body ({ Response: "False", Error }), a miss
// with a 200 OK (verified live: "Incorrect IMDb ID.", "Movie not found!").
describe("OmdbClient: body errors", () => {
  test("a miss stays a soft found:false", async (t) => {
    installFetch(
      t,
      mockFetch(() => jsonResponse({ Response: "False", Error: "Incorrect IMDb ID." })),
    );
    const r = await client().ratingsByImdbId("tt9999999999");
    assert.deepEqual(r, { found: false, reason: "Incorrect IMDb ID." });
  });

  test("a refusal in a 200 body throws with OMDb's reason and is never cached as a miss", async (t) => {
    let calls = 0;
    installFetch(
      t,
      mockFetch(() => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ Response: "False", Error: "Request limit reached!" })
          : jsonResponse(OMDB_OK);
      }),
    );
    const c = client();
    await assert.rejects(
      () => c.ratingsByImdbId("tt0133093"),
      (err: unknown) =>
        err instanceof ApiError &&
        err.code === "rate_limited" &&
        err.detail === "Request limit reached!",
    );
    // The next call reaches OMDb again instead of reading a cached "no ratings".
    assert.equal((await c.ratingsByImdbId("tt0133093")).found, true);
  });
});

describe("OmdbClient: HTTP-level refusals", () => {
  test("a quota message on an auth status is rate_limited, not a bad key", async (t) => {
    installFetch(
      t,
      mockFetch(() =>
        jsonResponse({ Response: "False", Error: "Request limit reached!" }, { status: 401 }),
      ),
    );
    await assert.rejects(
      () => client().ratingsByImdbId("tt0133093"),
      (err: unknown) =>
        err instanceof ApiError && err.code === "rate_limited" && err.status === 401,
    );
  });

  test("a bad key stays unauthorized and a 5xx keeps its own code", async (t) => {
    installFetch(
      t,
      mockFetch(() =>
        jsonResponse({ Response: "False", Error: "Invalid API key!" }, { status: 401 }),
      ),
    );
    await assert.rejects(
      () => client().ratingsByImdbId("tt0133093"),
      (err: unknown) => err instanceof ApiError && err.code === "unauthorized",
    );
    installFetch(
      t,
      mockFetch(() => jsonResponse({ error: "boom" }, { status: 500 })),
    );
    await assert.rejects(
      () =>
        new OmdbClient(
          loadConfig({ OMDB_API_KEY: "k", OMDB_MIN_INTERVAL_MS: "0", HTTP_RETRIES: "0" }),
          silentLogger(),
        ).ratingsByImdbId("tt1"),
      (err: unknown) => err instanceof ApiError && err.code === "server_error",
    );
  });

  test("an empty body is a classified error, not a TypeError", async (t) => {
    installFetch(
      t,
      mockFetch(() => new Response("", { status: 200 })),
    );
    await assert.rejects(
      () => client().ratingsByImdbId("tt0133093"),
      (err: unknown) => err instanceof ApiError && /empty response/.test(err.message),
    );
  });
});
