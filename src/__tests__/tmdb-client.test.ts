import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TmdbClient,
  MAX_EXPANDED_EPISODES,
  MAX_EXPANDED_EPISODES_CHARS,
  MAX_SEASON_EPISODES,
} from "../clients/tmdb.ts";
import { ApiError } from "../lib/errors.ts";
import { loadConfig } from "../config.ts";
import {
  silentLogger,
  installFetch,
  mockFetch,
  jsonResponse,
  pageOf,
  hangingFetch,
} from "./helpers.ts";

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

  test("charges season 0's specials only what they can contribute, not their true episode_count", async (t) => {
    // The Simpsons shape: season 0 "Specials" reports 200 episodes but can only
    // ever contribute MAX_SEASON_EPISODES (50). Charging the full 200 against
    // the 250 budget used to evict seasons 2-4 that comfortably fit.
    const SPECIALS_COUNT = 200;
    const seasons = [
      { season_number: 0, name: "Specials", episode_count: SPECIALS_COUNT },
      ...Array.from({ length: 4 }, (_, i) => ({
        season_number: i + 1,
        name: `Season ${i + 1}`,
        episode_count: MAX_SEASON_EPISODES,
      })),
    ];
    const requestedSeasonNumbers: number[] = [];
    const mock = mockFetch((url) => {
      if (!url.includes("append_to_response=season")) {
        return jsonResponse({ id: 1, name: "Long Runner", seasons });
      }
      const requested = decodeURIComponent(/append_to_response=([^&]+)/.exec(url)![1]!).split(",");
      const body: Record<string, unknown> = {};
      for (const key of requested) {
        const n = Number(key.split("/")[1]);
        requestedSeasonNumbers.push(n);
        const count = n === 0 ? SPECIALS_COUNT : MAX_SEASON_EPISODES;
        body[key] = {
          season_number: n,
          name: `S${n}`,
          episodes: Array.from({ length: count }, (_, i) => ({ episode_number: i + 1 })),
        };
      }
      return jsonResponse(body);
    });
    installFetch(t, mock);
    const s = await client().getTv(1, "US", undefined, true);
    // Every season fetched: 50 (capped specials) + 4 x 50 = exactly the budget.
    assert.deepEqual(
      requestedSeasonNumbers.sort((a, b) => a - b),
      [0, 1, 2, 3, 4],
    );
    const seasonsDetail = s.seasons_detail!;
    assert.equal(seasonsDetail.find((x) => x.season_number === 0)!.episodes.length, 50);
    for (const n of [1, 2, 3, 4]) {
      const season = seasonsDetail.find((x) => x.season_number === n)!;
      assert.equal(
        season.episodes.length,
        MAX_SEASON_EPISODES,
        `season ${n} should survive the budget in full`,
      );
    }
    const total = seasonsDetail.reduce((sum, x) => sum + x.episodes.length, 0);
    assert.equal(total, MAX_EXPANDED_EPISODES);
  });

  test("skips fetching seasons known (via episode_count) to fall entirely beyond the budget", async (t) => {
    // Same 25x30 show as above: seasons 1-9 cross the 250-episode budget, so
    // seasons 10-25 should never be requested over the network at all.
    const EPISODES_PER_SEASON = 30;
    const seasons = Array.from({ length: 25 }, (_, i) => ({
      season_number: i + 1,
      name: `Season ${i + 1}`,
      episode_count: EPISODES_PER_SEASON,
    }));
    const requestedSeasonNumbers: number[] = [];
    const mock = mockFetch((url) => {
      if (!url.includes("append_to_response=season")) {
        return jsonResponse({ id: 1, name: "Long Runner", seasons });
      }
      const requested = decodeURIComponent(/append_to_response=([^&]+)/.exec(url)![1]!).split(",");
      const body: Record<string, unknown> = {};
      for (const key of requested) {
        const n = Number(key.split("/")[1]);
        requestedSeasonNumbers.push(n);
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
    assert.deepEqual(
      requestedSeasonNumbers.sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    // Skipped seasons still appear in seasons_detail with their true
    // episode_count, but — unlike a season truncated AFTER being fetched,
    // which keeps its overview/poster_url — a skipped season was never
    // fetched at all, so overview/poster_url come back null too.
    const seasonsDetail = s.seasons_detail!;
    assert.equal(seasonsDetail.length, 25);
    const skippedSeason = seasonsDetail.find((x) => x.season_number === 20)!;
    assert.equal(skippedSeason.episode_count, EPISODES_PER_SEASON);
    assert.deepEqual(skippedSeason.episodes, []);
    assert.equal(skippedSeason.overview, null);
    assert.equal(skippedSeason.poster_url, null);
  });

  test("falls back to a byte-size cap when episode names are unusually verbose, even under the count cap", async (t) => {
    // A single season, well under MAX_EXPANDED_EPISODES (250) by count, but
    // with long enough episode names that the serialized aggregate would
    // still exceed the byte-size backstop if only count were enforced.
    const EPISODE_COUNT = 100;
    const LONG_NAME = "A".repeat(300);
    const seasons = [{ season_number: 1, name: "Season 1", episode_count: EPISODE_COUNT }];
    const mock = mockFetch((url) => {
      if (!url.includes("append_to_response=season")) {
        return jsonResponse({ id: 1, name: "Verbose Show", seasons });
      }
      return jsonResponse({
        "season/1": {
          season_number: 1,
          name: "Season 1",
          episodes: Array.from({ length: EPISODE_COUNT }, (_, i) => ({
            episode_number: i + 1,
            name: LONG_NAME,
          })),
        },
      });
    });
    installFetch(t, mock);
    const s = await client().getTv(1, "US", undefined, true);
    const seasonsDetail = s.seasons_detail!;
    assert.equal(seasonsDetail.length, 1);
    // All 100 episodes are well under the 250-episode count cap, but the
    // byte-size backstop must still trim them well short of 100.
    assert.ok(
      seasonsDetail[0]!.episodes.length < EPISODE_COUNT,
      `expected byte-size cap to trim below ${EPISODE_COUNT}, got ${seasonsDetail[0]!.episodes.length}`,
    );
    assert.ok(JSON.stringify(seasonsDetail).length <= MAX_EXPANDED_EPISODES_CHARS + 1000);
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

// A season object as /tv/{id}?append_to_response=season/N returns it under
// the "season/N" key (same shape as /tv/{id}/season/N): _id, air_date,
// episodes, name, overview, id, poster_path, season_number, vote_average.
function seasonBody(n: number, episodes: number): Record<string, unknown> {
  return {
    _id: `5256c8c219c2956ff604${n}`,
    air_date: "2008-01-20",
    episodes: Array.from({ length: episodes }, (_, i) => ({
      air_date: "2008-01-20",
      episode_number: i + 1,
      episode_type: "standard",
      id: n * 1000 + i,
      name: `Episode ${i + 1}`,
      overview: "",
      runtime: 45,
      season_number: n,
      show_id: 1,
      still_path: null,
      vote_average: 7.5,
      vote_count: 10,
    })),
    name: `Season ${n}`,
    overview: "",
    id: 3000 + n,
    poster_path: null,
    season_number: n,
    vote_average: 7.5,
  };
}

function requestedSeasons(url: string): number[] {
  return decodeURIComponent(/append_to_response=([^&]+)/.exec(url)![1]!)
    .split(",")
    .map((key) => Number(key.split("/")[1]));
}

describe("TmdbClient: getTv(expand_episodes) degrades per chunk, keeps season order", () => {
  test("one failed append_to_response chunk only empties its own seasons, not the whole call", async (t) => {
    // 25 seasons x 5 episodes = 125 (under budget): two chunks, 1-20 and 21-25
    // — the General Hospital / Top Gear shape. The second chunk fails.
    const seasons = Array.from({ length: 25 }, (_, i) => ({
      season_number: i + 1,
      name: `Season ${i + 1}`,
      episode_count: 5,
      air_date: "2008-01-20",
    }));
    let failSecondChunk = true;
    const mock = mockFetch((url) => {
      if (!url.includes("append_to_response=season")) {
        return jsonResponse({ id: 1, name: "Long Runner", seasons });
      }
      const requested = requestedSeasons(url);
      if (failSecondChunk && requested.includes(21)) {
        return jsonResponse(
          { status_code: 11, status_message: "Internal error." },
          { status: 500 },
        );
      }
      const body: Record<string, unknown> = { id: 1, name: "Long Runner", seasons };
      for (const n of requested) body[`season/${n}`] = seasonBody(n, 5);
      return jsonResponse(body);
    });
    installFetch(t, mock);
    const c = client({ HTTP_RETRIES: "0" });
    const s = await c.getTv(1, "US", undefined, true);
    const detail = s.seasons_detail!;
    assert.deepEqual(
      detail.map((x) => x.season_number),
      seasons.map((x) => x.season_number),
    );
    for (const x of detail.slice(0, 20)) assert.equal(x.episodes.length, 5);
    for (const x of detail.slice(20)) {
      assert.deepEqual(x.episodes, []);
      assert.equal(x.episode_count, 5); // from the show's own season metadata
      assert.equal(x.name, `Season ${x.season_number}`);
    }

    // The partial result must not be cached: once TMDB recovers, the next
    // call refetches and gets every season's episodes.
    failSecondChunk = false;
    const again = await c.getTv(1, "US", undefined, true);
    for (const x of again.seasons_detail!) assert.equal(x.episodes.length, 5);
  });

  test("rethrows when every chunk fails, so a stale cached value can still be served", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const seasons = [{ season_number: 1, name: "Season 1", episode_count: 3, air_date: null }];
    let failSeasons = false;
    const mock = mockFetch((url) => {
      if (!url.includes("append_to_response=season")) {
        return jsonResponse({ id: 1, name: "Show", seasons });
      }
      if (failSeasons) return jsonResponse({ status_code: 11 }, { status: 500 });
      return jsonResponse({ id: 1, name: "Show", seasons, "season/1": seasonBody(1, 3) });
    });
    installFetch(t, mock);
    const c = client({ HTTP_RETRIES: "0", CACHE_TTL_MS: "1" });
    await c.getTv(1, "US", undefined, true);
    t.mock.timers.tick(5);
    failSeasons = true;
    let stale = false;
    const s = await c.getTv(1, "US", undefined, true, () => (stale = true));
    assert.equal(stale, true, "all-chunks-failed must surface as an error, not cached skips");
    assert.equal(s.seasons_detail![0]!.episodes.length, 3);
  });

  test("skips a null-episode_count season once the budget is spent, and keeps the original order", async (t) => {
    // Seasons 1-5 x 50 exhaust the 250 budget; season 6 (known count) and
    // season 7 (null count) both fall beyond it. Season 7 used to be fetched
    // anyway and then listed before season 6.
    const seasons = [
      ...Array.from({ length: 5 }, (_, i) => ({
        season_number: i + 1,
        name: `Season ${i + 1}`,
        episode_count: MAX_SEASON_EPISODES as number | null,
      })),
      { season_number: 6, name: "Season 6", episode_count: 10 },
      { season_number: 7, name: "Season 7", episode_count: null },
    ];
    const fetched: number[] = [];
    const mock = mockFetch((url) => {
      if (!url.includes("append_to_response=season")) {
        return jsonResponse({ id: 1, name: "Show", seasons });
      }
      const body: Record<string, unknown> = { id: 1, name: "Show", seasons };
      for (const n of requestedSeasons(url)) {
        fetched.push(n);
        body[`season/${n}`] = seasonBody(n, MAX_SEASON_EPISODES);
      }
      return jsonResponse(body);
    });
    installFetch(t, mock);
    const s = await client().getTv(1, "US", undefined, true);
    assert.deepEqual(fetched, [1, 2, 3, 4, 5]);
    assert.deepEqual(
      s.seasons_detail!.map((x) => x.season_number),
      [1, 2, 3, 4, 5, 6, 7],
    );
  });

  test("a season missing from its chunk's response falls back to the show's own season metadata", async (t) => {
    const seasons = [
      { season_number: 1, name: "Season 1", episode_count: 3, air_date: "2008-01-20" },
      { season_number: 2, name: "Season 2", episode_count: 4, air_date: "2009-03-08" },
    ];
    const mock = mockFetch((url) => {
      if (!url.includes("append_to_response=season")) {
        return jsonResponse({ id: 1, name: "Show", seasons });
      }
      // TMDB omits an append key it couldn't resolve rather than erroring.
      return jsonResponse({ id: 1, name: "Show", seasons, "season/1": seasonBody(1, 3) });
    });
    installFetch(t, mock);
    const s = await client().getTv(1, "US", undefined, true);
    assert.deepEqual(s.seasons_detail![1], {
      season_number: 2,
      name: "Season 2",
      air_date: "2009-03-08",
      overview: null,
      poster_url: null,
      episode_count: 4,
      episodes: [],
    });
  });
});

describe("TmdbClient: region only reshapes cached data, never refetches", () => {
  // release_dates and /watch/providers carry every country; `region` only
  // picks which one is headlined, so a second region must not hit TMDB again.
  test("getMovie and getWatchProviders fetch once across two regions", async (t) => {
    const mock = mockFetch((url) => {
      if (url.includes("/watch/providers")) {
        return jsonResponse({
          id: 603,
          results: {
            US: { link: "https://www.themoviedb.org/movie/603/watch?locale=US", flatrate: [] },
            DE: { link: "https://www.themoviedb.org/movie/603/watch?locale=DE", flatrate: [] },
          },
        });
      }
      return jsonResponse({
        id: 603,
        title: "The Matrix",
        release_dates: {
          results: [
            { iso_3166_1: "US", release_dates: [{ certification: "R", type: 3 }] },
            { iso_3166_1: "DE", release_dates: [{ certification: "16", type: 3 }] },
          ],
        },
      });
    });
    installFetch(t, mock);
    const c = client();
    assert.equal((await c.getMovie(603, "US")).certification, "R");
    assert.equal((await c.getMovie(603, "DE")).certification, "16");
    await c.getWatchProviders("movie", 603, "US");
    await c.getWatchProviders("movie", 603, "DE");
    assert.equal(mock.calls.filter((x) => /\/movie\/603\?/.test(x.url)).length, 1);
    assert.equal(mock.calls.filter((x) => x.url.includes("/watch/providers")).length, 1);
  });
});
