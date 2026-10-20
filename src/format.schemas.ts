// Zod schemas describing the exact return shape of each shaper in ./format.ts,
// used two ways: as a tool's `outputSchema` (MCP structured content,
// SEP-2106), and — schema-first — by the paired shaper itself, which builds
// its result and runs it through `<name>Schema.parse()` before returning. A
// shaper that drifts from its schema throws immediately at the source instead
// of silently disagreeing with two independently-maintained files. Kept in
// the same order as the shapers they mirror so the two files are still easy
// to eyeball side by side.
//
// Every object rejects unknown keys via `z.strictObject(...)`: a shaper that
// starts returning a field this file doesn't know about must fail validation
// (both here and in the real client-side outputSchema check) instead of
// silently dropping the extra key, which is Zod's — and JSON Schema's —
// default behavior otherwise.
//
// `.nullable()` marks a field the shaper always sets to a value-or-null;
// `.optional()` marks one that can be a genuinely absent key (an `undefined`
// passed through from a raw optional TMDB/OMDb field, dropped by JSON
// serialization) rather than an explicit null.
import { z } from "zod";

// A `{id, name}` reference pair (a genre, a keyword, …).
const idNameSchema = z.strictObject({ id: z.number().optional(), name: z.string().optional() });

// A billed cast member (a movie/TV credit, an episode's guest star, …).
const castMemberSchema = z.strictObject({
  id: z.number().optional(),
  name: z.string().optional(),
  character: z.string().nullable(),
});

// The two score families this server carries: TMDB's own `vote_average` and
// OMDb's three third-party scores. Described — unlike most fields here, which
// need no prose — because get_movie/get_tv/get_movies/get_tv_shows return both
// families side by side in ONE response, on four different scales with four
// different voter populations (TMDB 0-10 users, IMDb 0-10 users, Metacritic
// 0-100 critics, RT percentage of positive critics). Without this the output
// contract gives a calling model nothing to tell them apart, and a near-miss
// pair invites conflation: Halloween (2018) returns vote_average 6.563 next to
// imdb_rating "6.5", which reads as one number rounded twice rather than two
// unrelated measurements. Shared consts rather than repeated inline literals so
// every schema carrying the field states the same thing (and `.pick()`ing one
// into a card schema carries the text along). One shared const covers all
// seven uses, so it must stay true of the leanest one: the episode objects in
// seasonSchema/episodeSchema carry neither a `vote_count` nor a sibling
// `ratings` field, so the text names get_movie/get_tv as where the other
// family lives instead of pointing at a field that isn't always there.
const voteAverage = z
  .number()
  .nullable()
  .describe(
    "TMDB's own 0-10 user score. A different audience and scale from the IMDb/RT/Metacritic " +
      "scores get_movie/get_tv return as `ratings` — don't compare, average or substitute across " +
      "the two.",
  );

const imdbRating = z
  .string()
  .nullable()
  .describe("IMDb user score, 0-10, as a string, e.g. '6.5'. Not TMDB's `vote_average`.");

const metascore = z
  .string()
  .nullable()
  .describe("Metacritic critic score, 0-100 scale, as a string, e.g. '67'.");

const rottenTomatoes = z
  .string()
  .nullable()
  .describe(
    "Rotten Tomatoes Tomatometer — the percentage of positive critic reviews, as a string " +
      "including the sign, e.g. '79%'. Not a 0-10 or 0-100 score.",
  );

// ---- summarizeMovie / detailMovie -------------------------------------------

export const movieSummarySchema = z.strictObject({
  id: z.number(),
  media_type: z.literal("movie"),
  title: z.string().optional(),
  original_title: z.string().optional(),
  year: z.number().nullable(),
  release_date: z.iso.date().nullable().catch(null),
  vote_average: voteAverage,
  vote_count: z.number().nullable(),
  overview: z.string().nullable(),
  poster_url: z.string().nullable(),
});

const collectionRefSchema = z.strictObject({
  id: z.number().optional(),
  name: z.string().optional(),
  poster_url: z.string().nullable(),
});

export const movieDetailSchema = z.strictObject({
  id: z.number(),
  imdb_id: z.string().nullable(),
  media_type: z.literal("movie"),
  certification: z.string().nullable(),
  certification_region: z.string(),
  certifications: z.record(z.string(), z.string()),
  title: z.string().optional(),
  original_title: z.string().optional(),
  tagline: z.string().nullable(),
  overview: z.string().nullable(),
  year: z.number().nullable(),
  release_date: z.iso.date().nullable().catch(null),
  runtime_minutes: z.number().nullable(),
  status: z.string().nullable(),
  genres: z.array(z.string()),
  vote_average: voteAverage,
  vote_count: z.number().nullable(),
  popularity: z.number().nullable(),
  original_language: z.string().nullable(),
  spoken_languages: z.array(z.string()),
  production_companies: z.array(z.string()),
  origin_country: z.array(z.string()),
  collection: collectionRefSchema.nullable(),
  budget_usd: z.number().nullable(),
  revenue_usd: z.number().nullable(),
  homepage: z.string().nullable(),
  poster_url: z.string().nullable(),
  tmdb_url: z.string(),
  imdb_url: z.string().nullable(),
});

