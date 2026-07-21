import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  detailMovie,
  detailPerson,
  detailTv,
  page,
  summarizeCollection,
  summarizeCredits,
  summarizeEpisode,
  summarizeFind,
  summarizeGenres,
  summarizeKeywords,
  summarizeMovie,
  summarizeMultiItem,
  summarizePerson,
  summarizePersonCredits,
  summarizeRatings,
  summarizeReview,
  summarizeSeason,
  summarizeTv,
  summarizeVideos,
  summarizeWatchProviders,
  type TmdbMultiItem,
} from "../format.js";
import {
  movieOrTvSchema,
  movieSummarySchema,
  multiItemSchema,
  pageSchema,
} from "../format.schemas.js";

// Every shaper in format.ts is now schema-first: it builds its result and
// runs it through its own paired schema via `.parse()` before returning, so a
// shaper/schema mismatch throws right there — these tests just need to prove
// that doesn't happen for the most DEGENERATE input the raw TMDB/OMDb type
// allows (every optional field absent), the shape most likely to expose a
// wrong `.optional()` vs `.nullable()` call and the one the tool-level tests'
// realistic mocked fixtures don't happen to exercise. Grouped in format.ts's
// order.
//
// Three compositions aren't validated inside any single shaper — pageSchema,
// movieOrTvSchema and multiItemSchema are only ever applied at the tool
// registration site in tools/tmdb.ts — so those still get an explicit
// `.parse()` here.

describe("movieSummarySchema / movieDetailSchema", () => {
  test("summarizeMovie's output on a bare-minimum movie does not throw", () => {
    assert.doesNotThrow(() => summarizeMovie({ id: 1 }));
  });

  test("detailMovie's output on a bare-minimum movie does not throw", () => {
    assert.doesNotThrow(() => detailMovie({ id: 1 }, "US"));
  });

  test("detailMovie's output with every optional field populated (incl. a collection) does not throw", () => {
    assert.doesNotThrow(() =>
      detailMovie(
        {
          id: 1,
          imdb_id: "tt1",
          title: "T",
          original_title: "OT",
          overview: "o",
          tagline: "tag",
          release_date: "1999-01-01",
          runtime: 100,
          status: "Released",
          genres: [{ id: 1, name: "Action" }],
          vote_average: 7,
          vote_count: 100,
          popularity: 1,
          original_language: "en",
          spoken_languages: [{ english_name: "English" }],
          production_companies: [{ name: "Studio" }],
          budget: 100,
          revenue: 200,
          homepage: "https://x.test",
          poster_path: "/p.jpg",
          origin_country: ["US"],
          belongs_to_collection: { id: 9, name: "Saga", poster_path: "/c.jpg" },
        },
        "US",
      ),
    );
  });
});

describe("tvSummarySchema / tvDetailSchema", () => {
  test("summarizeTv's output on a bare-minimum show does not throw", () => {
    assert.doesNotThrow(() => summarizeTv({ id: 1 }));
  });

  test("detailTv's output on a bare-minimum show does not throw", () => {
    assert.doesNotThrow(() => detailTv({ id: 1 }, "US"));
  });

  test("detailTv's output with next/last_episode_to_air populated does not throw", () => {
    assert.doesNotThrow(() =>
      detailTv(
        {
          id: 1,
          name: "N",
          next_episode_to_air: {
            season_number: 2,
            episode_number: 1,
            name: "E",
            air_date: "2026",
          },
          last_episode_to_air: {
            season_number: 1,
            episode_number: 8,
            name: "F",
            air_date: "2025",
          },
          seasons: [{ season_number: 1, name: "S1", episode_count: 8, air_date: "2025" }],
        },
        "US",
      ),
    );
  });

  test("movieOrTvSchema accepts both a movie and a tv summary", () => {
    assert.doesNotThrow(() => movieOrTvSchema.parse(summarizeMovie({ id: 1 })));
    assert.doesNotThrow(() => movieOrTvSchema.parse(summarizeTv({ id: 1 })));
  });
});

describe("personDetailSchema", () => {
  test("detailPerson's output on a bare-minimum person does not throw", () => {
    assert.doesNotThrow(() => detailPerson({ id: 1 }));
  });
});

