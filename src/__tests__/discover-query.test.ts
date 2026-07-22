import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { discoverQuery, type DiscoverParams } from "../clients/tmdb.js";

// discoverQuery maps the friendly DiscoverParams the tool schema exposes to
// TMDB's actual (often dotted) query keys. A field silently dropped from this
// mapping means a filter the agent thinks it applied never reaches TMDB —
// these tests pin down the exact key each field becomes, per media kind.

const ALL_PARAMS: DiscoverParams = {
  sort_by: "popularity.desc",
  with_genres: "28",
  without_genres: "27",
  year: 1999,
  release_date_gte: "1999-01-01",
  release_date_lte: "1999-12-31",
  min_rating: 7,
  max_rating: 9,
  min_votes: 100,
  min_runtime: 90,
  max_runtime: 180,
  with_original_language: "en",
  with_cast: "6193",
  with_crew: "525",
  with_people: "6193",
  with_companies: "420",
  with_keywords: "9663",
  without_keywords: "1701",
  with_watch_providers: "8",
  watch_region: "US",
  with_networks: "49",
  with_type: "Miniseries",
  with_status: "Ended",
  certification: "PG-13",
  certification_country: "US",
  language: "en-US",
  page: 2,
};

describe("discoverQuery", () => {
  test("movie kind maps year/date range to primary_release_* keys", () => {
    const q = discoverQuery(ALL_PARAMS, "movie");
    assert.equal(q.primary_release_year, 1999);
    assert.equal(q["primary_release_date.gte"], "1999-01-01");
    assert.equal(q["primary_release_date.lte"], "1999-12-31");
    assert.equal(q.first_air_date_year, undefined);
  });

  test("tv kind maps year/date range to first_air_date_* keys", () => {
    const q = discoverQuery(ALL_PARAMS, "tv");
    assert.equal(q.first_air_date_year, 1999);
    assert.equal(q["first_air_date.gte"], "1999-01-01");
    assert.equal(q["first_air_date.lte"], "1999-12-31");
    assert.equal(q.primary_release_year, undefined);
  });

  test("rating/votes/runtime map to TMDB's dotted range keys for both kinds", () => {
    for (const kind of ["movie", "tv"] as const) {
      const q = discoverQuery(ALL_PARAMS, kind);
      assert.equal(q["vote_average.gte"], 7);
      assert.equal(q["vote_average.lte"], 9);
      assert.equal(q["vote_count.gte"], 100);
      assert.equal(q["with_runtime.gte"], 90);
      assert.equal(q["with_runtime.lte"], 180);
    }
  });

  test("movie-only filters (cast/crew/people) are dropped for tv", () => {
    const q = discoverQuery(ALL_PARAMS, "tv");
    assert.equal(q.with_cast, undefined);
    assert.equal(q.with_crew, undefined);
    assert.equal(q.with_people, undefined);
  });

  test("tv-only filters (with_networks/with_type/with_status) are dropped for movie", () => {
    const q = discoverQuery(ALL_PARAMS, "movie");
    assert.equal(q.with_networks, undefined);
    assert.equal(q.with_type, undefined);
    assert.equal(q.with_status, undefined);
  });

  // certification/certification_country work for both kinds — verified live
  // against the real /discover/tv, which TMDB's own docs don't advertise but
  // does actually honor (a nonsense certification value returns zero results).
  test("certification/certification_country pass through for both movie and tv", () => {
    for (const kind of ["movie", "tv"] as const) {
      const q = discoverQuery(ALL_PARAMS, kind);
      assert.equal(q.certification, "PG-13");
      assert.equal(q.certification_country, "US");
    }
  });

  test("movie-only filters pass through for movie, with_networks passes through for tv", () => {
    const movie = discoverQuery(ALL_PARAMS, "movie");
    assert.equal(movie.with_cast, "6193");

    const tv = discoverQuery(ALL_PARAMS, "tv");
    assert.equal(tv.with_networks, "49");
  });

  // TMDB's with_type/with_status take numeric codes; the schema's own field
  // (and this test's ALL_PARAMS) uses the human-readable name instead.
  test("tv's with_type/with_status translate the human-readable name to TMDB's numeric code", () => {
    const tv = discoverQuery(ALL_PARAMS, "tv");
    assert.equal(tv.with_type, 2); // Miniseries
    assert.equal(tv.with_status, 3); // Ended
  });

  test("shared filters and page pass through unchanged for both kinds", () => {
    for (const kind of ["movie", "tv"] as const) {
      const q = discoverQuery(ALL_PARAMS, kind);
      assert.equal(q.sort_by, "popularity.desc");
      assert.equal(q.with_genres, "28");
      assert.equal(q.without_genres, "27");
      assert.equal(q.with_original_language, "en");
      assert.equal(q.with_companies, "420");
      assert.equal(q.with_keywords, "9663");
      assert.equal(q.without_keywords, "1701");
      assert.equal(q.with_watch_providers, "8");
      assert.equal(q.watch_region, "US");
      assert.equal(q.page, 2);
    }
  });

  test("language is not part of the query (applied separately via #get)", () => {
    const q = discoverQuery(ALL_PARAMS, "movie");
    assert.equal(q.language, undefined);
  });
});
