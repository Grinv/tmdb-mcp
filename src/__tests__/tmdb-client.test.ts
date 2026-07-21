import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TmdbClient } from "../clients/tmdb.js";
import { ApiError } from "../lib/errors.js";
import { loadConfig } from "../config.js";
import {
  silentLogger,
  installFetch,
  mockFetch,
  jsonResponse,
  pageOf,
  hangingFetch,
} from "./helpers.js";

// Direct tests against TmdbClient's own interface — no MCP transport, no zod
// validation, no JSON-RPC round-trip. Covers behavior the tool-layer e2e tests
// don't happen to exercise precisely: which endpoint segment a method hits and
// how config-driven defaults resolve, without the cost of standing up a server.

function client(env: NodeJS.ProcessEnv = {}): TmdbClient {
  return new TmdbClient(
    loadConfig({ TMDB_API_TOKEN: "t", TMDB_MIN_INTERVAL_MS: "0", ...env }),
    silentLogger(),
  );
}

const EMPTY_PAGE = pageOf([]);

describe("TmdbClient: recommendations vs similar hit distinct endpoints", () => {
  test("getRecommendations uses the /recommendations segment", async (t) => {
    const mock = mockFetch(() => jsonResponse(EMPTY_PAGE));
    installFetch(t, mock);
    await client().getRecommendations("movie", 603);
    assert.ok(mock.calls.some((c) => c.url.includes("/movie/603/recommendations")));
  });

  test("getSimilar uses the /similar segment, not /recommendations", async (t) => {
    const mock = mockFetch(() => jsonResponse(EMPTY_PAGE));
    installFetch(t, mock);
    await client().getSimilar("tv", 1396);
    assert.ok(mock.calls.some((c) => c.url.includes("/tv/1396/similar")));
    assert.ok(!mock.calls.some((c) => c.url.includes("/recommendations")));
  });
});

describe("TmdbClient: discover dispatches to the right endpoint with the mapped query", () => {
  test("discover('movie', ...) hits discover/movie with the mapped filters", async (t) => {
    const mock = mockFetch(() => jsonResponse(EMPTY_PAGE));
    installFetch(t, mock);
    await client().discover("movie", { min_rating: 7, with_genres: "878" });
    const call = mock.calls.find((c) => c.url.includes("/discover/movie"));
    assert.ok(call, "expected a call to /discover/movie");
    assert.match(call!.url, /vote_average\.gte=7/);
    assert.match(call!.url, /with_genres=878/);
  });

  test("discover('tv', ...) hits discover/tv, not discover/movie", async (t) => {
    const mock = mockFetch(() => jsonResponse(EMPTY_PAGE));
    installFetch(t, mock);
    await client().discover("tv", { with_networks: "49" });
    assert.ok(mock.calls.some((c) => c.url.includes("/discover/tv")));
    assert.ok(!mock.calls.some((c) => c.url.includes("/discover/movie")));
  });
});

describe("TmdbClient: region/language resolve from config when not overridden per call", () => {
  test("getWatchProviders falls back to the configured TMDB_REGION default", async (t) => {
    const mock = mockFetch(() =>
      jsonResponse({ id: 603, results: { RU: { flatrate: [{ provider_name: "Kion" }] } } }),
    );
    installFetch(t, mock);
    const s = await client({ TMDB_REGION: "RU" }).getWatchProviders("movie", 603);
    assert.equal(s.region, "RU");
    assert.ok(s.available);
    assert.deepEqual(s.streaming, ["Kion"]);
  });

  test("searchMovies falls back to the configured TMDB_REGION for release-date bias", async (t) => {
    const mock = mockFetch(() => jsonResponse(EMPTY_PAGE));
    installFetch(t, mock);
    await client({ TMDB_REGION: "DE" }).searchMovies({ query: "matrix" });
    const call = mock.calls.find((c) => c.url.includes("/search/movie"))!;
    assert.match(call.url, /region=DE/);
  });
});

describe("TmdbClient: non-cached methods honor a caller AbortSignal", () => {
  // Aborting mid-flight is the only thing that can end a hangingFetch()
  // request. The caller's abort() may fire before the mock even sees the
  // request (searchMovies/discover suspend on an internal await first,
  // before reaching the actual fetch call) — hangingFetch's already-aborted
  // check (mirroring real fetch()) covers that ordering too.

  test("searchMovies aborts the underlying fetch when the signal fires mid-flight", async (t) => {
    let sawAbort = false;
    installFetch(t, hangingFetch({ onAbort: () => (sawAbort = true) }));
    const controller = new AbortController();
    const call = client().searchMovies({ query: "matrix" }, controller.signal);
    controller.abort();
    await assert.rejects(
      () => call,
      (err: unknown) => err instanceof ApiError && err.code === "network",
    );
    assert.equal(sawAbort, true);
  });

  test("discover aborts the underlying fetch when the signal fires mid-flight", async (t) => {
    let sawAbort = false;
    installFetch(t, hangingFetch({ onAbort: () => (sawAbort = true) }));
    const controller = new AbortController();
    const call = client().discover("movie", { min_rating: 7 }, controller.signal);
    controller.abort();
    await assert.rejects(() => call);
    assert.equal(sawAbort, true);
  });
});

describe("TmdbClient: getTv(expand_episodes) on a show with zero seasons", () => {
  test("skips the seasons-bulk request entirely and returns no seasons_detail", async (t) => {
    const mock = mockFetch(() => jsonResponse({ id: 1, name: "No Seasons Yet", seasons: [] }));
    installFetch(t, mock);
    const s = await client().getTv(1, "US", undefined, true);
    assert.equal(s.seasons_detail, undefined);
    // Only the base detail request — no append_to_response=season/... bulk call.
    assert.equal(mock.calls.length, 1);
  });
});

describe("TmdbClient: getReviews hits the right sub-resource per media type", () => {
  test("movie reviews vs tv reviews use distinct paths", async (t) => {
    const mock = mockFetch(() => jsonResponse(EMPTY_PAGE));
    installFetch(t, mock);
    const c = client();
    await c.getReviews("movie", 603);
    await c.getReviews("tv", 1396);
    assert.ok(mock.calls.some((call) => call.url.includes("/movie/603/reviews")));
    assert.ok(mock.calls.some((call) => call.url.includes("/tv/1396/reviews")));
  });
});