describe("creditsSchema", () => {
  test("summarizeCredits's output with no cast/crew does not throw", () => {
    assert.doesNotThrow(() => summarizeCredits({}));
  });
});

describe("personSummarySchema / multiItemSchema", () => {
  test("summarizePerson's output on a bare-minimum item does not throw", () => {
    const item: TmdbMultiItem = { id: 1, media_type: "person" };
    assert.doesNotThrow(() => summarizePerson(item));
  });

  test("multiItemSchema accepts a movie, tv and person row from summarizeMultiItem", () => {
    assert.doesNotThrow(() =>
      multiItemSchema.parse(summarizeMultiItem({ id: 1, media_type: "movie", title: "T" })),
    );
    assert.doesNotThrow(() =>
      multiItemSchema.parse(summarizeMultiItem({ id: 1, media_type: "tv", name: "N" })),
    );
    assert.doesNotThrow(() =>
      multiItemSchema.parse(summarizeMultiItem({ id: 1, media_type: "person" })),
    );
  });
});

describe("pageSchema", () => {
  test("page()'s output on an empty page does not throw", () => {
    assert.doesNotThrow(() => pageSchema(movieSummarySchema).parse(page({}, summarizeMovie)));
  });
});

describe("genresSchema", () => {
  test("summarizeGenres's output on an empty list does not throw", () => {
    assert.doesNotThrow(() => summarizeGenres([]));
  });
});

describe("reviewSchema", () => {
  test("summarizeReview's output on a bare-minimum review does not throw", () => {
    assert.doesNotThrow(() => summarizeReview({}));
  });
});

describe("collectionSchema", () => {
  test("summarizeCollection's output on a bare-minimum collection does not throw", () => {
    assert.doesNotThrow(() => summarizeCollection({}));
  });
});

describe("keywordsSchema", () => {
  test("summarizeKeywords's output on an empty response does not throw", () => {
    assert.doesNotThrow(() => summarizeKeywords({}));
  });
});

describe("watchProvidersSchema", () => {
  test("both the unavailable and available branches do not throw", () => {
    assert.doesNotThrow(() => summarizeWatchProviders({}, "US"));
    assert.doesNotThrow(() => summarizeWatchProviders({ results: { US: {} } }, "US"));
  });
});

describe("personCreditsSchema", () => {
  test("summarizePersonCredits's output with no cast/crew does not throw", () => {
    assert.doesNotThrow(() => summarizePersonCredits({}));
  });
});

describe("videosSchema", () => {
  test("summarizeVideos's output on a bare-minimum video does not throw", () => {
    assert.doesNotThrow(() => summarizeVideos({ results: [{}] }));
  });
});

describe("findSchema", () => {
  test("summarizeFind's output on an empty response does not throw", () => {
    assert.doesNotThrow(() => summarizeFind({}));
  });

  test("summarizeFind's output with a bare-minimum person_results row does not throw", () => {
    assert.doesNotThrow(() => summarizeFind({ person_results: [{ id: 1 }] }));
  });
});

describe("seasonSchema", () => {
  test("summarizeSeason's output on a bare-minimum season does not throw", () => {
    assert.doesNotThrow(() => summarizeSeason({}));
  });

  test("summarizeSeason's output with a bare-minimum episode does not throw", () => {
    assert.doesNotThrow(() => summarizeSeason({ episodes: [{}] }));
  });
});

describe("episodeSchema", () => {
  test("summarizeEpisode's output on a bare-minimum episode does not throw", () => {
    assert.doesNotThrow(() => summarizeEpisode({}));
  });

  test("summarizeEpisode's output with guest_stars/crew rows does not throw", () => {
    assert.doesNotThrow(() =>
      summarizeEpisode({
        guest_stars: [{ id: 1 }],
        crew: [{ id: 2, job: "Director" }],
      }),
    );
  });
});

describe("ratingsSchema", () => {
  test("both the found:false and found:true branches do not throw", () => {
    assert.doesNotThrow(() => summarizeRatings({ Response: "False" }));
    assert.doesNotThrow(() => summarizeRatings({ Response: "True" }));
    assert.doesNotThrow(() => summarizeRatings({ Response: "True", Ratings: [{}] }));
  });
});
