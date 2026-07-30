// Zod schemas describing the exact return shape of each shaper in ./format.ts,
// used two ways: as a tool's `outputSchema` (MCP structured content,
// SEP-2106), and — schema-first — by the paired shaper itself, which builds
// its result and runs it through `<name>Schema.parse()` before returning. A
// shaper that drifts from its schema throws immediately at the source instead
// of silently disagreeing with two independently-maintained files. Kept in
// the same order as the shapers they mirror so the two files are still easy
// to eyeball side by side.
//
// Every object rejects unknown keys — `z.strictObject(...)`, or `.strict()`
// where the shape comes from `.pick()`/`.extend()` and no `z.strictObject`
// equivalent exists (movieCardSchema/tvCardSchema below): a shaper that
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

// ---- summarizeMovie / detailMovie -------------------------------------------

export const movieSummarySchema = z.strictObject({
  id: z.number().brand<"MovieId">(),
  media_type: z.literal("movie"),
  title: z.string().optional(),
  original_title: z.string().optional(),
  year: z.number().nullable(),
  release_date: z.iso.date().nullable(),
  vote_average: z.number().nullable(),
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
  id: z.number().brand<"MovieId">(),
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
  release_date: z.iso.date().nullable(),
  runtime_minutes: z.number().nullable(),
  status: z.string().nullable(),
  genres: z.array(z.string()),
  vote_average: z.number().nullable(),
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
  id: z.number().brand<"TvId">(),
  media_type: z.literal("tv"),
  name: z.string().optional(),
  original_name: z.string().optional(),
  year: z.number().nullable(),
  first_air_date: z.iso.date().nullable(),
  vote_average: z.number().nullable(),
  vote_count: z.number().nullable(),
  overview: z.string().nullable(),
  poster_url: z.string().nullable(),
});

// Item shape for get_similar (movie or tv, depending on the media_type input).
export const movieOrTvSchema = z.discriminatedUnion("media_type", [
  movieSummarySchema,
  tvSummarySchema,
]);

const episodeBriefSchema = z.strictObject({
  season_number: z.number().nullable(),
  episode_number: z.number().nullable(),
  name: z.string().nullable(),
  air_date: z.iso.date().nullable(),
});

const seasonBriefSchema = z.strictObject({
  season_number: z.number().nullable(),
  name: z.string().nullable(),
  episode_count: z.number().nullable(),
  air_date: z.iso.date().nullable(),
});

export const tvDetailSchema = z.strictObject({
  id: z.number().brand<"TvId">(),
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
  first_air_date: z.iso.date().nullable(),
  last_air_date: z.iso.date().nullable(),
  status: z.string().nullable(),
  in_production: z.boolean().nullable(),
  next_episode_to_air: episodeBriefSchema.nullable(),
  last_episode_to_air: episodeBriefSchema.nullable(),
  number_of_seasons: z.number().nullable(),
  number_of_episodes: z.number().nullable(),
  episode_run_time: z.array(z.number()),
  seasons: z.array(seasonBriefSchema),
  genres: z.array(z.string()),
  vote_average: z.number().nullable(),
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
  id: z.number().brand<"PersonId">(),
  imdb_id: z.string().nullable(),
  name: z.string().optional(),
  also_known_as: z.array(z.string()),
  known_for_department: z.string().nullable(),
  gender: z.string().nullable(),
  biography: z.string().nullable(),
  birthday: z.iso.date().nullable(),
  deathday: z.iso.date().nullable(),
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

// ---- summarizePerson ----------------------------------------------------------

export const personSummarySchema = z.strictObject({
  id: z.number().brand<"PersonId">(),
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
  created_at: z.iso.datetime().nullable(),
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

export const watchProviderMatchSchema = z.strictObject({
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
      vote_average: z.number().nullable(),
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
      published_at: z.iso.datetime().nullable(),
    }),
  ),
});

// ---- summarizeFind -----------------------------------------------------------------

export const findSchema = z.strictObject({
  movie_results: z.array(movieSummarySchema),
  tv_results: z.array(tvSummarySchema),
  person_results: z.array(
    z.strictObject({
      id: z.number(),
      media_type: z.literal("person"),
      name: z.string().optional(),
      known_for_department: z.string().nullable(),
      profile_url: z.string().nullable(),
    }),
  ),
});

// ---- summarizeSeason / summarizeEpisode -----------------------------------------------

export const seasonSchema = z.strictObject({
  season_number: z.number().nullable(),
  name: z.string().nullable(),
  air_date: z.iso.date().nullable(),
  overview: z.string().nullable(),
  poster_url: z.string().nullable(),
  episode_count: z.number(),
  episodes: z.array(
    z.strictObject({
      episode_number: z.number().nullable(),
      name: z.string().nullable(),
      air_date: z.iso.date().nullable(),
      runtime_minutes: z.number().nullable(),
      vote_average: z.number().nullable(),
      overview: z.string().nullable(),
    }),
  ),
});

export const episodeSchema = z.strictObject({
  season_number: z.number().nullable(),
  episode_number: z.number().nullable(),
  name: z.string().nullable(),
  air_date: z.iso.date().nullable(),
  runtime_minutes: z.number().nullable(),
  vote_average: z.number().nullable(),
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
    imdb_rating: z.string().nullable(),
    imdb_votes: z.string().nullable(),
    metascore: z.string().nullable(),
    rotten_tomatoes: z.string().nullable(),
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
    imdb_rating: z.string().nullable(),
    rotten_tomatoes: z.string().nullable(),
    metascore: z.string().nullable(),
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
    .strict(),
  cardNotFoundSchema,
]);

// tvDetailSchema has no `year` field of its own (only first_air_date, unlike
// movieDetailSchema) — picked fields cover id/name/genres/vote_average/
// vote_count from the detail schema, `year` (derived from first_air_date, the
// same derivation tvSummarySchema's shaper already does) is the one field
// this can't inherit and must declare directly.
export const tvCardSchema = z.discriminatedUnion("found", [
  tvDetailSchema
    .pick({
      id: true,
      name: true,
      genres: true,
      vote_average: true,
      vote_count: true,
      number_of_seasons: true,
      number_of_episodes: true,
    })
    .extend({
      found: z.literal(true),
      year: z.number().nullable(),
      ratings: cardRatingsSchema.optional(),
    })
    .strict(),
  cardNotFoundSchema,
]);
