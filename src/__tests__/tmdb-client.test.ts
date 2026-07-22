import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TmdbClient, MAX_EXPANDED_EPISODES } from "../clients/tmdb.js";
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

describe("TmdbClient: getTv(expand_episodes) on a show with more than 20 seasons", () => {
  test("chunks append_to_response into batches of 20 instead of one unbounded request", async (t) => {
    // TMDB hard-caps append_to_response at 20 remote calls per request; a
    // single unbounded append for a 25-season show would be rejected outright.
    const seasons = Array.from({ length: 25 }, (_, i) => ({
      season_number: i + 1,
      name: `Season ${i + 1}`,
      episode_count: 10,
    }));
    const mock = mockFetch((url) => {
      // getTv's own base-detail request also carries an append_to_response
      // (external_ids,content_ratings) — only a season/... append is the bulk call.
      if (!url.includes("append_to_response=season")) {
        return jsonResponse({ id: 1, name: "Long Runner", seasons });
      }
      const requested = decodeURIComponent(/append_to_response=([^&]+)/.exec(url)![1]!).split(",");
      const body: Record<string, unknown> = {};
      for (const key of requested) {
        const n = Number(key.split("/")[1]);
        body[key] = { season_number: n, name: `Season ${n}`, episodes: [] };
      }
      return jsonResponse(body);
    });
    installFetch(t, mock);
    const s = await client().getTv(1, "US", undefined, true);
    const bulkCalls = mock.calls.filter((c) => c.url.includes("append_to_response=season"));
    assert.equal(bulkCalls.length, 2, "expected two chunked append_to_response requests");
    assert.equal(s.seasons_detail?.length, 25);
    assert.deepEqual(
      s.seasons_detail?.map((x) => x.season_number),
      seasons.map((x) => x.season_number),
    );
  });

  test(`caps the combined episode count across all seasons at ${MAX_EXPANDED_EPISODES}, even though each season is individually under its own 50-episode cap`, async (t) => {
    // 25 seasons x 30 episodes = 750 total episodes, each season well under
    // the per-season 50 cap on its own — only the aggregate needs capping.
    const EPISODES_PER_SEASON = 30;
    const seasons = Array.from({ length: 25 }, (_, i) => ({
      season_number: i + 1,
      name: `Season ${i + 1}`,
      episode_count: EPISODES_PER_SEASON,
    }));
    const mock = mockFetch((url) => {
      if (!url.includes("append_to_response=season")) {
        return jsonResponse({ id: 1, name: "Long Runner", seasons });
      }
      const requested = decodeURIComponent(/append_to_response=([^&]+)/.exec(url)![1]!).split(",");
      const body: Record<string, unknown> = {};
      for (const key of requested) {
        const n = Number(key.split("/")[1]);
        body[key] = {
          season_number: n,
          name: `Season ${n}`,
          episodes: Array.from({ length: EPISODES_PER_SEASON }, (_, i) => ({
            episode_number: i + 1,
          })),
        };
      }
      return jsonResponse(body);
    });
    installFetch(t, mock);
    const s = await client().getTv(1, "US", undefined, true);
    const seasonsDetail = s.seasons_detail!;
    const totalReturnedEpisodes = seasonsDetail.reduce((sum, x) => sum + x.episodes.length, 0);
    assert.ok(
      totalReturnedEpisodes <= MAX_EXPANDED_EPISODES,
      `expected <=${MAX_EXPANDED_EPISODES} episodes, got ${totalReturnedEpisodes}`,
    );
    // Every season still reports its true per-season count, capping notwithstanding.
    assert.ok(seasonsDetail.every((x) => x.episode_count === EPISODES_PER_SEASON));
    // Earlier seasons are kept in full before the budget runs out.
    assert.equal(seasonsDetail[0]!.episodes.length, EPISODES_PER_SEASON);
    // Some later season must have been truncated (25 * 30 = 750 > MAX_EXPANDED_EPISODES).
    assert.ok(seasonsDetail.some((x) => x.episodes.length < EPISODES_PER_SEASON));
  });
});

describe("TmdbClient: getSimilar filters out results sharing only the source's broadest genre", () => {
  test("keeps a candidate sharing every source genre, drops one sharing only one of two", async (t) => {
    const mock = mockFetch((url) => {
      if (url.includes("/movie/603/similar")) {
        return jsonResponse(
          pageOf([
            { id: 1, title: "Full overlap", genre_ids: [28, 18] },
            { id: 2, title: "Broad-genre-only overlap", genre_ids: [18] },
          ]),
        );
      }
      // The source title's own genres (Action 28 + Drama 18): two genres, so
      // minSharedGenres requires both, not just the broader "Drama" (18).
      return jsonResponse({
        id: 603,
        genres: [
          { id: 28, name: "Action" },
          { id: 18, name: "Drama" },
        ],
      });
    });
    installFetch(t, mock);
    const s = await client().getSimilar("movie", 603);
    assert.deepEqual(
      s.results.map((r) => r.id),
      [1],
    );
  });

  test("passes results through unfiltered when the source's own genres can't be fetched", async (t) => {
    const mock = mockFetch((url) => {
      if (url.includes("/movie/603/similar")) {
        return jsonResponse(pageOf([{ id: 1, title: "Anything", genre_ids: [999] }]));
      }
      return jsonResponse({}, { status: 500 }); // source genre lookup fails
    });
    installFetch(t, mock);
    const s = await client({ HTTP_RETRIES: "0" }).getSimilar("movie", 603);
    assert.deepEqual(
      s.results.map((r) => r.id),
      [1],
    );
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
