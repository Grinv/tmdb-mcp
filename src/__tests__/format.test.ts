import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detailMovie,
  detailPerson,
  detailTv,
  summarizeCollection,
  summarizeCredits,
  summarizeEpisode,
  summarizeFind,
  summarizePersonCredits,
  summarizeRatings,
  summarizeReview,
  summarizeVideos,
  summarizeWatchProviders,
  type TmdbCredits,
  type TmdbMovie,
  type TmdbPerson,
  type TmdbTv,
} from "../format.js";

// Direct unit tests for shaping edge cases that are cheap to hit without any
// HTTP/MCP scaffolding, and that the tool-level tests don't happen to exercise.

test("detailPerson maps every TMDB gender code, including unknown ones, to a safe label", () => {
  const person = (gender: number | undefined): TmdbPerson => ({ id: 1, name: "X", gender });
  assert.equal(detailPerson(person(1)).gender, "female");
  assert.equal(detailPerson(person(2)).gender, "male");
  assert.equal(detailPerson(person(3)).gender, "non-binary");
  assert.equal(detailPerson(person(0)).gender, null); // 0 = "not specified" upstream
  assert.equal(detailPerson(person(undefined)).gender, null);
});

test("summarizeFind maps person_results, not just movie/tv", () => {
  const s = summarizeFind({
    movie_results: [],
    tv_results: [],
    person_results: [{ id: 6193, name: "Leonardo DiCaprio", known_for_department: "Acting" }],
  });
  const persons = s.person_results as { id: number; media_type: string; name: string }[];
  assert.equal(persons[0]!.id, 6193);
  assert.equal(persons[0]!.media_type, "person");
  assert.equal(persons[0]!.name, "Leonardo DiCaprio");
});

test("detailMovie: certification picks the first non-empty release_dates entry per country", () => {
  const movie: TmdbMovie = {
    id: 1,
    release_dates: {
      results: [
        {
          iso_3166_1: "US",
          release_dates: [
            { certification: "", type: 1 },
            { certification: "R", type: 3 },
          ],
        },
        { iso_3166_1: "GB", release_dates: [{ certification: "15", type: 3 }] },
        { iso_3166_1: "FR", release_dates: [{ certification: "", type: 3 }] }, // never non-empty
      ],
    },
  };
  const d = detailMovie(movie, "GB");
  assert.equal(d.certification, "15");
  assert.equal(d.certification_region, "GB");
  assert.deepEqual(d.certifications, { US: "R", GB: "15" }); // FR dropped: no non-empty cert
});

test("detailMovie: requesting a region with no certification data returns null, not throw", () => {
  const movie: TmdbMovie = { id: 1, release_dates: { results: [] } };
  assert.equal(detailMovie(movie, "JP").certification, null);
});

test("detailTv: certifications map one rating per country from content_ratings", () => {
  const tv: TmdbTv = {
    id: 1,
    content_ratings: {
      results: [
        { iso_3166_1: "US", rating: "TV-MA" },
        { iso_3166_1: "DE", rating: "16" },
        { iso_3166_1: "JP", rating: "" }, // blank rating dropped
      ],
    },
  };
  const d = detailTv(tv, "DE");
  assert.equal(d.certification, "16");
  assert.deepEqual(d.certifications, { US: "TV-MA", DE: "16" });
});

test("summarizeReview: clip() keeps text at exactly the limit intact, truncates past it", () => {
  const exact = summarizeReview({ content: "a".repeat(1500) });
  assert.equal((exact.content as string).length, 1500);
  assert.ok(!(exact.content as string).endsWith("…"));

  const over = summarizeReview({ content: "a".repeat(1501) });
  assert.equal(over.content, "a".repeat(1500) + "…");
});

test("summarizeReview: no content clips to null, not an empty string", () => {
  assert.equal(summarizeReview({}).content, null);
});

test("summarizeVideos: only YouTube entries with a key get a watch URL", () => {
  const s = summarizeVideos({
    results: [
      { name: "Trailer", site: "YouTube", key: "abc123", type: "Trailer" },
      { name: "Vimeo clip", site: "Vimeo", key: "xyz", type: "Clip" },
      { name: "Missing key", site: "YouTube", type: "Teaser" },
    ],
  });
  const results = s.results as { name: string; url: string | null }[];
  assert.equal(results[0]!.url, "https://www.youtube.com/watch?v=abc123");
  assert.equal(results[1]!.url, null);
  assert.equal(results[2]!.url, null);
});

