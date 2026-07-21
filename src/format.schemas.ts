// Zod schemas describing the exact return shape of each shaper in ./format.ts,
// used two ways: as a tool's `outputSchema` (MCP structured content,
// SEP-2106), and — schema-first — by the paired shaper itself, which builds
// its result and runs it through `<name>Schema.parse()` before returning. A
// shaper that drifts from its schema throws immediately at the source instead
// of silently disagreeing with two independently-maintained files. Kept in
// the same order as the shapers they mirror so the two files are still easy
// to eyeball side by side.
//
// Every object is `.strict()`: a shaper that starts returning a field this
// file doesn't know about must fail validation (both here and in the real
// client-side outputSchema check) instead of silently dropping the extra key,
// which is Zod's — and JSON Schema's — default behavior otherwise.
//
// `.nullable()` marks a field the shaper always sets to a value-or-null;
// `.optional()` marks one that can be a genuinely absent key (an `undefined`
// passed through from a raw optional TMDB/OMDb field, dropped by JSON
// serialization) rather than an explicit null.
import { z } from "zod";

// A `{id, name}` reference pair (a genre, a keyword, …).
const idNameSchema = z.object({ id: z.number().optional(), name: z.string().optional() }).strict();

// A billed cast member (a movie/TV credit, an episode's guest star, …).
const castMemberSchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
    character: z.string().nullable(),
  })
  .strict();

// ---- summarizeMovie / detailMovie -------------------------------------------

export const movieSummarySchema = z
  .object({
    id: z.number(),
    media_type: z.literal("movie"),
    title: z.string().optional(),
    original_title: z.string().optional(),
    year: z.number().nullable(),
    release_date: z.string().nullable(),
    vote_average: z.number().nullable(),
    vote_count: z.number().nullable(),
    overview: z.string().nullable(),
    poster_url: z.string().nullable(),
  })
  .strict();

const collectionRefSchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
    poster_url: z.string().nullable(),
  })
  .strict();

export const movieDetailSchema = z
  .object({
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
    release_date: z.string().nullable(),
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
  })
  .strict();

// ---- summarizeTv / detailTv --------------------------------------------------

export const tvSummarySchema = z
  .object({
    id: z.number(),
    media_type: z.literal("tv"),
    name: z.string().optional(),
    original_name: z.string().optional(),
    year: z.number().nullable(),
    first_air_date: z.string().nullable(),
    vote_average: z.number().nullable(),
    vote_count: z.number().nullable(),
    overview: z.string().nullable(),
    poster_url: z.string().nullable(),
  })
  .strict();

// Item shape for get_similar (movie or tv, depending on the media_type input).
export const movieOrTvSchema = z.discriminatedUnion("media_type", [
  movieSummarySchema,
  tvSummarySchema,
]);

const episodeBriefSchema = z
  .object({
    season_number: z.number().nullable(),
    episode_number: z.number().nullable(),
    name: z.string().nullable(),
    air_date: z.string().nullable(),
  })
  .strict();

const seasonBriefSchema = z
  .object({
    season_number: z.number().nullable(),
    name: z.string().nullable(),
    episode_count: z.number().nullable(),
    air_date: z.string().nullable(),
  })
  .strict();

export const tvDetailSchema = z
  .object({
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
    first_air_date: z.string().nullable(),
    last_air_date: z.string().nullable(),
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
  })
  .strict();

// ---- detailPerson -------------------------------------------------------------

export const personDetailSchema = z
  .object({
    id: z.number(),
    imdb_id: z.string().nullable(),
    name: z.string().optional(),
    also_known_as: z.array(z.string()),
    known_for_department: z.string().nullable(),
    gender: z.string().nullable(),
    biography: z.string().nullable(),
    birthday: z.string().nullable(),
    deathday: z.string().nullable(),
    place_of_birth: z.string().nullable(),
    popularity: z.number().nullable(),
    homepage: z.string().nullable(),
    profile_url: z.string().nullable(),
    tmdb_url: z.string(),
    imdb_url: z.string().nullable(),
  })
  .strict();

// ---- summarizeCredits ---------------------------------------------------------