// ---- summarizeTv / detailTv --------------------------------------------------

export const tvSummarySchema = z.strictObject({
  id: z.number(),
  media_type: z.literal("tv"),
  name: z.string().optional(),
  original_name: z.string().optional(),
  year: z.number().nullable(),
  first_air_date: z.iso.date().nullable().catch(null),
  vote_average: voteAverage,
  vote_count: z.number().nullable(),
  overview: z.string().nullable(),
  poster_url: z.string().nullable(),
});

// Item shape for get_similar (movie or tv, depending on the media_type input).
export const movieOrTvSchema = z.discriminatedUnion("media_type", [
  movieSummarySchema,
  tvSummarySchema,
]);

export const episodeBriefSchema = z.strictObject({
  season_number: z.number().nullable(),
  episode_number: z.number().nullable(),
  name: z.string().nullable(),
  air_date: z.iso.date().nullable().catch(null),
});

const seasonBriefSchema = z.strictObject({
  season_number: z.number().nullable(),
  name: z.string().nullable(),
  episode_count: z.number().nullable(),
  air_date: z.iso.date().nullable().catch(null),
});

export const tvDetailSchema = z.strictObject({
  id: z.number(),
  imdb_id: z.string().nullable(),
  media_type: z.literal("tv"),
  certification: z.string().nullable(),
  certification_region: z.string(),
  certifications: z.record(z.string(), z.string()),
  name: z.string().optional(),
  original_name: z.string().optional(),
  tagline: z.string().nullable(),
  overview: z.string().nullable(),
  type: z.string().nullable(),
  year: z.number().nullable(),
  first_air_date: z.iso.date().nullable().catch(null),
  last_air_date: z.iso.date().nullable().catch(null),
  status: z.string().nullable(),
  in_production: z.boolean().nullable(),
  next_episode_to_air: episodeBriefSchema.nullable(),
  last_episode_to_air: episodeBriefSchema.nullable(),
  number_of_seasons: z.number().nullable(),
  number_of_episodes: z.number().nullable(),
  episode_run_time: z.array(z.number()),
  seasons: z.array(seasonBriefSchema),
  genres: z.array(z.string()),
  vote_average: voteAverage,
  vote_count: z.number().nullable(),
  popularity: z.number().nullable(),
  original_language: z.string().nullable(),
  networks: z.array(z.string()),
  created_by: z.array(z.string()),
  homepage: z.string().nullable(),
  poster_url: z.string().nullable(),
  tmdb_url: z.string(),
  imdb_url: z.string().nullable(),
});

// ---- detailPerson -------------------------------------------------------------

export const personDetailSchema = z.strictObject({
  id: z.number(),
  imdb_id: z.string().nullable(),
  name: z.string().optional(),
  also_known_as: z.array(z.string()),
  known_for_department: z.string().nullable(),
  gender: z.string().nullable(),
  biography: z.string().nullable(),
  birthday: z.iso.date().nullable().catch(null),
  deathday: z.iso.date().nullable().catch(null),
  place_of_birth: z.string().nullable(),
  popularity: z.number().nullable(),
  homepage: z.string().nullable(),
  profile_url: z.string().nullable(),
  tmdb_url: z.string(),
  imdb_url: z.string().nullable(),
});

// ---- summarizeCredits ---------------------------------------------------------

export const creditsSchema = z.strictObject({
  cast: z.array(castMemberSchema),
  crew: z.array(
    z.strictObject({
      id: z.number().optional(),
      name: z.string().optional(),
      job: z.string().optional(),
      department: z.string().optional(),
    }),
  ),
});

// ---- summarizeTvCredits --------------------------------------------------------

export const tvCreditsSchema = z.strictObject({
  cast: z.array(
    z.strictObject({
      id: z.number().optional(),
      name: z.string().optional(),
      character: z.string().nullable(),
      episode_count: z
        .number()
        .describe("Episodes across the whole run this person appears in, in any role."),
    }),
  ),
  crew: z.array(
    z.strictObject({
      id: z.number().optional(),
      name: z.string().optional(),
      job: z.string(),
      department: z.string().optional(),
      episode_count: z
        .number()
        .describe("Episodes across the whole run this person is credited on in this job."),
    }),
  ),
});

// ---- summarizePerson ----------------------------------------------------------

