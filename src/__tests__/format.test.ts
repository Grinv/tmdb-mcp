import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  detailMovie,
  detailPerson,
  detailTv,
  summarizeCollection,
  summarizeCredits,
  summarizeEpisode,
  summarizeFind,
  summarizePerson,
  summarizePersonCredits,
  summarizeRatings,
  summarizeReview,
  summarizeSeason,
  summarizeVideos,
  summarizeWatchProviders,
  type TmdbCredits,
  type TmdbMovie,
  type TmdbPerson,
  type TmdbTv,
} from "../format.js";

// Direct unit tests for shaping edge cases that are cheap to hit without any
// HTTP/MCP scaffolding, and that the tool-level tests don't happen to exercise.
// Grouped by shaper, in the same order as format.ts, to mirror that file.

describe("detailMovie", () => {
  test("certification picks the first non-empty release_dates entry per country", () => {
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

  test("requesting a region with no certification data returns null, not throw", () => {
    const movie: TmdbMovie = { id: 1, release_dates: { results: [] } };
    assert.equal(detailMovie(movie, "JP").certification, null);
  });

  test("falls back to US when the requested region has no certification", () => {
    const movie: TmdbMovie = {
      id: 1,
      release_dates: {
        results: [
          { iso_3166_1: "US", release_dates: [{ certification: "R", type: 3 }] },
          { iso_3166_1: "GB", release_dates: [{ certification: "15", type: 3 }] },
        ],
      },
    };
    const d = detailMovie(movie, "JP");
    assert.equal(d.certification, "R");
    assert.equal(d.certification_region, "US");
  });

  test("without a US rating, falls back to the alphabetically-first available region", () => {
    const movie: TmdbMovie = {
      id: 1,
      release_dates: {
        results: [
          { iso_3166_1: "FR", release_dates: [{ certification: "12", type: 3 }] },
          { iso_3166_1: "DE", release_dates: [{ certification: "16", type: 3 }] },
        ],
      },
    };
    const d = detailMovie(movie, "JP");
    assert.equal(d.certification, "16");
    assert.equal(d.certification_region, "DE");
  });

  // TMDB/OMDb occasionally send "" instead of omitting a string field or
  // sending null. `?? null` only catches null/undefined, not "" — every
  // string field below must use `|| null` so an upstream "" degrades the
  // same way a missing field would, instead of leaking "" into a field
  // typed `string | null`.
  test('an empty-string imdb_id/status/original_language degrades to null, not ""', () => {
    const d = detailMovie(
      { id: 1, imdb_id: "", status: "", original_language: "" } as TmdbMovie,
      "US",
    );
    assert.equal(d.imdb_id, null);
    assert.equal(d.status, null);
    assert.equal(d.original_language, null);
    assert.equal(d.imdb_url, null); // must agree with imdb_id, not treat "" as a real id
  });
});

describe("detailTv", () => {
  test("certifications map one rating per country from content_ratings", () => {
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

  test("falls back to US when the requested region has no content rating", () => {
    const tv: TmdbTv = {
      id: 1,
      content_ratings: {
        results: [
          { iso_3166_1: "US", rating: "TV-MA" },
          { iso_3166_1: "DE", rating: "16" },
        ],
      },
    };
    const d = detailTv(tv, "JP");
    assert.equal(d.certification, "TV-MA");
    assert.equal(d.certification_region, "US");
  });

  test('an empty-string imdb_id/type/status/original_language degrades to null, not ""', () => {
    const d = detailTv(
      {
        id: 1,
        type: "",
        status: "",
        original_language: "",
        external_ids: { imdb_id: "" },
      } as TmdbTv,
      "US",
    );
    assert.equal(d.imdb_id, null);
    assert.equal(d.type, null);
    assert.equal(d.status, null);
    assert.equal(d.original_language, null);
    assert.equal(d.imdb_url, null);
  });
});

describe("detailPerson", () => {
  test("maps every TMDB gender code, including unknown ones, to a safe label", () => {
    const person = (gender: number | undefined): TmdbPerson => ({ id: 1, name: "X", gender });
    assert.equal(detailPerson(person(1)).gender, "female");
    assert.equal(detailPerson(person(2)).gender, "male");
    assert.equal(detailPerson(person(3)).gender, "non-binary");
    assert.equal(detailPerson(person(0)).gender, null); // 0 = "not specified" upstream
    assert.equal(detailPerson(person(undefined)).gender, null);
  });

  test("empty-string imdb_id/known_for_department/birthday/deathday/place_of_birth degrade to null", () => {
    const d = detailPerson({
      id: 1,
      name: "X",
      imdb_id: "",
      known_for_department: "",
      birthday: "",
      deathday: "",
      place_of_birth: "",
    });
    assert.equal(d.imdb_id, null);
    assert.equal(d.known_for_department, null);
    assert.equal(d.birthday, null);
    assert.equal(d.deathday, null);
    assert.equal(d.place_of_birth, null);
    assert.equal(d.imdb_url, null);
  });
});

describe("summarizeCredits", () => {
  test("cast is sorted by billing order and capped at castLimit", () => {
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

  test("crew keeps only headline jobs, dropping the rest", () => {
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
});

describe("summarizePerson", () => {
  test("an empty-string known_for_department degrades to null", () => {
    const s = summarizePerson({ id: 1, media_type: "person", known_for_department: "" });
    assert.equal(s.known_for_department, null);
  });
});

describe("summarizeReview", () => {
  test("clip() keeps text at exactly the limit intact, truncates past it", () => {
    const exact = summarizeReview({ content: "a".repeat(1500) });
    assert.equal((exact.content as string).length, 1500);
    assert.ok(!(exact.content as string).endsWith("…"));

    const over = summarizeReview({ content: "a".repeat(1501) });
    assert.equal(over.content, "a".repeat(1500) + "…");
  });

  test("no content clips to null, not an empty string", () => {
    assert.equal(summarizeReview({}).content, null);
  });
});

describe("summarizeCollection", () => {
  test("parts are ordered chronologically regardless of input order", () => {
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
});

describe("summarizeWatchProviders", () => {
  test("returns the requested region's providers plus all available regions", () => {
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

  test("a region with no data reports unavailable, not an empty result", () => {
    const s = summarizeWatchProviders({ results: { US: { flatrate: [] } } }, "JP");
    assert.equal(s.available, false);
    assert.deepEqual(s.available_regions, ["US"]);
  });

  test("an empty-string link degrades to null", () => {
    const s = summarizeWatchProviders({ results: { US: { link: "", flatrate: [] } } }, "US");
    assert.ok(s.available);
    assert.equal(s.link, null);
  });
});

describe("summarizePersonCredits", () => {
  test("sorted by popularity descending and capped at limit", () => {
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
});

describe("summarizeVideos", () => {
  test("only YouTube entries with a key get a watch URL", () => {
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

  test("empty-string type/site/published_at degrade to null", () => {
    const s = summarizeVideos({ results: [{ name: "X", type: "", site: "", published_at: "" }] });
    const [v] = s.results as {
      type: string | null;
      site: string | null;
      published_at: string | null;
    }[];
    assert.equal(v!.type, null);
    assert.equal(v!.site, null);
    assert.equal(v!.published_at, null);
  });
});

describe("summarizeFind", () => {
  test("maps person_results, not just movie/tv", () => {
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

  test("an empty-string known_for_department in person_results degrades to null", () => {
    const s = summarizeFind({
      person_results: [{ id: 1, known_for_department: "" }],
    });
    const persons = s.person_results as { known_for_department: string | null }[];
    assert.equal(persons[0]!.known_for_department, null);
  });
});

describe("summarizeSeason", () => {
  test("empty-string name/air_date (season and episode level) degrade to null", () => {
    const s = summarizeSeason({
      name: "",
      air_date: "",
      episodes: [{ name: "", air_date: "" }],
    });
    assert.equal(s.name, null);
    assert.equal(s.air_date, null);
    const [ep] = s.episodes as { name: string | null; air_date: string | null }[];
    assert.equal(ep!.name, null);
    assert.equal(ep!.air_date, null);
  });
});

describe("summarizeEpisode", () => {
  test("crew is limited to Director/Writer, guest stars capped at 15", () => {
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

  test("empty-string name/air_date degrade to null", () => {
    const s = summarizeEpisode({ name: "", air_date: "" });
    assert.equal(s.name, null);
    assert.equal(s.air_date, null);
  });
});

describe("summarizeRatings", () => {
  test("strips OMDb's N/A sentinel to null and extracts the Rotten Tomatoes value", () => {
    const s = summarizeRatings({
      Response: "True",
      imdbRating: "8.7",
      Metascore: "N/A",
      Ratings: [
        { Source: "Internet Movie Database", Value: "8.7/10" },
        { Source: "Rotten Tomatoes", Value: "83%" },
      ],
    });
    assert.ok(s.found);
    assert.equal(s.imdb_rating, "8.7");
    assert.equal(s.metascore, null);
    assert.equal(s.rotten_tomatoes, "83%");
  });

  test("a not-found response degrades to found:false with OMDb's reason", () => {
    const s = summarizeRatings({ Response: "False", Error: "Movie not found!" });
    assert.deepEqual(s, { found: false, reason: "Movie not found!" });
  });

  test("empty-string imdb_id/title/year and Error degrade to null/the default reason", () => {
    const notFound = summarizeRatings({ Response: "False", Error: "" });
    assert.ok(!notFound.found);
    assert.equal(notFound.reason, "No OMDb match");

    const s = summarizeRatings({ Response: "True", imdbID: "", Title: "", Year: "" });
    assert.ok(s.found);
    assert.equal(s.imdb_id, null);
    assert.equal(s.title, null);
    assert.equal(s.year, null);
  });
});
