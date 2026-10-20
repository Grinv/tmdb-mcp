import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TMDB_MAX_PAGE,
  detailMovie,
  detailPerson,
  detailTv,
  movieCard,
  page,
  parseSeasons,
  summarizeCollection,
  summarizeCredits,
  summarizeEpisode,
  summarizeFind,
  summarizePerson,
  summarizePersonCredits,
  ratingsNotFound,
  ratingsYearConflict,
  summarizeRatings,
  summarizeReview,
  summarizeSeason,
  summarizeTvCredits,
  summarizeVideos,
  summarizeWatchProviderMatches,
  summarizeWatchProviders,
  tvCard,
  type TmdbCredits,
  type TmdbMovie,
  type TmdbMultiItem,
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

  test("certification values TMDB pads with whitespace are trimmed", () => {
    // Mirrors real /movie/603 release_dates: GR's certification is "K-8 ".
    const movie: TmdbMovie = {
      id: 1,
      release_dates: {
        results: [
          { iso_3166_1: "GR", release_dates: [{ certification: "K-8 ", type: 3 }] },
          { iso_3166_1: "US", release_dates: [{ certification: " ", type: 3 }] }, // blank
        ],
      },
    };
    assert.deepEqual(detailMovie(movie, "GR").certifications, { GR: "K-8" });
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

  // Live /movie/1003598 (Avengers: Secret Wars, status "Planned"): TMDB's
  // "unknown" is a 0, not null/absent, for both the score and the runtime.
  test("an unrated, unreleased movie's 0 score and 0 runtime degrade to null", () => {
    const d = detailMovie(
      {
        id: 1003598,
        title: "Avengers: Secret Wars",
        release_date: "2027-12-15",
        runtime: 0,
        status: "Planned",
        vote_average: 0,
        vote_count: 0,
      } as TmdbMovie,
      "US",
    );
    assert.equal(d.vote_average, null);
    assert.equal(d.vote_count, 0);
    assert.equal(d.runtime_minutes, null);
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

describe("movieCard / tvCard", () => {
  // Partial dates fail z.iso.date() and .catch(null) to null, so a card must
  // take the detail's already-derived `year`, not re-derive it from the date.
  test("a year-only date keeps its year on both detail and card, for TV like movies", () => {
    const tv = detailTv({ id: 1, name: "X", first_air_date: "2008" }, "US");
    assert.equal(tv.first_air_date, null);
    assert.equal(tv.year, 2008);
    const tc = tvCard(tv);
    assert.ok(tc.found);
    assert.equal(tc.year, 2008);

    const mc = movieCard(detailMovie({ id: 1, title: "X", release_date: "2008" }, "US"));
    assert.ok(mc.found);
    assert.equal(mc.year, 2008);
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

describe("page", () => {
  test("total_pages is clamped to the 500 pages TMDB actually serves", () => {
    // Mirrors real /discover/movie: total_pages 1001, total_results 20001,
    // yet TMDB rejects page=501.
    const p = page({ page: 1, results: [], total_pages: 1001, total_results: 20001 }, (x) => x);
    assert.equal(p.total_pages, TMDB_MAX_PAGE);
    assert.equal(p.total_results, 20001);
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

  // Live /collection/90863 (Rush Hour): the announced 4th film has
  // release_date "", which used to sort before 1998.
  test("an undated (announced) part sorts last, not first", () => {
    const s = summarizeCollection({
      id: 90863,
      name: "Rush Hour Collection",
      parts: [
        { id: 2109, title: "Rush Hour", release_date: "1998-09-18" },
        { id: 1059776, title: "Rush Hour 4", release_date: "" },
        { id: 5174, title: "Rush Hour 3", release_date: "2007-08-08" },
        { id: 5175, title: "Rush Hour 2", release_date: "2001-08-03" },
      ] as TmdbMovie[],
    });
    const parts = s.parts as { id: number }[];
    assert.deepEqual(
      parts.map((p) => p.id),
      [2109, 5175, 5174, 1059776],
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

  test("provider names TMDB pads with whitespace are trimmed", () => {
    // Mirrors real /movie/603/watch/providers: US flatrate lists "VIX " with a trailing space.
    const s = summarizeWatchProviders(
      { results: { US: { flatrate: [{ provider_name: "VIX " }, { provider_name: " " }] } } },
      "US",
    );
    assert.equal(s.available, true);
    assert.deepEqual(s.streaming, ["VIX"]);
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
  // Live /person/2372/combined_credits (Ron Perlman): movie 1487 and tv 1487
  // are different titles — movie and TV ids are separate namespaces.
  test("a movie and a tv credit sharing a numeric id are both kept", () => {
    const s = summarizePersonCredits({
      cast: [
        {
          id: 1487,
          media_type: "movie",
          title: "Hellboy",
          character: "Hellboy",
          release_date: "2004-04-02",
          popularity: 9.7143,
        },
        {
          id: 1487,
          media_type: "tv",
          name: "Static Shock",
          character: "Heavyman / Koenig (voice)",
          first_air_date: "2000-09-23",
          popularity: 27.3873,
        },
      ],
      crew: [
        { id: 1487, media_type: "movie", title: "Hellboy", job: "Producer", popularity: 9.7 },
        { id: 1487, media_type: "tv", name: "Static Shock", job: "Producer", popularity: 27.4 },
      ],
    });
    assert.deepEqual(
      s.cast.map((x) => x.title),
      ["Static Shock", "Hellboy"],
    );
    assert.equal(s.crew.length, 2);
  });

  test("a 0 score from 0 votes degrades to null", () => {
    const s = summarizePersonCredits({
      cast: [{ id: 1, media_type: "movie", title: "Upcoming", vote_average: 0, vote_count: 0 }],
    });
    assert.equal(s.cast[0]!.vote_average, null);
  });

  test("sorted by popularity descending and capped at limit", () => {
    const s = summarizePersonCredits(
      {
        cast: [
          { id: 1, title: "Low", popularity: 1 },
          { id: 2, title: "High", popularity: 9 },
          { id: 3, title: "Mid", popularity: 5 },
        ],
      },
      undefined,
      2,
    );
    const cast = s.cast as { id: number }[];
    assert.deepEqual(
      cast.map((x) => x.id),
      [2, 3],
    );
  });

  test("self-appearance cast entries (talk-show guest spots) are excluded", () => {
    // A long-running talk show accrues a far higher entity-level `popularity`
    // than any single film, so without filtering this would outrank Movie Role.
    const s = summarizePersonCredits({
      cast: [
        { id: 1, title: "Late Show", character: "Self - Guest", popularity: 200 },
        { id: 2, title: "Self Storage", character: "Owner", popularity: 3 },
        { id: 3, title: "Movie Role", character: "Hero", popularity: 30 },
      ],
    });
    const cast = s.cast as { id: number; title?: string }[];
    assert.deepEqual(
      cast.map((x) => x.id),
      [3, 2],
    );
  });

  test("'Himself'/'Herself'-credited cast entries are excluded, same as 'Self'", () => {
    const s = summarizePersonCredits({
      cast: [
        { id: 1, title: "Late Night Show", character: "Himself", popularity: 200 },
        { id: 2, title: "Daytime Talk", character: "Herself", popularity: 150 },
        { id: 3, title: "Movie Role", character: "Hero", popularity: 30 },
      ],
    });
    const cast = s.cast as { id: number }[];
    assert.deepEqual(
      cast.map((x) => x.id),
      [3],
    );
  });

  test("talk/news-show TV credits are excluded even with an empty character", () => {
    // Mirrors real /person/2231/combined_credits rows: TMDB leaves
    // `character` empty on many talk-show guest spots, so only genre_ids
    // (10767 Talk, 10763 News) identifies them.
    const s = summarizePersonCredits({
      cast: [
        {
          id: 1,
          media_type: "tv",
          name: "LIVE with Kelly and Mark",
          character: "",
          genre_ids: [10767],
          popularity: 200,
        },
        {
          id: 2,
          media_type: "tv",
          name: "The Colbert Report",
          character: "",
          genre_ids: [10763, 35],
          popularity: 150,
        },
        {
          id: 3,
          media_type: "tv",
          name: "Law & Order",
          character: "Attorney Louis Taggert",
          genre_ids: [80, 18],
          popularity: 100,
        },
        {
          id: 4,
          media_type: "movie",
          title: "Avengers: Endgame",
          character: "Nick Fury",
          genre_ids: [12, 878, 28],
          popularity: 50,
        },
      ],
    });
    const cast = s.cast as { id: number }[];
    assert.deepEqual(
      cast.map((x) => x.id),
      [3, 4],
    );
  });

  test("repeat guest spots on the same title are deduped to one cast entry", () => {
    const s = summarizePersonCredits({
      cast: [
        { id: 1, title: "Kimmel", character: "Guest Star", popularity: 50 },
        { id: 1, title: "Kimmel", character: "Guest Host", popularity: 50 },
      ],
    });
    assert.equal(s.cast.length, 1);
  });

  test("crew entries are deduped by id+job, not id alone", () => {
    const s = summarizePersonCredits({
      crew: [
        { id: 1, title: "Movie", job: "Writer", popularity: 10 },
        { id: 1, title: "Movie", job: "Director", popularity: 10 },
      ],
    });
    assert.equal(s.crew.length, 2);
  });

  // Regression: a prolific writer-director-producer's own films used to get
  // pushed out of the crew cap entirely — each of their films could cost 2-4
  // slots (one per job), so 25 slots covered far fewer than 25 actual titles.
  test("a title with several crew jobs counts once against the crew cap, not once per job", () => {
    const s = summarizePersonCredits(
      {
        crew: [
          { id: 1, title: "Movie A", job: "Director", popularity: 10 },
          { id: 1, title: "Movie A", job: "Writer", popularity: 10 },
          { id: 1, title: "Movie A", job: "Producer", popularity: 10 },
          { id: 2, title: "Movie B", job: "Director", popularity: 5 },
          { id: 3, title: "Movie C", job: "Director", popularity: 1 },
        ],
      },
      undefined,
      2,
    );
    const crew = s.crew as { id: number }[];
    // Movie A's 3 jobs all count as one title slot, Movie B fills the second
    // slot — Movie C (a 3rd distinct title) is excluded even though the row
    // count so far (4) is under what a naive row-based limit would allow.
    assert.deepEqual(
      crew.map((c) => c.id),
      [1, 1, 1, 2],
    );
  });

  test("department restricts crew to that department before capping", () => {
    const s = summarizePersonCredits(
      {
        crew: [
          {
            id: 1,
            title: "Directed Film",
            job: "Director",
            department: "Directing",
            popularity: 10,
          },
          { id: 1, title: "Directed Film", job: "Writer", department: "Writing", popularity: 10 },
          { id: 2, title: "Written Only", job: "Writer", department: "Writing", popularity: 20 },
        ],
      },
      "Directing",
    );
    const crew = s.crew as { id: number; job: string | null }[];
    // "Written Only" has the higher popularity but isn't in Directing, so it's
    // excluded; "Directed Film"'s own Writer row is excluded too — only its
    // Director row survives.
    assert.equal(crew.length, 1);
    assert.equal(crew[0]!.id, 1);
    assert.equal(crew[0]!.job, "Director");
  });

  // Regression: department alone doesn't help an exceptionally prolific person
  // (e.g. a director with 50+ films) whose department-filtered credits still
  // exceed the default cap — limit has to be raised too.
  test("limit raises the cap past the 25 default for an exceptionally prolific department", () => {
    const crew = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      title: `Film ${i + 1}`,
      job: "Director",
      department: "Directing",
      popularity: 30 - i,
    }));
    const capped = summarizePersonCredits({ crew }, "Directing");
    assert.equal(capped.crew.length, 25); // default still applies without limit
    const raised = summarizePersonCredits({ crew }, "Directing", 30);
    assert.equal(raised.crew.length, 30); // every title now fits
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

  test("person_results rows get the same shape as search_people rows", () => {
    // Mirrors a live /find/nm0000206?external_source=imdb_id person_results
    // row (known_for trimmed to one entry, every key kept).
    const s = summarizeFind({
      movie_results: [],
      tv_results: [],
      person_results: [
        {
          adult: false,
          id: 6384,
          name: "Keanu Reeves",
          original_name: "Keanu Reeves",
          media_type: "person",
          popularity: 30.5,
          gender: 2,
          known_for_department: "Acting",
          profile_path: "/rRdru6REr9i3WIHv2mntpcgxnoY.jpg",
          known_for: [
            {
              adult: false,
              backdrop_path: "/backdrop.jpg",
              genre_ids: [28, 878],
              id: 603,
              media_type: "movie",
              original_language: "en",
              original_title: "The Matrix",
              overview: "Set in the 22nd century...",
              popularity: 20.1,
              poster_path: "/poster.jpg",
              release_date: "1999-03-31",
              softcore: false,
              title: "The Matrix",
              video: false,
              vote_average: 8.2,
              vote_count: 26000,
            },
          ],
        } as unknown as TmdbMultiItem,
      ],
    });
    assert.deepEqual(s.person_results, [
      {
        id: 6384,
        media_type: "person",
        name: "Keanu Reeves",
        known_for_department: "Acting",
        popularity: 30.5,
        profile_url: "https://image.tmdb.org/t/p/w500/rRdru6REr9i3WIHv2mntpcgxnoY.jpg",
        known_for: ["The Matrix"],
      },
    ]);
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
  // The season endpoint's episode rows carry no external_ids (verified live —
  // only the single-episode endpoint does), so this path must not grow an
  // imdb_id field on the strength of the episode shaper having one. If TMDB
  // ever starts sending it here, this failing test is the prompt to decide
  // deliberately rather than leak it into a 250-episode aggregate.
  test("episode rows stay id-less even if a raw row carries external_ids", () => {
    const s = summarizeSeason({
      episodes: [{ episode_number: 1, external_ids: { imdb_id: "tt2301451" } }],
    } as Parameters<typeof summarizeSeason>[0]);
    assert.ok(!("imdb_id" in s.episodes[0]!));
  });

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

  test("episodes list is capped but episode_count still reports the true total", () => {
    // "Specials" seasons on long-running shows can carry hundreds of bonus
    // clips; the episode list must stay bounded without under-reporting the count.
    const episodes = Array.from({ length: 300 }, (_, i) => ({ episode_number: i + 1 }));
    const s = summarizeSeason({ episodes }, 50);
    assert.equal(s.episode_count, 300);
    assert.equal(s.episodes.length, 50);
    assert.equal(s.episodes[0]!.episode_number, 1);
  });

  test("includeEpisodeOverview=false nulls out each episode's overview (season overview untouched)", () => {
    // get_tv's expand_episodes aggregates up to 250 episodes across seasons;
    // a per-episode overview repeated that many times dominates the payload
    // size, so that path opts out while get_tv_season (default) keeps it.
    const s = summarizeSeason(
      { overview: "Season overview", episodes: [{ overview: "Episode overview" }] },
      50,
      false,
    );
    assert.equal(s.overview, "Season overview");
    assert.equal(s.episodes[0]!.overview, null);
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

  test("external_ids.imdb_id becomes imdb_id + imdb_url", () => {
    const s = summarizeEpisode({ external_ids: { imdb_id: "tt2301451" } });
    assert.equal(s.imdb_id, "tt2301451");
    assert.equal(s.imdb_url, "https://www.imdb.com/title/tt2301451/");
  });

  test("a missing or null imdb_id leaves both fields null, not a broken URL", () => {
    for (const e of [{}, { external_ids: {} }, { external_ids: { imdb_id: null } }]) {
      const s = summarizeEpisode(e);
      assert.equal(s.imdb_id, null);
      assert.equal(s.imdb_url, null);
    }
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

  test("maps OMDb's generic 'Error getting data.' (unrecognized imdb_id) to a clearer reason", () => {
    const s = summarizeRatings({ Response: "False", Error: "Error getting data." });
    assert.deepEqual(s, { found: false, reason: "No OMDb match for this imdb_id/title" });
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

describe("summarizeRatings N/A handling", () => {
  test('every string field, title and year included, maps OMDb\'s "N/A" to null', () => {
    const s = summarizeRatings({
      Response: "True",
      imdbID: "N/A",
      Title: "N/A",
      Year: "N/A",
      Rated: "N/A",
      Runtime: "N/A",
      imdbRating: "N/A",
      imdbVotes: "N/A",
      Metascore: "N/A",
      Awards: "N/A",
      Ratings: [],
    });
    assert.deepEqual(s, {
      found: true,
      imdb_id: null,
      title: null,
      year: null,
      rated: null,
      runtime: null,
      imdb_rating: null,
      imdb_votes: null,
      metascore: null,
      rotten_tomatoes: null,
      awards: null,
      ratings: [],
    });
  });
});

describe("ratingsNotFound", () => {
  test("returns a schema-validated { found:false, reason }", () => {
    assert.deepEqual(ratingsNotFound("nope"), { found: false, reason: "nope" });
  });
});

describe("ratingsYearConflict", () => {
  test("a far year gap is a conflict (stale-imdb-id signal)", () => {
    // TMDB 2026 title vs OMDb's 1985 entry — the real repro shape.
    assert.equal(ratingsYearConflict("2026-01-01", "1985"), true);
  });

  test("an exact or near (<=2y) year match is not a conflict", () => {
    assert.equal(ratingsYearConflict("2008-01-20", "2008"), false);
    // Region-rollout skew: a year or two off is still the same work.
    assert.equal(ratingsYearConflict("1999-03-31", "2001"), false);
  });

  test("parses a 4-digit year out of an OMDb range like '2008–2013'", () => {
    assert.equal(ratingsYearConflict("2008-01-20", "2008–2013"), false);
    assert.equal(ratingsYearConflict("1990-01-01", "2008–2013"), true);
  });

  test("missing either year never conflicts (never drops a hit over missing data)", () => {
    assert.equal(ratingsYearConflict(null, "1999"), false);
    assert.equal(ratingsYearConflict("1999-01-01", null), false);
    assert.equal(ratingsYearConflict(undefined, undefined), false);
    assert.equal(ratingsYearConflict("", ""), false);
    assert.equal(ratingsYearConflict("1999-01-01", "N/A"), false);
  });
});

describe("summarizeWatchProviderMatches", () => {
  const provider = (id: number | undefined, name: string | undefined) => ({
    provider_id: id,
    provider_name: name,
    logo_path: "/logo.jpg",
    nameLower: (name ?? "").toLowerCase(),
  });

  test("filters case-insensitively, drops id-less/name-less rows, pages 20 at a time", () => {
    const providers = [
      ...Array.from({ length: 45 }, (_, i) => provider(i + 1, ` Netflix ${i + 1} `)),
      provider(100, "Hulu"),
      provider(undefined, "Netflix Orphan"),
      provider(101, ""),
    ];
    const p1 = summarizeWatchProviderMatches(providers, "  NETFLIX ");
    assert.equal(p1.total_results, 45);
    assert.equal(p1.total_pages, 3);
    assert.equal(p1.page, 1);
    assert.equal(p1.results.length, 20);
    assert.deepEqual(p1.results[0], {
      provider_id: 1,
      provider_name: "Netflix 1",
      logo_url: "https://image.tmdb.org/t/p/w500/logo.jpg",
    });

    const p3 = summarizeWatchProviderMatches(providers, "netflix", 3);
    assert.deepEqual(
      p3.results.map((r) => r.provider_id),
      [41, 42, 43, 44, 45],
    );
    // Past the end: empty page, totals unchanged.
    const p4 = summarizeWatchProviderMatches(providers, "netflix", 4);
    assert.deepEqual(p4.results, []);
    assert.equal(p4.total_results, 45);
  });

  test("no match still reports one (empty) page", () => {
    const r = summarizeWatchProviderMatches([provider(1, "Hulu")], "zzz");
    assert.deepEqual(r, { results: [], page: 1, total_pages: 1, total_results: 0 });
  });
});

describe("parseSeasons", () => {
  const base = {
    season_number: 1,
    name: "Season 1",
    air_date: "2008-01-20",
    overview: null,
    poster_url: null,
    episode_count: 1,
    episodes: [
      {
        episode_number: 1,
        name: "Pilot",
        air_date: "2008-01-20",
        runtime_minutes: 58,
        vote_average: 8.3,
        overview: null,
      },
    ],
  };

  test("accepts a valid seasons array and degrades a partial air_date to null", () => {
    const out = parseSeasons([{ ...base, air_date: "2008" }]);
    assert.equal(out[0]!.air_date, null);
    assert.equal(out[0]!.episodes[0]!.air_date, "2008-01-20");
  });

  test("throws on an unknown key, a missing required field, or a non-array (drift check)", () => {
    assert.throws(() => parseSeasons([{ ...base, skipped: true }]));
    const { episode_count: _omit, ...missing } = base;
    assert.throws(() => parseSeasons([missing]));
    assert.throws(() => parseSeasons("not an array"));
  });
});

describe("summarizeTvCredits", () => {
  // Mirrors a /tv/{id}/aggregate_credits crew row: one row per person and
  // department, each listing its jobs with their own episode counts.
  const crewRow = (
    id: number,
    department: string,
    jobs: { job: string; episode_count: number }[],
  ) => ({
    adult: false,
    gender: 2,
    id,
    known_for_department: department,
    name: `Person ${id}`,
    original_name: `Person ${id}`,
    popularity: 1,
    profile_path: null,
    jobs: jobs.map((j, i) => ({ credit_id: `c${id}-${i}`, ...j })),
    department,
    total_episode_count: jobs.reduce((n, j) => n + j.episode_count, 0),
  });

  test("caps each key crew job at 5 by episode count and drops non-key jobs", () => {
    const crew = [
      ...Array.from({ length: 8 }, (_, i) =>
        crewRow(i + 1, "Directing", [{ job: "Director", episode_count: i + 1 }]),
      ),
      crewRow(50, "Writing", [{ job: "Writer", episode_count: 3 }]),
      crewRow(50, "Directing", [{ job: "Director", episode_count: 20 }]),
      crewRow(60, "Lighting", [{ job: "Gaffer", episode_count: 60 }]),
    ];
    const c = summarizeTvCredits({ cast: [], crew });
    const directors = c.crew.filter((x) => x.job === "Director");
    assert.deepEqual(
      directors.map((x) => [x.id, x.episode_count]),
      [
        [50, 20],
        [8, 8],
        [7, 7],
        [6, 6],
        [5, 5],
      ],
    );
    assert.deepEqual(
      c.crew.filter((x) => x.job === "Writer").map((x) => x.id),
      [50],
    );
    assert.ok(!c.crew.some((x) => x.job === "Gaffer"));
    // Output follows TV_KEY_JOBS order: every Director before any Writer.
    assert.equal(c.crew[5]!.job, "Writer");
  });
});