export const personSummarySchema = z.strictObject({
  id: z.number(),
  media_type: z.literal("person"),
  name: z.string().optional(),
  known_for_department: z.string().nullable(),
  popularity: z.number().nullable(),
  profile_url: z.string().nullable(),
  known_for: z.array(z.string()),
});

// Item shape for search_multi / get_trending pages, which can mix movies, TV
// shows and people.
export const multiItemSchema = z.discriminatedUnion("media_type", [
  movieSummarySchema,
  tvSummarySchema,
  personSummarySchema,
]);

// ---- page() -------------------------------------------------------------------

/** The `outputSchema` for any tool that returns a `page()`-wrapped list. */
export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.strictObject({
    results: z.array(item),
    page: z.number(),
    total_pages: z.number(),
    total_results: z.number(),
  });
}

// ---- summarizeGenres -----------------------------------------------------------

export const genresSchema = z.strictObject({
  genres: z.array(idNameSchema),
});

// ---- summarizeReview -----------------------------------------------------------

export const reviewSchema = z.strictObject({
  author: z.string().nullable(),
  rating: z.number().nullable(),
  created_at: z.iso.datetime().nullable().catch(null),
  content: z.string().nullable(),
  url: z.string().nullable(),
});

// ---- summarizeCollection --------------------------------------------------------

export const collectionSchema = z.strictObject({
  id: z.number().optional(),
  name: z.string().optional(),
  overview: z.string().nullable(),
  poster_url: z.string().nullable(),
  parts: z.array(movieSummarySchema),
});

// ---- summarizeKeywords -----------------------------------------------------------

export const keywordsSchema = pageSchema(idNameSchema);

// ---- summarizeCompany -------------------------------------------------------------

// Company names aren't unique (TMDB has multiple unrelated companies sharing
// the same name) — origin_country/logo_url are kept so a caller can tell them
// apart, not dropped the way a "just resolve name → id" shaper normally would.
export const companySchema = z.strictObject({
  id: z.number(),
  name: z.string().optional(),
  origin_country: z.string().nullable(),
  logo_url: z.string().nullable(),
});
export const companiesSchema = pageSchema(companySchema);

// ---- summarizeWatchProviders -------------------------------------------------------

export const watchProvidersSchema = z.discriminatedUnion("available", [
  z.strictObject({
    region: z.string(),
    available: z.literal(false),
    available_regions: z.array(z.string()),
  }),
  z.strictObject({
    region: z.string(),
    available: z.literal(true),
    link: z.string().nullable(),
    streaming: z.array(z.string()),
    free: z.array(z.string()),
    ads: z.array(z.string()),
    rent: z.array(z.string()),
    buy: z.array(z.string()),
    available_regions: z.array(z.string()),
  }),
]);

// ---- summarizeWatchProviderMatches -------------------------------------------------

const watchProviderMatchSchema = z.strictObject({
  provider_id: z.number(),
  provider_name: z.string(),
  logo_url: z.string().nullable(),
});
export const watchProviderMatchesSchema = pageSchema(watchProviderMatchSchema);

// ---- summarizePersonCredits ---------------------------------------------------------

const creditMediaType = z.enum(["movie", "tv"]).optional();

export const personCreditsSchema = z.strictObject({
  cast: z.array(
    z.strictObject({
      id: z.number().optional(),
      media_type: creditMediaType,
      title: z.string().optional(),
      year: z.number().nullable(),
      character: z.string().nullable(),
      vote_average: voteAverage,
    }),
  ),
  crew: z.array(
    z.strictObject({
      id: z.number().optional(),
      media_type: creditMediaType,
      title: z.string().optional(),
      year: z.number().nullable(),
      job: z.string().nullable(),
      department: z.string().nullable(),
    }),
  ),
});

// ---- summarizeVideos -----------------------------------------------------------------

export const videosSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      name: z.string().optional(),
      type: z.string().nullable(),
      site: z.string().nullable(),
      official: z.boolean().nullable(),
      url: z.string().nullable(),
      published_at: z.iso.datetime().nullable().catch(null),
    }),
  ),
});

// ---- summarizeFind -----------------------------------------------------------------

export const findSchema = z.strictObject({
  movie_results: z.array(movieSummarySchema),
  tv_results: z.array(tvSummarySchema),
  person_results: z.array(personSummarySchema),
});

// ---- summarizeSeason / summarizeEpisode -----------------------------------------------

export const seasonSchema = z.strictObject({
  season_number: z.number().nullable(),
  name: z.string().nullable(),
  air_date: z.iso.date().nullable().catch(null),
  overview: z.string().nullable(),
  poster_url: z.string().nullable(),
  episode_count: z.number(),
  episodes: z.array(
    z.strictObject({
      episode_number: z.number().nullable(),
      name: z.string().nullable(),
      air_date: z.iso.date().nullable().catch(null),
      runtime_minutes: z.number().nullable(),
      vote_average: voteAverage,
      overview: z.string().nullable(),
    }),
  ),
});