export const creditsSchema = z
  .object({
    cast: z.array(castMemberSchema),
    crew: z.array(
      z
        .object({
          id: z.number().optional(),
          name: z.string().optional(),
          job: z.string().optional(),
          department: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

// ---- summarizePerson ----------------------------------------------------------

export const personSummarySchema = z
  .object({
    id: z.number(),
    media_type: z.literal("person"),
    name: z.string().optional(),
    known_for_department: z.string().nullable(),
    popularity: z.number().nullable(),
    profile_url: z.string().nullable(),
    known_for: z.array(z.string()),
  })
  .strict();

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
  return z
    .object({
      results: z.array(item),
      page: z.number(),
      total_pages: z.number(),
      total_results: z.number(),
    })
    .strict();
}

// ---- summarizeGenres -----------------------------------------------------------

export const genresSchema = z
  .object({
    genres: z.array(idNameSchema),
  })
  .strict();

// ---- summarizeReview -----------------------------------------------------------

export const reviewSchema = z
  .object({
    author: z.string().nullable(),
    rating: z.number().nullable(),
    created_at: z.string().nullable(),
    content: z.string().nullable(),
    url: z.string().nullable(),
  })
  .strict();

// ---- summarizeCollection --------------------------------------------------------

export const collectionSchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
    overview: z.string().nullable(),
    poster_url: z.string().nullable(),
    parts: z.array(movieSummarySchema),
  })
  .strict();

// ---- summarizeKeywords -----------------------------------------------------------

export const keywordsSchema = pageSchema(idNameSchema);

// ---- summarizeWatchProviders -------------------------------------------------------

export const watchProvidersSchema = z.discriminatedUnion("available", [
  z
    .object({
      region: z.string(),
      available: z.literal(false),
      available_regions: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      region: z.string(),
      available: z.literal(true),
      link: z.string().nullable(),
      streaming: z.array(z.string()),
      free: z.array(z.string()),
      ads: z.array(z.string()),
      rent: z.array(z.string()),
      buy: z.array(z.string()),
      available_regions: z.array(z.string()),
    })
    .strict(),
]);

// ---- summarizePersonCredits ---------------------------------------------------------

const creditMediaType = z.enum(["movie", "tv"]).optional();

export const personCreditsSchema = z
  .object({
    cast: z.array(
      z
        .object({
          id: z.number().optional(),
          media_type: creditMediaType,
          title: z.string().optional(),
          year: z.number().nullable(),
          character: z.string().nullable(),
          vote_average: z.number().nullable(),
        })
        .strict(),
    ),
    crew: z.array(
      z
        .object({
          id: z.number().optional(),
          media_type: creditMediaType,
          title: z.string().optional(),
          year: z.number().nullable(),
          job: z.string().nullable(),
          department: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

// ---- summarizeVideos -----------------------------------------------------------------

export const videosSchema = z
  .object({
    results: z.array(
      z
        .object({
          name: z.string().optional(),
          type: z.string().nullable(),
          site: z.string().nullable(),
          official: z.boolean().nullable(),
          url: z.string().nullable(),
          published_at: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

// ---- summarizeFind -----------------------------------------------------------------

export const findSchema = z
  .object({
    movie_results: z.array(movieSummarySchema),
    tv_results: z.array(tvSummarySchema),
    person_results: z.array(
      z
        .object({
          id: z.number(),
          media_type: z.literal("person"),
          name: z.string().optional(),
          known_for_department: z.string().nullable(),
          profile_url: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

// ---- summarizeSeason / summarizeEpisode -----------------------------------------------

export const seasonSchema = z
  .object({
    season_number: z.number().nullable(),
    name: z.string().nullable(),
    air_date: z.string().nullable(),
    overview: z.string().nullable(),
    poster_url: z.string().nullable(),
    episode_count: z.number(),
    episodes: z.array(
      z
        .object({
          episode_number: z.number().nullable(),
          name: z.string().nullable(),
          air_date: z.string().nullable(),
          runtime_minutes: z.number().nullable(),
          vote_average: z.number().nullable(),
          overview: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const episodeSchema = z
  .object({
    season_number: z.number().nullable(),
    episode_number: z.number().nullable(),
    name: z.string().nullable(),
    air_date: z.string().nullable(),
    runtime_minutes: z.number().nullable(),
    vote_average: z.number().nullable(),
    overview: z.string().nullable(),
    still_url: z.string().nullable(),
    guest_stars: z.array(castMemberSchema),
    crew: z.array(
      z
        .object({
          id: z.number().optional(),
          name: z.string().optional(),
          job: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

// ---- summarizeRatings (OMDb) -----------------------------------------------------------

export const ratingsSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false), reason: z.string() }).strict(),
  z
    .object({
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
        z.object({ source: z.string().optional(), value: z.string().optional() }).strict(),
      ),
    })
    .strict(),
]);

// ---- get_movie / get_tv: TMDB detail + optional OMDb enrichment ------------------------

// get_movie/get_tv's real outputSchema — the base detail plus what
// getEnrichedDetail (tools/tmdb.ts) may fold in — named here next to
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