test("summarizeCredits: cast is sorted by billing order and capped at castLimit", () => {
  const c: TmdbCredits = {
    cast: [
      { id: 3, name: "C", order: 2 },
      { id: 1, name: "A", order: 0 },
      { id: 2, name: "B", order: 1 },
    ],
  };
  const s = summarizeCredits(c, 2);
  const cast = s.cast as { id: number }[];
  assert.deepEqual(
    cast.map((x) => x.id),
    [1, 2],
  ); // sorted, then capped — C dropped
});

test("summarizeCredits: crew keeps only headline jobs, dropping the rest", () => {
  const c: TmdbCredits = {
    crew: [
      { id: 1, name: "Director", job: "Director", department: "Directing" },
      { id: 2, name: "Gaffer", job: "Gaffer", department: "Lighting" },
      { id: 3, name: "No job" },
    ],
  };
  const s = summarizeCredits(c);
  const crew = s.crew as { id: number }[];
  assert.deepEqual(
    crew.map((x) => x.id),
    [1],
  );
});

test("summarizePersonCredits: sorted by popularity descending and capped at limit", () => {
  const s = summarizePersonCredits(
    {
      cast: [
        { id: 1, title: "Low", popularity: 1 },
        { id: 2, title: "High", popularity: 9 },
        { id: 3, title: "Mid", popularity: 5 },
      ],
    },
    2,
  );
  const cast = s.cast as { id: number }[];
  assert.deepEqual(
    cast.map((x) => x.id),
    [2, 3],
  );
});

test("summarizeWatchProviders: returns the requested region's providers plus all available regions", () => {
  const s = summarizeWatchProviders(
    {
      results: {
        US: { flatrate: [{ provider_name: "Netflix" }], rent: [{ provider_name: "Apple TV" }] },
        GB: { flatrate: [{ provider_name: "Prime Video" }] },
      },
    },
    "US",
  );
  assert.equal(s.available, true);
  assert.deepEqual(s.streaming, ["Netflix"]);
  assert.deepEqual(s.rent, ["Apple TV"]);
  assert.deepEqual(s.available_regions, ["GB", "US"]); // sorted
});

test("summarizeWatchProviders: a region with no data reports unavailable, not an empty result", () => {
  const s = summarizeWatchProviders({ results: { US: { flatrate: [] } } }, "JP");
  assert.equal(s.available, false);
  assert.deepEqual(s.available_regions, ["US"]);
});

test("summarizeCollection: parts are ordered chronologically regardless of input order", () => {
  const s = summarizeCollection({
    id: 1,
    name: "Collection",
    parts: [
      { id: 3, release_date: "2008-07-18" },
      { id: 1, release_date: "2005-06-15" },
      { id: 2, release_date: "2012-07-20" },
    ] as TmdbMovie[],
  });
  const parts = s.parts as { id: number }[];
  assert.deepEqual(
    parts.map((p) => p.id),
    [1, 3, 2],
  );
});

test("summarizeEpisode: crew is limited to Director/Writer, guest stars capped at 15", () => {
  const guestStars = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `Guest ${i}` }));
  const s = summarizeEpisode({
    crew: [
      { id: 1, name: "Dir", job: "Director" },
      { id: 2, name: "Writer", job: "Writer" },
      { id: 3, name: "DoP", job: "Director of Photography" },
    ],
    guest_stars: guestStars,
  });
  const crew = s.crew as { id: number }[];
  assert.deepEqual(
    crew.map((x) => x.id),
    [1, 2],
  );
  assert.equal((s.guest_stars as unknown[]).length, 15);
});

test("summarizeRatings: strips OMDb's N/A sentinel to null and extracts the Rotten Tomatoes value", () => {
  const s = summarizeRatings({
    Response: "True",
    imdbRating: "8.7",
    Metascore: "N/A",
    Ratings: [
      { Source: "Internet Movie Database", Value: "8.7/10" },
      { Source: "Rotten Tomatoes", Value: "83%" },
    ],
  });
  assert.equal(s.imdb_rating, "8.7");
  assert.equal(s.metascore, null);
  assert.equal(s.rotten_tomatoes, "83%");
});

test("summarizeRatings: a not-found response degrades to found:false with OMDb's reason", () => {
  const s = summarizeRatings({ Response: "False", Error: "Movie not found!" });
  assert.deepEqual(s, { found: false, reason: "Movie not found!" });
});