export const episodeSchema = z.strictObject({
  season_number: z.number().nullable(),
  episode_number: z.number().nullable(),
  imdb_id: z
    .string()
    .nullable()
    .describe(
      "This episode's own IMDb id (not the show's) — pass it to get_ratings for the episode's " +
        "IMDb rating, which no TMDB field carries. Null when TMDB has no IMDb id for it.",
    ),
  imdb_url: z.string().nullable(),
  name: z.string().nullable(),
  air_date: z.iso.date().nullable().catch(null),
  runtime_minutes: z.number().nullable(),
  vote_average: voteAverage,
  overview: z.string().nullable(),
  still_url: z.string().nullable(),
  guest_stars: z.array(castMemberSchema),
  crew: z.array(
    z.strictObject({
      id: z.number().optional(),
      name: z.string().optional(),
      job: z.string().optional(),
    }),
  ),
});

// ---- summarizeRatings (OMDb) -----------------------------------------------------------

export const ratingsSchema = z.discriminatedUnion("found", [
  z.strictObject({ found: z.literal(false), reason: z.string() }),
  z.strictObject({
    found: z.literal(true),
    imdb_id: z.string().nullable(),
    title: z.string().nullable(),
    year: z.string().nullable(),
    rated: z.string().nullable(),
    runtime: z.string().nullable(),
    imdb_rating: imdbRating,
    imdb_votes: z.string().nullable(),
    metascore: metascore,
    rotten_tomatoes: rottenTomatoes,
    awards: z.string().nullable(),
    ratings: z.array(
      z.strictObject({ source: z.string().optional(), value: z.string().optional() }),
    ),
  }),
]);

// ---- get_movie / get_tv: TMDB detail + optional OMDb enrichment ------------------------

// get_movie/get_tv's real outputSchema — the base detail plus what
// getEnrichedDetail (tools/tmdb/details.ts) may fold in — named here next to
// movieDetailSchema/tvDetailSchema instead of assembled via `.extend()` at
// the tool-registration call site, so the full contract for each tool is
// visible in one place instead of split across the registration, the client,
// and this file.
export const movieDetailEnrichedSchema = movieDetailSchema.extend({
  ratings: ratingsSchema.optional(),
});

export const tvDetailEnrichedSchema = tvDetailSchema.extend({
  ratings: ratingsSchema.optional(),
  seasons_detail: z.array(seasonSchema).optional(),
});

// ---- get_movies / get_tv_shows: compact batch cards ------------------------------------

// Deliberately smaller than ratingsSchema — a batch of up to 20 cards is the
// whole point of get_movies/get_tv_shows, so this drops the fields a card
// doesn't need (imdb_id/title/year/rated/runtime/imdb_votes/awards, and the
// source/value array duplicating imdb_rating/rotten_tomatoes/metascore) to
// keep each card's ratings genuinely compact rather than reusing ratingsSchema
// as-is.
export const cardRatingsSchema = z.discriminatedUnion("found", [
  z.strictObject({ found: z.literal(false), reason: z.string() }),
  z.strictObject({
    found: z.literal(true),
    imdb_rating: imdbRating,
    rotten_tomatoes: rottenTomatoes,
    metascore: metascore,
  }),
]);

// Shared by movieCardSchema/tvCardSchema's "couldn't fetch this one" branch —
// the same shape either way, since the caller already knows which media_type
// the whole batch call was for.
export const cardNotFoundSchema = z.strictObject({
  found: z.literal(false),
  id: z.number(),
  reason: z.string(),
});

// Picked from movieDetailSchema rather than redeclared, so a card's id/title/
// year/genres/vote_average/vote_count can never silently drift from the
// detail schema's own definition of those same fields.
export const movieCardSchema = z.discriminatedUnion("found", [
  movieDetailSchema
    .pick({ id: true, title: true, year: true, genres: true, vote_average: true, vote_count: true })
    .extend({ found: z.literal(true), ratings: cardRatingsSchema.optional() })
    // Defensive: pick/extend already preserve strictObject's unknown-key
    // rejection on Zod 4.4.3 (see AGENTS.md), so this only guards a future
    // Zod that might change that.
    .strict(),
  cardNotFoundSchema,
]);

// Picked from tvDetailSchema for the same no-drift reason as movieCardSchema.
export const tvCardSchema = z.discriminatedUnion("found", [
  tvDetailSchema
    .pick({
      id: true,
      name: true,
      genres: true,
      vote_average: true,
      year: true,
      vote_count: true,
      number_of_seasons: true,
      number_of_episodes: true,
    })
    .extend({ found: z.literal(true), ratings: cardRatingsSchema.optional() })
    .strict(),
  cardNotFoundSchema,
]);
