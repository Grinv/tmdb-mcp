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
  release_dates: {
    results: [
      { iso_3166_1: "US", release_dates: [{ certification: "R", type: 3 }] },
      { iso_3166_1: "GB", release_dates: [{ certification: "15", type: 3 }] },
    ],
  },
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
  content_ratings: {
    results: [
      { iso_3166_1: "US", rating: "TV-MA" },
      { iso_3166_1: "DE", rating: "16" },
    ],
  },
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

const WATCH_PROVIDERS = {
  id: 603,
  results: {
    US: {
      link: "https://www.themoviedb.org/movie/603/watch?locale=US",
      flatrate: [{ provider_id: 8, provider_name: "Netflix" }],
      rent: [{ provider_id: 2, provider_name: "Apple TV" }],
    },
    GB: { flatrate: [{ provider_id: 9, provider_name: "Prime Video" }] },
  },
};

const COMBINED_CREDITS = {
  cast: [
    {
      id: 603,
      media_type: "movie",
      title: "The Matrix",
      character: "Neo",
      release_date: "1999-03-30",
      popularity: 50,
      vote_average: 8.2,
    },
    {
      id: 1,
      media_type: "tv",
      name: "Some Show",
      character: "Himself",
      first_air_date: "2010-01-01",
      popularity: 10,
    },
  ],
  crew: [{ id: 2, media_type: "movie", title: "Producer Film", job: "Producer", popularity: 5 }],
};

const VIDEOS = {
  id: 603,
  results: [
    { name: "Trailer", key: "abc123", site: "YouTube", type: "Trailer", official: true },
    { name: "Vimeo clip", key: "xyz", site: "Vimeo", type: "Clip", official: false },
  ],
};

const FIND = {
  movie_results: [MOVIE_DETAIL],
  tv_results: [],
  person_results: [],
};

const SEASON = {
  id: 100,
  name: "Season 1",
  season_number: 1,
  air_date: "2008-01-20",
  overview: "First season.",
  episodes: [
    { episode_number: 1, name: "Pilot", air_date: "2008-01-20", runtime: 58, vote_average: 8.1 },
  ],
};

const EPISODE = {
  episode_number: 1,
  name: "Pilot",
  overview: "It begins.",
  air_date: "2008-01-20",
  runtime: 58,
  vote_average: 8.1,
  guest_stars: [{ id: 9, name: "Guest", character: "Stranger" }],
  crew: [{ id: 7, name: "Director Person", job: "Director" }],
};

/** Route a request to the right canned response based on its URL. Specific
 *  sub-resource routes must precede the /movie/{id} and /tv/{id} catch-alls. */
function router(url: string) {
  if (url.includes("/search/movie")) {
    return jsonResponse({ page: 1, total_pages: 1, total_results: 1, results: [MOVIE_DETAIL] });
  }
  if (url.includes("/search/tv")) {
    return jsonResponse({ page: 1, total_pages: 1, total_results: 1, results: [TV_DETAIL] });
  }
  if (url.includes("/discover/movie")) {
    return jsonResponse({ page: 1, total_pages: 1, total_results: 1, results: [MOVIE_DETAIL] });
  }
  if (url.includes("/discover/tv")) {
    return jsonResponse({ page: 1, total_pages: 1, total_results: 1, results: [TV_DETAIL] });
  }
  if (url.includes("/watch/providers")) return jsonResponse(WATCH_PROVIDERS);
  if (url.includes("/combined_credits")) return jsonResponse(COMBINED_CREDITS);
  if (url.includes("/videos")) return jsonResponse(VIDEOS);
  if (url.includes("/find/")) return jsonResponse(FIND);
  if (/\/season\/\d+\/episode\/\d+/.test(url)) return jsonResponse(EPISODE);
  if (/\/season\/\d+/.test(url)) return jsonResponse(SEASON);
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

test("get_movie returns the age certification for the requested region", async () => {
  const mock = mockFetch(router);
  const restore = installFetch(mock);
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "get_movie",
      arguments: { id: 603, region: "GB", include_ratings: false },
    });
    const s = res.structuredContent as {
      certification: string;
      certification_region: string;
      certifications: Record<string, string>;
    };
    assert.equal(s.certification, "15");
    assert.equal(s.certification_region, "GB");
    assert.equal(s.certifications.US, "R");
    const call = mock.calls.find((c) => /\/movie\/603/.test(c.url))!;
    assert.match(call.url, /append_to_response=release_dates/);
  } finally {
    restore();
    await close();
  }
});

