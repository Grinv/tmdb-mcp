import { test } from "node:test";
import assert from "node:assert/strict";
import { connectServer, installFetch, mockFetch, jsonResponse } from "./helpers.js";

// Credentials + zeroed throttling so tests run offline and fast.
const ENV = {
  TMDB_API_TOKEN: "test-token",
  OMDB_API_KEY: "test-key",
  TMDB_MIN_INTERVAL_MS: "0",
  OMDB_MIN_INTERVAL_MS: "0",
};

const MOVIE_DETAIL = {
  id: 603,
  imdb_id: "tt0133093",
  title: "The Matrix",
  original_title: "The Matrix",
  overview: "A hacker learns the truth.",
  release_date: "1999-03-30",
  runtime: 136,
  status: "Released",
  genres: [{ id: 28, name: "Action" }],
  vote_average: 8.2,
  vote_count: 25000,
};

const TV_DETAIL = {
  id: 1396,
  name: "Breaking Bad",
  overview: "A chemistry teacher turns to crime.",
  first_air_date: "2008-01-20",
  number_of_seasons: 5,
  genres: [{ id: 18, name: "Drama" }],
  vote_average: 8.9,
  external_ids: { imdb_id: "tt0903747" },
};

const OMDB_OK = {
  Response: "True",
  Title: "The Matrix",
  Year: "1999",
  Rated: "R",
  Runtime: "136 min",
  imdbRating: "8.7",
  imdbVotes: "2,000,000",
  imdbID: "tt0133093",
  Metascore: "73",
  Ratings: [
    { Source: "Internet Movie Database", Value: "8.7/10" },
    { Source: "Rotten Tomatoes", Value: "83%" },
    { Source: "Metacritic", Value: "73/100" },
  ],
};

/** Route a request to the right canned response based on its URL. */
function router(url: string) {
  if (url.includes("/search/movie")) {
    return jsonResponse({ page: 1, total_pages: 1, total_results: 1, results: [MOVIE_DETAIL] });
  }
  if (url.includes("/search/tv")) {
    return jsonResponse({ page: 1, total_pages: 1, total_results: 1, results: [TV_DETAIL] });
  }
  if (url.includes("omdbapi.com") || url.includes("/?apikey")) {
    return jsonResponse(OMDB_OK);
  }
  if (/\/tv\/\d+/.test(url)) return jsonResponse(TV_DETAIL);
  if (/\/movie\/\d+/.test(url)) return jsonResponse(MOVIE_DETAIL);
  return jsonResponse({});
}

test("the server advertises its tools", async () => {
  const { client, close } = await connectServer(ENV);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      "search_movies",
      "get_movie",
      "get_tv",
      "get_ratings",
      "get_trending",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
  } finally {
    await close();
  }
});

test("search_movies returns compact, structured results", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({ name: "search_movies", arguments: { query: "matrix" } });
    assert.notEqual(res.isError, true);
    const s = res.structuredContent as { results: { id: number; title: string; year: number }[] };
    assert.equal(s.results[0]!.id, 603);
    assert.equal(s.results[0]!.title, "The Matrix");
    assert.equal(s.results[0]!.year, 1999);
  } finally {
    restore();
    await close();
  }
});

test("get_movie folds in OMDb ratings by default", async () => {
  const mock = mockFetch(router);
  const restore = installFetch(mock);
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({ name: "get_movie", arguments: { id: 603 } });
    assert.notEqual(res.isError, true);
    const s = res.structuredContent as {
      imdb_id: string;
      ratings: { found: boolean; imdb_rating: string; rotten_tomatoes: string };
    };
    assert.equal(s.imdb_id, "tt0133093");
    assert.equal(s.ratings.found, true);
    assert.equal(s.ratings.imdb_rating, "8.7");
    assert.equal(s.ratings.rotten_tomatoes, "83%");
    // The enrichment must have actually hit OMDb.
    assert.ok(mock.calls.some((c) => c.url.includes("apikey")));
  } finally {
    restore();
    await close();
  }
});

test("get_movie with include_ratings=false skips the OMDb call", async () => {
  const mock = mockFetch(router);
  const restore = installFetch(mock);
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "get_movie",
      arguments: { id: 603, include_ratings: false },
    });
    const s = res.structuredContent as { ratings?: unknown };
    assert.equal(s.ratings, undefined);
    assert.ok(!mock.calls.some((c) => c.url.includes("apikey")), "should not call OMDb");
  } finally {
    restore();
    await close();
  }
});

test("get_tv appends external_ids and enriches via the resulting imdb_id", async () => {
  const mock = mockFetch(router);
  const restore = installFetch(mock);
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({ name: "get_tv", arguments: { id: 1396 } });
    const s = res.structuredContent as { imdb_id: string; ratings: { found: boolean } };
    assert.equal(s.imdb_id, "tt0903747");
    assert.equal(s.ratings.found, true);
    const tvCall = mock.calls.find((c) => /\/tv\/1396/.test(c.url));
    assert.ok(tvCall && tvCall.url.includes("append_to_response=external_ids"));
  } finally {
    restore();
    await close();
  }
});

test("get_ratings looks up ratings by imdb_id", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "get_ratings",
      arguments: { imdb_id: "tt0133093" },
    });
    const s = res.structuredContent as { found: boolean; metascore: string };
    assert.equal(s.found, true);
    assert.equal(s.metascore, "73");
  } finally {
    restore();
    await close();
  }
});

test("TMDB tools report a clear error when no token is configured", async () => {
  // No TMDB_API_TOKEN in env → short-circuit before any network call.
  const { client, close } = await connectServer({});
  try {
    const res = await client.callTool({ name: "search_movies", arguments: { query: "x" } });
    assert.equal(res.isError, true);
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    assert.match(text, /TMDB_API_TOKEN/);
  } finally {
    await close();
  }
});

test("get_movie degrades gracefully when OMDb is not configured", async () => {
  const restore = installFetch(mockFetch(router));
  // TMDB only — no OMDB_API_KEY.
  const { client, close } = await connectServer({ TMDB_API_TOKEN: "t", TMDB_MIN_INTERVAL_MS: "0" });
  try {
    const res = await client.callTool({ name: "get_movie", arguments: { id: 603 } });
    const s = res.structuredContent as { ratings: { found: boolean; reason: string } };
    assert.equal(s.ratings.found, false);
    assert.match(s.ratings.reason, /OMDB_API_KEY/);
  } finally {
    restore();
    await close();
  }
});