test("get_tv returns the content rating (default US region)", async () => {
  const mock = mockFetch(router);
  const restore = installFetch(mock);
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "get_tv",
      arguments: { id: 1396, include_ratings: false },
    });
    const s = res.structuredContent as {
      certification: string;
      certifications: Record<string, string>;
    };
    assert.equal(s.certification, "TV-MA");
    assert.equal(s.certifications.DE, "16");
    const call = mock.calls.find((c) => /\/tv\/1396/.test(c.url))!;
    assert.match(call.url, /content_ratings/);
  } finally {
    restore();
    await close();
  }
});

test("discover_movies maps friendly filters to TMDB dotted query keys", async () => {
  const mock = mockFetch(router);
  const restore = installFetch(mock);
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "discover_movies",
      arguments: { with_genres: "878", year: 1999, min_rating: 7, min_votes: 100 },
    });
    const s = res.structuredContent as { results: { id: number }[] };
    assert.equal(s.results[0]!.id, 603);
    const call = mock.calls.find((c) => c.url.includes("/discover/movie"))!;
    assert.match(call.url, /vote_average\.gte=7/);
    assert.match(call.url, /vote_count\.gte=100/);
    assert.match(call.url, /primary_release_year=1999/);
    assert.match(call.url, /with_genres=878/);
  } finally {
    restore();
    await close();
  }
});

test("get_watch_providers returns providers for the requested region", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "get_watch_providers",
      arguments: { media_type: "movie", id: 603, region: "US" },
    });
    const s = res.structuredContent as {
      region: string;
      available: boolean;
      streaming: string[];
      rent: string[];
      available_regions: string[];
    };
    assert.equal(s.region, "US");
    assert.equal(s.available, true);
    assert.deepEqual(s.streaming, ["Netflix"]);
    assert.deepEqual(s.rent, ["Apple TV"]);
    assert.deepEqual(s.available_regions, ["GB", "US"]);
  } finally {
    restore();
    await close();
  }
});

test("get_watch_providers reports unavailable for a region with no data", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "get_watch_providers",
      arguments: { media_type: "movie", id: 603, region: "JP" },
    });
    const s = res.structuredContent as { available: boolean; available_regions: string[] };
    assert.equal(s.available, false);
    assert.ok(s.available_regions.includes("US"));
  } finally {
    restore();
    await close();
  }
});

test("get_person_credits returns cast/crew sorted by popularity, both media types", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({ name: "get_person_credits", arguments: { id: 6384 } });
    const s = res.structuredContent as {
      cast: { title: string; year: number; media_type: string }[];
    };
    // Higher-popularity movie credit should sort before the TV one.
    assert.equal(s.cast[0]!.title, "The Matrix");
    assert.equal(s.cast[0]!.year, 1999);
    assert.equal(s.cast[1]!.media_type, "tv");
    assert.equal(s.cast[1]!.year, 2010);
  } finally {
    restore();
    await close();
  }
});

test("get_videos keeps a YouTube watch URL and omits it for other sites", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "get_videos",
      arguments: { media_type: "movie", id: 603 },
    });
    const s = res.structuredContent as { results: { url: string | null }[] };
    assert.equal(s.results[0]!.url, "https://www.youtube.com/watch?v=abc123");
    assert.equal(s.results[1]!.url, null);
  } finally {
    restore();
    await close();
  }
});

test("find_by_imdb_id resolves to TMDB results", async () => {
  const mock = mockFetch(router);
  const restore = installFetch(mock);
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "find_by_imdb_id",
      arguments: { imdb_id: "tt0133093" },
    });
    const s = res.structuredContent as { movie_results: { id: number }[] };
    assert.equal(s.movie_results[0]!.id, 603);
    const call = mock.calls.find((c) => c.url.includes("/find/"))!;
    assert.match(call.url, /external_source=imdb_id/);
  } finally {
    restore();
    await close();
  }
});

test("get_tv_season returns the episode list", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "get_tv_season",
      arguments: { id: 1396, season_number: 1 },
    });
    const s = res.structuredContent as {
      season_number: number;
      episode_count: number;
      episodes: { name: string }[];
    };
    assert.equal(s.season_number, 1);
    assert.equal(s.episode_count, 1);
    assert.equal(s.episodes[0]!.name, "Pilot");
  } finally {
    restore();
    await close();
  }
});

test("get_tv_episode returns episode details with guest stars and crew", async () => {
  const restore = installFetch(mockFetch(router));
  const { client, close } = await connectServer(ENV);
  try {
    const res = await client.callTool({
      name: "get_tv_episode",
      arguments: { id: 1396, season_number: 1, episode_number: 1 },
    });
    const s = res.structuredContent as {
      season_number: number;
      guest_stars: { name: string }[];
      crew: { job: string }[];
    };
    assert.equal(s.season_number, 1);
    assert.equal(s.guest_stars[0]!.name, "Guest");
    assert.equal(s.crew[0]!.job, "Director");
  } finally {
    restore();
    await close();
  }
});
