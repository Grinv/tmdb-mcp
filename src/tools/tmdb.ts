// TMDB-backed tools (search, details, credits, recommendations, trending,
// genres). get_movie / get_tv optionally enrich their result with OMDb ratings
// (IMDb/RT/Metacritic) keyed by the imdb_id TMDB returns — this cross-linking is
// the whole point of keeping both clients in one server. Descriptions and
// per-field .describe() text are written for the calling model: when to use a
// tool and the meaning of every parameter.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { TmdbClient } from "../clients/tmdb.js";
import type { OmdbClient } from "../clients/omdb.js";
import type { Config } from "../config.js";
import { LANGUAGE_REGEX } from "../config.js";
import { movieCard, notFoundCard, summarizeRatings, tvCard } from "../format.js";
import {
  collectionSchema,
  companySchema,
  creditsSchema,
  episodeSchema,
  findSchema,
  genresSchema,
  keywordsSchema,
  movieCardSchema,
  movieDetailEnrichedSchema,
  movieOrTvSchema,
  movieSummarySchema,
  multiItemSchema,
  pageSchema,
  personCreditsSchema,
  personDetailSchema,
  personSummarySchema,
  reviewSchema,
  seasonSchema,
  tvCardSchema,
  tvDetailEnrichedSchema,
  tvSummarySchema,
  videosSchema,
  watchProvidersSchema,
} from "../format.schemas.js";
import { READ_ONLY, requireConfigured, trackStale } from "./shared.js";

const page = z
  .number()
  .int()
  .min(1)
  .max(500)
  .describe(
    "1-based page number for pagination (TMDB returns up to 20 results per page, max 500).",
  );
const tmdbId = z.number().int().positive().describe("TMDB numeric id.");
const mediaKind = z.enum(["movie", "tv"]).describe("Media type: 'movie' or 'tv'.");
// TMDB's own fixed department vocabulary for crew jobs (from
// /configuration/jobs, verified live — stable reference data, not something
// tmdb-mcp invents). get_person_credits' department filter uses this.
const PERSON_DEPARTMENTS = [
  "Directing",
  "Writing",
  "Production",
  "Camera",
  "Editing",
  "Sound",
  "Art",
  "Costume & Make-Up",
  "Visual Effects",
  "Crew",
  "Lighting",
  "Actors",
] as const;
const personDepartment = z
  .enum(PERSON_DEPARTMENTS)
  .describe(
    "Restrict crew credits to this department (e.g. 'Directing' for a director's filmography). " +
      "Without it, a multi-hyphenate's OTHER departments (writing, producing, …) compete for the " +
      "same 25-credit cap and can crowd out titles in the department you actually want.",
  )
  .optional();
const personCreditsLimit = z
  .number()
  .int()
  .min(1)
  .max(100)
  .describe(
    "Max cast entries and max crew entries to return (each capped separately; default 25). Raise " +
      "this for an exceptionally prolific person — e.g. a director with 50+ films — where even a " +
      "department filter still leaves more titles than the default cap keeps.",
  )
  .optional();
const includeAdult = z
  .boolean()
  .describe("Include adult (NSFW) results. Defaults to false.")
  .optional();
const includeRatings = z
  .boolean()
  .describe(
    "If true (default), enrich the result with IMDb/Rotten Tomatoes/Metacritic ratings plus an " +
      "awards summary (major-award wins/nominations — Oscars, Emmys, Golden Globes, etc., whatever " +
      "OMDb aggregates; free text, not a structured count, and describes the whole film/show, not " +
      "any one person's award) from OMDb (requires OMDB_API_KEY). Set false to skip the extra " +
      "lookup when ratings are not needed.",
  )
  .optional();
// get_movies/get_tv_shows: capped well under TMDB's own per-request limits
// (e.g. append_to_response's 20) since, unlike Steam's real batch endpoints,
// TMDB has no batch API at all — each id here is still its own upstream
// request under the hood (see docs/api-references.md), just fanned out
// concurrently through the same rate limiter every other call shares.
const movieIdsBatch = z
  .array(z.number().int().positive())
  .min(1)
  .max(20)
  .describe(
    "TMDB movie ids to fetch (1-20). Get them from search_movies/discover_movies/get_similar/" +
      "get_movie_recommendations/etc.",
  );
const tvIdsBatch = z
  .array(z.number().int().positive())
  .min(1)
  .max(20)
  .describe(
    "TMDB TV show ids to fetch (1-20). Get them from search_tv/discover_tv/get_similar/" +
      "get_tv_recommendations/etc.",
  );
const includeRatingsBatch = z
  .boolean()
  .describe(
    "If true, enrich every card with compact IMDb/Rotten Tomatoes/Metacritic ratings from OMDb " +
      "(requires OMDB_API_KEY) — one extra OMDb lookup per id, so a large batch means a burst of " +
      "OMDb calls; mind OMDb's own rate limit. Unlike get_movie/get_tv, defaults to false (off) here.",
  )
  .optional();

const expandEpisodes = z
  .boolean()
  .describe(
    "If true, also fetch every season's full episode list (name, air date, runtime, rating) as " +
      "`seasons_detail`, in one extra request — use this instead of calling get_tv_season once per " +
      "season when you need all episodes of a multi-season show. Episode overviews are omitted " +
      "here to keep that aggregate response usable — call get_tv_season for one season's full " +
      "detail including overview. Each season's episode list is capped at 50 (season 0 'Specials' " +
      "in particular can otherwise run to hundreds of bonus clips), and the combined count across " +
      "every season is capped at 250 total, and the whole aggregate additionally has a hard size " +
      "ceiling (trims further if episode names are unusually long) since a 30+ season show could " +
      "otherwise still exceed a usable response size even with the per-season cap alone; " +
      "`episode_count` on each season still reports that season's true total. Defaults to false.",
  )
  .optional();

const mediaType = z
  .enum(["movie", "tv"])
  .describe("Whether the id refers to a movie or a TV show.");
// The default named in the description must match the server's actual
// TMDB_REGION, so it's built per-server from config rather than hardcoded.
const regionSchema = (defaultRegion: string) =>
  z
    .string()
    .regex(/^[A-Z]{2}$/, "Use a two-letter ISO-3166-1 country code, e.g. 'US'.")
    .describe(`ISO-3166-1 country code for region-specific results (default '${defaultRegion}').`)
    .optional();
const sortBy = z
  .string()
  .describe("TMDB sort, e.g. 'popularity.desc', 'vote_average.desc', 'primary_release_date.desc'.")
  .optional();
const withGenres = z
  .string()
  .describe("Comma-separated TMDB genre ids (AND); get ids from get_movie_genres/get_tv_genres.")
  .optional();
const language = z
  .string()
  .regex(
    LANGUAGE_REGEX,
    "Use an ISO-639-1 language code, optionally with a region, e.g. 'en' or 'en-US'.",
  )
  .describe(
    "Override the response language (ISO-639-1, optionally with a region), e.g. 'ru-RU' or 'en-US'. " +
      "Localizes titles/overviews/genre names. Defaults to the server's TMDB_LANGUAGE.",
  )
  .optional();
// TMDB's with_original_language discover filter, unlike `language` above,
// takes a plain ISO-639-1 code with no region suffix.
const originalLanguageRegex = /^[a-z]{2}$/;
const idList = (what: string) =>
  z.string().describe(`Comma-separated TMDB ${what} ids.`).optional();
const dateStr = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date YYYY-MM-DD.")
    .describe(what)
    .optional();
const discoverShared = {
  sort_by: sortBy,
  with_genres: withGenres,
  without_genres: z.string().describe("Comma-separated TMDB genre ids to exclude.").optional(),
  year: z.number().int().min(1870).max(2100).describe("Release / first-air year.").optional(),
  release_date_gte: dateStr("Only entries released on/after this date (YYYY-MM-DD)."),
  release_date_lte: dateStr("Only entries released on/before this date (YYYY-MM-DD)."),
  min_rating: z
    .number()
    .min(0)
    .max(10)
    .describe("Minimum vote average (0-10). Must be <= max_rating if both are given.")
    .optional(),
  max_rating: z.number().min(0).max(10).describe("Maximum vote average (0-10).").optional(),
  min_votes: z
    .number()
    .int()
    .min(0)
    .describe("Minimum vote count (filters obscure titles).")
    .optional(),
  min_runtime: z.number().int().min(0).describe("Minimum runtime in minutes.").optional(),
  max_runtime: z.number().int().min(0).describe("Maximum runtime in minutes.").optional(),
  with_original_language: z
    .string()
    .regex(
      originalLanguageRegex,
      "Use a plain ISO-639-1 language code with no region, e.g. 'en' or 'ja'.",
    )
    .describe("ISO-639-1 original-language code, e.g. 'en', 'ja'.")
    .optional(),
  with_companies: z
    .string()
    .describe(
      "Comma-separated TMDB production company ids (use search_companies to resolve names → ids).",
    )
    .optional(),
  with_keywords: z
    .string()
    .describe("Comma-separated TMDB keyword ids (use search_keywords to resolve names → ids).")
    .optional(),
  without_keywords: idList("keyword to exclude"),
  with_watch_providers: z
    .string()
    .describe(
      "Comma-separated TMDB watch-provider ids (e.g. Netflix's numeric id); requires " +
        "watch_region to also be set.",
    )
    .optional(),
  watch_region: z
    .string()
    .regex(/^[A-Z]{2}$/, "Two-letter ISO-3166-1 country code.")
    .describe("Country for with_watch_providers, e.g. 'US'.")
    .optional(),
  // Shared, not movie-only: verified live against the real /discover/tv (not
  // just /discover/movie) — an unsupported/nonsense certification value
  // returns zero results there too, confirming TMDB actually applies it
  // rather than silently ignoring an undocumented param.
  certification: z
    .string()
    .describe(
      "Filter by exact age/content certification, e.g. 'PG-13' (movies) or 'TV-Y7' (TV). Requires " +
        "certification_country, and a certification_country TMDB doesn't recognize silently " +
        "disables this filter (returns unfiltered results) instead of erroring or matching nothing " +
        "— double-check the country actually has data for that rating system. Case-sensitive for " +
        "movies ('pg-13' matches nothing; use 'PG-13'). Unlike get_movie/get_tv's own certification " +
        "field (which falls back to the US rating, then any country, when the requested region has " +
        "none), this filter has NO fallback: a title with no certification entry at all for the " +
        "exact country given is silently excluded from results, even if it's certified elsewhere " +
        "(e.g. has a US rating) — for a country with sparse TMDB certification data, prefer " +
        "certification_country='US' for broader, more reliable coverage over the user's actual " +
        "country if completeness matters more than exact local ratings.",
    )
    .optional(),
  certification_country: z
    .string()
    .regex(/^[A-Z]{2}$/, "Two-letter ISO-3166-1 country code.")
    .describe("Country whose certification system the `certification` filter uses, e.g. 'US'.")
    .optional(),
  language,
  page: page.optional(),
};

// Movie discover adds cast/crew/people filters.
const discoverMovieSchema = {
  ...discoverShared,
  with_cast: idList("cast (actor)"),
  with_crew: idList("crew, e.g. a director"),
  with_people: idList("person (cast or crew)"),
};

// TMDB's own fixed vocabularies for a TV show's type/status (verified live
// against the real /discover/tv query values — not something tmdb-mcp
// invents). Exported so clients/tmdb.ts's discoverQuery can translate the
// human-readable name this schema asks for into the numeric code TMDB's
// query actually expects.
export const TV_TYPES = [
  "Documentary",
  "News",
  "Miniseries",
  "Reality",
  "Scripted",
  "Talk Show",
  "Video",
] as const;
export const TV_STATUSES = [
  "Returning Series",
  "Planned",
  "In Production",
  "Ended",
  "Cancelled",
  "Pilot",
] as const;

// TV discover adds network/type/status filtering.
const discoverTvSchema = {
  ...discoverShared,
  with_networks: idList("TV network, e.g. HBO or Netflix"),
  with_type: z
    .enum(TV_TYPES)
    .describe(
      "Restrict to this TV type — e.g. 'Miniseries' for short/limited series, excluding " +
        "documentaries/reality/talk shows/etc. that would otherwise mix into a genre/rating search.",
    )
    .optional(),
  with_status: z
    .enum(TV_STATUSES)
    .describe(
      "Restrict to this production status, e.g. 'Ended' to exclude shows still airing (a still-" +
        "airing show's later seasons could still be mediocre or unfinished).",
    )
    .optional(),
};

// clients/tmdb.ts's DiscoverParams is z.infer'd from this merged shape
// instead of a hand-duplicated interface, so adding a field to either variant
// above automatically extends it — DISCOVER_FIELD_MAP (clients/tmdb.ts)
// still forces a compile error if the new field has no TMDB query-key mapping.
export const discoverParamsSchema = z.object({ ...discoverMovieSchema, ...discoverTvSchema });
export type DiscoverParams = z.infer<typeof discoverParamsSchema>;

// TMDB silently ignores certification/with_watch_providers when their required
// pair field is missing, instead of erroring — which reads as "the filter was
// applied" when it wasn't. Catch that here instead of round-tripping to TMDB.
function checkDiscoverFilterPairs(
  val: {
    min_rating?: number;
    max_rating?: number;
    with_watch_providers?: string;
    watch_region?: string;
    certification?: string;
    certification_country?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    val.min_rating !== undefined &&
    val.max_rating !== undefined &&
    val.min_rating > val.max_rating
  ) {
    ctx.addIssue({
      code: "custom",
      message: "min_rating must be <= max_rating.",
      path: ["min_rating"],
    });
  }
  if (val.with_watch_providers !== undefined && val.watch_region === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "with_watch_providers requires watch_region to also be set.",
      path: ["with_watch_providers"],
    });
  }
  if (val.certification !== undefined && val.certification_country === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "certification requires certification_country to also be set.",
      path: ["certification"],
    });
  }
}

const discoverMovieInputSchema = z
  .object(discoverMovieSchema)
  .strict()
  .superRefine(checkDiscoverFilterPairs);
const discoverTvInputSchema = z
  .object(discoverTvSchema)
  .strict()
  .superRefine(checkDiscoverFilterPairs);

export function registerTmdbTools(
  server: McpServer,
  tmdb: TmdbClient,
  omdb: OmdbClient,
  config: Pick<Config, "tmdbRegion">,
): void {
  // Every TMDB tool needs the token; short-circuit with one clear message
  // instead of letting each call round-trip to a 401.
  const requireTmdb = <T extends Record<string, unknown>>(
    fn: () => Promise<T>,
    getMeta?: () => Record<string, unknown> | undefined,
  ) => requireConfigured(tmdb, fn, undefined, getMeta);
  const region = regionSchema(config.tmdbRegion);

  // ---- search ---------------------------------------------------------------

  server.registerTool(
    "search_movies",
    {
      title: "Search movies",
      description:
        "Search TMDB movies by title; returns compact summaries with the TMDB id that the other " +
        "movie tools (get_movie, get_movie_credits, …) require, plus pagination info. Use this over " +
        "search_multi when you already know the result is a movie.",
      inputSchema: z
        .object({
          query: z.string().min(1).describe("Movie title to search for."),
          year: z.number().int().min(1870).max(2100).describe("Filter by release year.").optional(),
          include_adult: includeAdult,
          language,
          region,
          page: page.optional(),
        })
        .strict(),
      outputSchema: pageSchema(movieSummarySchema),
      annotations: READ_ONLY,
    },
    (args, ctx) => requireTmdb(() => tmdb.searchMovies(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "search_tv",
    {
      title: "Search TV shows",
      description:
        "Search TMDB TV shows by name; returns compact summaries with the TMDB id that get_tv and " +
        "the other TV tools require. Use this over search_multi when you already know the result is " +
        "a TV show.",
      inputSchema: z
        .object({
          query: z.string().min(1).describe("TV show name to search for."),
          year: z
            .number()
            .int()
            .min(1870)
            .max(2100)
            .describe("Filter by first-air-date year.")
            .optional(),
          include_adult: includeAdult,
          language,
          page: page.optional(),
        })
        .strict(),
      outputSchema: pageSchema(tvSummarySchema),
      annotations: READ_ONLY,
    },
    (args, ctx) => requireTmdb(() => tmdb.searchTv(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "search_multi",
    {
      title: "Search everything",
      description:
        "Search movies, TV shows and people in one call. Each result carries a media_type " +
        "('movie' | 'tv' | 'person') so you can route to the right get_* tool. Use when the user's " +
        "query could be any of these; if you already know the type, search_movies/search_tv/" +
        "search_people are more precise.",
      inputSchema: z
        .object({
          query: z.string().min(1).describe("Free-text query."),
          include_adult: includeAdult,
          language,
          page: page.optional(),
        })
        .strict(),
      outputSchema: pageSchema(multiItemSchema),
      annotations: READ_ONLY,
    },
    (args, ctx) => requireTmdb(() => tmdb.searchMulti(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "search_people",
    {
      title: "Search people",
      description:
        "Search TMDB people (actors, directors, crew) by name; returns the TMDB id needed by " +
        "get_person plus their top 5 best-known titles (known_for). Use this over search_multi when " +
        "you already know the result is a person.",
      inputSchema: z
        .object({
          query: z.string().min(1).describe("Person name to search for."),
          include_adult: includeAdult,
          language,
          page: page.optional(),
        })
        .strict(),
      outputSchema: pageSchema(personSummarySchema),
      annotations: READ_ONLY,
    },
    (args, ctx) => requireTmdb(() => tmdb.searchPeople(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "search_keywords",
    {
      title: "Search keywords",
      description:
        "Resolve keyword names to TMDB keyword ids (e.g. 'time travel', 'based on true story'). " +
        "Feed the ids into discover_movies/discover_tv via with_keywords / without_keywords.",
      inputSchema: z
        .object({
          query: z.string().min(1).describe("Keyword text to look up."),
          page: page.optional(),
        })
        .strict(),
      outputSchema: keywordsSchema,
      annotations: READ_ONLY,
    },
    ({ query, page: pg }, ctx) =>
      requireTmdb(() => tmdb.searchKeywords(query, pg, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "search_companies",
    {
      title: "Search production companies",
      description:
        "Resolve a production company's name to its TMDB numeric id (e.g. 'A24', 'Pixar'). Feed the " +
        "id into discover_movies/discover_tv via with_companies. Company names aren't unique — TMDB " +
        "can have several unrelated companies sharing the same name (e.g. two different 'A24's, one " +
        "US and one GB) — check origin_country and logo_url to tell rows apart when a name matches " +
        "more than one.",
      inputSchema: z
        .object({
          query: z.string().min(1).describe("Company name to look up."),
          page: page.optional(),
        })
        .strict(),
      outputSchema: pageSchema(companySchema),
      annotations: READ_ONLY,
    },
    ({ query, page: pg }, ctx) =>
      requireTmdb(() => tmdb.searchCompanies(query, pg, ctx.mcpReq.signal)),
  );

  // ---- details --------------------------------------------------------------

  server.registerTool(
    "get_movie",
    {
      title: "Get movie details",
      description:
        "Get full details for one movie by TMDB id: overview, genres, runtime, budget/revenue, " +
        "vote average, the age/content rating (certification) for `region` — falling back to the " +
        "US rating, then any available country, when `region` has none; check `certification_region` " +
        "to see which one was used — and links (TMDB + IMDb). " +
        "By default also includes IMDb/Rotten Tomatoes/Metacritic ratings, an awards summary " +
        "(major-award wins/nominations — Oscars, Emmys, Golden Globes, etc.; free text, not a " +
        "structured count, for the whole film/show, not one person), and OMDb's own age rating " +
        "(`ratings.rated` — separate from this tool's own `certification` above; the two can differ) " +
        "from OMDb (set include_ratings=false to skip); if unavailable (no OMDB_API_KEY, no imdb_id, or the " +
        "OMDb lookup fails), `ratings` degrades to `{found:false, reason}` instead of failing the " +
        "call. If you only need the headline info (title/year/genres/vote average) — for one id or " +
        "several — use get_movies instead; it's trimmed on purpose and skips the rest of this " +
        "payload. Get the id from search_movies.",
      inputSchema: z
        .object({ id: tmdbId, region, language, include_ratings: includeRatings })
        .strict(),
      outputSchema: movieDetailEnrichedSchema,
      annotations: READ_ONLY,
    },
    ({ id, region: r, language: lang, include_ratings }) => {
      const stale = trackStale();
      return requireTmdb(
        () =>
          getEnrichedDetail(
            "movie",
            id,
            r,
            lang,
            include_ratings ?? true,
            tmdb,
            omdb,
            false,
            stale.onStale,
          ),
        stale.meta,
      );
    },
  );

  server.registerTool(
    "get_tv",
    {
      title: "Get TV show details",
      description:
        "Get full details for one TV show by TMDB id: overview, genres, seasons/episodes counts, " +
        "networks, status, the age/content rating (certification) for `region` — falling back to " +
        "the US rating, then any available country, when `region` has none; check " +
        "`certification_region` to see which one was used — and links. " +
        "By default also includes IMDb/Rotten Tomatoes/Metacritic ratings, an awards summary " +
        "(major-award wins/nominations — Oscars, Emmys, Golden Globes, etc.; free text, not a " +
        "structured count, for the whole film/show, not one person), and OMDb's own age rating " +
        "(`ratings.rated` — separate from this tool's own `certification` above; the two can differ) " +
        "from OMDb (set include_ratings=false to skip); if unavailable (no OMDB_API_KEY, no imdb_id, or the " +
        "OMDb lookup fails), `ratings` degrades to `{found:false, reason}` instead of failing the " +
        "call. Set expand_episodes=true to also pull every season's episode list in one extra " +
        "request instead of calling get_tv_season per season. If you only need the headline info " +
        "(name/year/genres/vote average, season/episode counts) — for one id or several — use " +
        "get_tv_shows instead; it's trimmed on purpose and skips the rest of this payload. Get the " +
        "id from search_tv.",
      inputSchema: z
        .object({
          id: tmdbId,
          region,
          language,
          include_ratings: includeRatings,
          expand_episodes: expandEpisodes,
        })
        .strict(),
      outputSchema: tvDetailEnrichedSchema,
      annotations: READ_ONLY,
    },
    ({ id, region: r, language: lang, include_ratings, expand_episodes }) => {
      const stale = trackStale();
      return requireTmdb(
        () =>
          getEnrichedDetail(
            "tv",
            id,
            r,
            lang,
            include_ratings ?? true,
            tmdb,
            omdb,
            expand_episodes ?? false,
            stale.onStale,
          ),
        stale.meta,
      );
    },
  );

  server.registerTool(
    "get_movies",
    {
      title: "Get compact movie card(s)",
      description:
        "Get a compact card — title, year, genres, vote average, and (opt-in) ratings — for 1-20 " +
        "movies by TMDB id in one call. Deliberately trimmed (no overview, cast, budget, " +
        "certifications, production companies, etc.): use this for a single id too when you only " +
        "need that headline info and not the full get_movie payload, not just for checking many at " +
        "once. Call get_movie instead when you need the full details for a title. A bad/unknown id " +
        "never fails the whole call — that entry comes back `{id, found:false, reason}` instead, in " +
        "the same order as `ids`.",
      inputSchema: z
        .object({ ids: movieIdsBatch, region, language, include_ratings: includeRatingsBatch })
        .strict(),
      outputSchema: z.object({ results: z.array(movieCardSchema) }).strict(),
      annotations: READ_ONLY,
    },
    ({ ids, region: r, language: lang, include_ratings }) => {
      const stale = trackStale();
      return requireTmdb(async () => {
        const settled = await Promise.allSettled(
          ids.map((id) =>
            getEnrichedDetail(
              "movie",
              id,
              r,
              lang,
              include_ratings ?? false,
              tmdb,
              omdb,
              false,
              stale.onStale,
            ),
          ),
        );
        return {
          results: settled.map((result, i) =>
            result.status === "fulfilled"
              ? movieCard(result.value)
              : notFoundCard(ids[i]!, errorReason(result.reason)),
          ),
        };
      }, stale.meta);
    },
  );

  server.registerTool(
    "get_tv_shows",
    {
      title: "Get compact TV show card(s)",
      description:
        "Get a compact card — name, year, genres, vote average, season/episode counts, and (opt-in) " +
        "ratings — for 1-20 TV shows by TMDB id in one call. A quick way to spot short/miniseries " +
        "shows (low episode count) across many candidates without a per-title get_tv call. " +
        "Deliberately trimmed otherwise (no overview, the actual episode list, networks, " +
        "certifications, etc.): use this for a single id too when you only need that headline info " +
        "and not the full get_tv payload, not just for checking many at once. Call get_tv instead " +
        "when you need the full details for a title. A bad/unknown id never fails the whole call — " +
        "that entry comes back `{id, found:false, reason}` instead, in the same order as `ids`.",
      inputSchema: z
        .object({ ids: tvIdsBatch, region, language, include_ratings: includeRatingsBatch })
        .strict(),
      outputSchema: z.object({ results: z.array(tvCardSchema) }).strict(),
      annotations: READ_ONLY,
    },
    ({ ids, region: r, language: lang, include_ratings }) => {
      const stale = trackStale();
      return requireTmdb(async () => {
        const settled = await Promise.allSettled(
          ids.map((id) =>
            getEnrichedDetail(
              "tv",
              id,
              r,
              lang,
              include_ratings ?? false,
              tmdb,
              omdb,
              false,
              stale.onStale,
            ),
          ),
        );
        return {
          results: settled.map((result, i) =>
            result.status === "fulfilled"
              ? tvCard(result.value)
              : notFoundCard(ids[i]!, errorReason(result.reason)),
          ),
        };
      }, stale.meta);
    },
  );

  server.registerTool(
    "get_person",
    {
      title: "Get person details",
      description:
        "Get full details for one person by TMDB id: biography, birthday/deathday, department, and " +
        "links (TMDB + IMDb). Does not include filmography — use get_person_credits for that. Get " +
        "the id from search_people or a credits list.",
      inputSchema: z.object({ id: tmdbId, language }).strict(),
      outputSchema: personDetailSchema,
      annotations: READ_ONLY,
    },
    ({ id, language: lang }) => {
      const stale = trackStale();
      return requireTmdb(() => tmdb.getPerson(id, lang, stale.onStale), stale.meta);
    },
  );

  server.registerTool(
    "get_movie_credits",
    {
      title: "Get movie cast & crew",
      description:
        "List the top-billed cast (up to 20) and the headline crew (director, writers, composer, " +
        "DoP, …) of a movie by TMDB id. Get the id from search_movies.",
      inputSchema: z.object({ id: tmdbId }).strict(),
      outputSchema: creditsSchema,
      annotations: READ_ONLY,
    },
    ({ id }) => {
      const stale = trackStale();
      return requireTmdb(() => tmdb.getMovieCredits(id, undefined, stale.onStale), stale.meta);
    },
  );

  server.registerTool(
    "get_tv_credits",
    {
      title: "Get TV cast & crew",
      description:
        "List the main cast (up to 20) and headline crew (creators, writers, …) of a TV show by " +
        "TMDB id. Get the id from search_tv.",
      inputSchema: z.object({ id: tmdbId }).strict(),
      outputSchema: creditsSchema,
      annotations: READ_ONLY,
    },
    ({ id }) => {
      const stale = trackStale();
      return requireTmdb(() => tmdb.getTvCredits(id, undefined, stale.onStale), stale.meta);
    },
  );

  server.registerTool(
    "get_movie_recommendations",
    {
      title: "Get movie recommendations",
      description:
        "Get movies TMDB recommends for the given movie id, based on co-viewing/personalization " +
        "data (what users who liked this also liked) — usually the more thematically relevant " +
        "list. Prefer this over get_similar as the default choice; get_similar matches on shared " +
        "genres/keywords, a blunter heuristic that can surface tonally unrelated titles. Get the " +
        "id from search_movies.",
      inputSchema: z.object({ id: tmdbId, page: page.optional() }).strict(),
      outputSchema: pageSchema(movieSummarySchema),
      annotations: READ_ONLY,
    },
    ({ id, page: pg }, ctx) =>
      requireTmdb(() => tmdb.getRecommendations("movie", id, pg, undefined, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "get_tv_recommendations",
    {
      title: "Get TV recommendations",
      description:
        "Get TV shows TMDB recommends for the given show id, based on co-viewing/personalization " +
        "data (what users who liked this also liked) — usually the more thematically relevant " +
        "list. Prefer this over get_similar as the default choice; get_similar matches on shared " +
        "genres/keywords, a blunter heuristic that can surface tonally unrelated titles. Get the " +
        "id from search_tv.",
      inputSchema: z.object({ id: tmdbId, page: page.optional() }).strict(),
      outputSchema: pageSchema(tvSummarySchema),
      annotations: READ_ONLY,
    },
    ({ id, page: pg }, ctx) =>
      requireTmdb(() => tmdb.getRecommendations("tv", id, pg, undefined, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "get_similar",
    {
      title: "Get similar titles",
      description:
        "Get titles TMDB considers similar to a given movie or TV show, based on shared genres " +
        "and keywords — a blunter heuristic than get_movie_recommendations'/get_tv_recommendations' " +
        "behavioral (co-viewing) data, so results can still be thematically noisy (matching on a " +
        "shared keyword despite an unrelated tone or plot). Results sharing only the source title's " +
        "broadest genre (e.g. two titles that are both merely tagged 'Drama' among several genres) " +
        "are filtered out per page, since a title with a common genre can otherwise return results " +
        "spanning TMDB's entire catalog; a page can come back thin or empty for a niche title once " +
        "that filter applies. Try recommendations first for thematically closer picks; use this when " +
        "you specifically want genre/keyword-adjacent titles. Get the id from search_movies/search_tv.",
      inputSchema: z.object({ media_type: mediaKind, id: tmdbId, page: page.optional() }).strict(),
      outputSchema: pageSchema(movieOrTvSchema),
      annotations: READ_ONLY,
    },
    ({ media_type, id, page: pg }, ctx) =>
      requireTmdb(() => tmdb.getSimilar(media_type, id, pg, undefined, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "get_reviews",
    {
      title: "Get user reviews",
      description:
        "Get user reviews for a movie or TV show (author, their rating, and the review text, " +
        "clipped to ~1500 characters). Get the id from search_movies/search_tv.",
      inputSchema: z.object({ media_type: mediaKind, id: tmdbId, page: page.optional() }).strict(),
      outputSchema: pageSchema(reviewSchema),
      annotations: READ_ONLY,
    },
    ({ media_type, id, page: pg }, ctx) =>
      requireTmdb(() => tmdb.getReviews(media_type, id, pg, undefined, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "get_collection",
    {
      title: "Get a movie collection",
      description:
        "Get a movie collection/franchise and all its parts in release order (e.g. the whole " +
        "'The Dark Knight Collection'). Get the collection id from a movie's `collection` field in get_movie.",
      inputSchema: z.object({ id: tmdbId, language: language.optional() }).strict(),
      outputSchema: collectionSchema,
      annotations: READ_ONLY,
    },
    ({ id, language: lang }) => {
      const stale = trackStale();
      return requireTmdb(() => tmdb.getCollection(id, lang, stale.onStale), stale.meta);
    },
  );

  // ---- discovery ------------------------------------------------------------

  server.registerTool(
    "get_trending",
    {
      title: "Get trending titles",
      description:
        "Get what's trending on TMDB. media_type selects movies, TV, people, or all; time_window " +
        "is the trending period (today vs this week). Good for 'what's popular right now'. Each " +
        "result row carries its own media_type ('movie' | 'tv' | 'person') — check it to route to " +
        "the right get_* tool, especially when media_type is left at 'all'.",
      inputSchema: z
        .object({
          media_type: z
            .enum(["all", "movie", "tv", "person"])
            .describe("Which kind of entity to rank. Defaults to 'all'.")
            .optional(),
          time_window: z
            .enum(["day", "week"])
            .describe("Trending period: 'day' or 'week'. Defaults to 'week'.")
            .optional(),
          page: page.optional(),
        })
        .strict(),
      outputSchema: pageSchema(multiItemSchema),
      annotations: READ_ONLY,
    },
    ({ media_type, time_window, page: pg }) =>
      requireTmdb(() => tmdb.getTrending(media_type ?? "all", time_window ?? "week", pg)),
  );

  server.registerTool(
    "get_movie_genres",
    {
      title: "List movie genres",
      description:
        "List TMDB movie genres with their numeric ids and names (reference data; rarely changes). " +
        "Feed the ids into discover_movies' with_genres/without_genres.",
      inputSchema: z.object({}).strict(),
      outputSchema: genresSchema,
      annotations: READ_ONLY,
    },
    () => {
      const stale = trackStale();
      return requireTmdb(() => tmdb.getGenres("movie", undefined, stale.onStale), stale.meta);
    },
  );

  server.registerTool(
    "get_tv_genres",
    {
      title: "List TV genres",
      description:
        "List TMDB TV genres with their numeric ids and names (reference data; rarely changes). " +
        "Feed the ids into discover_tv's with_genres/without_genres.",
      inputSchema: z.object({}).strict(),
      outputSchema: genresSchema,
      annotations: READ_ONLY,
    },
    () => {
      const stale = trackStale();
      return requireTmdb(() => tmdb.getGenres("tv", undefined, stale.onStale), stale.meta);
    },
  );

  // ---- discover -------------------------------------------------------------

  server.registerTool(
    "discover_movies",
    {
      title: "Discover movies (filters)",
      description:
        "Find movies by structured filters instead of a title query: genres (include/exclude), " +
        "year or release-date range, rating range, vote count, runtime range, original language, " +
        "cast/crew/people, companies, keywords, watch providers, certification, and sort order. " +
        "certification and with_watch_providers each error if given with no certification_country/" +
        "watch_region at all, but an unrecognized certification_country still silently disables the " +
        "filter instead of erroring — see certification's own description. Use for " +
        "'popular sci-fi from the 1990s rated above 7 available on Netflix', or for a specific " +
        "person's work in one genre — 'which of this director's/actor's/composer's films are " +
        "animated' — via with_crew/with_cast/with_people + with_genres together; get_person_credits " +
        "has no genre filter, so this combination is the right tool for that question, not that one. " +
        "Resolve ids with get_movie_genres, search_people, search_keywords, search_companies.",
      inputSchema: discoverMovieInputSchema,
      outputSchema: pageSchema(movieSummarySchema),
      annotations: READ_ONLY,
    },
    (args, ctx) => requireTmdb(() => tmdb.discover("movie", args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "discover_tv",
    {
      title: "Discover TV shows (filters)",
      description:
        "Find TV shows by structured filters (genres, first-air year or date range, rating range, " +
        "vote count, runtime, language, companies, networks, keywords, watch providers, type, " +
        "status, certification, sort) — but NOT cast/crew/person: this tool doesn't accept those " +
        "params for TV at all (calling with them is a validation error, not a silent no-op) " +
        "because TMDB's own /discover/tv would silently ignore them anyway, unlike /discover/movie; " +
        "to find TV shows featuring someone, call get_person_credits instead and filter its results " +
        "to media_type 'tv'. certification and " +
        "with_watch_providers each error if given with no certification_country/watch_region at " +
        "all, but an unrecognized certification_country still silently disables the filter instead " +
        "of erroring — see certification's own description. The TV counterpart of discover_movies; " +
        "use with_networks for 'HBO shows', with_type='Miniseries' for short/limited series (e.g. " +
        "'best miniseries to binge in a weekend'), with_status='Ended' to exclude shows still " +
        "airing, certification='TV-Y7' + certification_country='US' for 'shows appropriate for a " +
        "young kid'.",
      inputSchema: discoverTvInputSchema,
      outputSchema: pageSchema(tvSummarySchema),
      annotations: READ_ONLY,
    },
    (args, ctx) => requireTmdb(() => tmdb.discover("tv", args, ctx.mcpReq.signal)),
  );

  // ---- watch providers ------------------------------------------------------

  server.registerTool(
    "get_watch_providers",
    {
      title: "Where to watch",
      description:
        "Find where a movie or TV show can be streamed, rented or bought in a given country " +
        "(JustWatch data via TMDB). Returns provider names per access type for that country; if it " +
        "has no data, returns `available:false` plus `available_regions` to retry with. Get the id " +
        "from search_movies/search_tv.",
      inputSchema: z
        .object({
          media_type: mediaType,
          id: tmdbId,
          region,
        })
        .strict(),
      outputSchema: watchProvidersSchema,
      annotations: READ_ONLY,
    },
    ({ media_type, id, region: r }) => {
      const stale = trackStale();
      return requireTmdb(
        () => tmdb.getWatchProviders(media_type, id, r, stale.onStale),
        stale.meta,
      );
    },
  );

  // ---- person filmography ---------------------------------------------------

  server.registerTool(
    "get_person_credits",
    {
      title: "Get person filmography",
      description:
        "List the movies and TV shows a person is known for (cast roles and crew jobs), most " +
        "popular first, capped to the top 25 of each by default; talk-show/awards-show guest " +
        "appearances ('Self'/'Himself'/'Herself') and repeat entries for the same title are excluded " +
        "so the list stays about actual roles. A title with several crew jobs (writer AND director " +
        "AND producer on one film) still only counts once against the crew cap. Cast entries " +
        "include a vote_average; crew entries (director, writer, …) do not — call get_movie/get_tv " +
        "on the id for a crew credit's rating. Pass department (e.g. 'Directing') to restrict crew " +
        "to just that role — the reliable way to get someone's complete filmography in one " +
        "department when their other departments would otherwise compete for the same cap; for a " +
        "handful of exceptionally prolific people even that isn't enough (e.g. 50+ directing " +
        "credits), so raise `limit` too when department alone still looks short. Use for 'what has " +
        "this actor/director been in'. This tool has no genre filter — for 'which of X's movies are " +
        "animated/horror/etc.' use discover_movies instead, combining with_cast/with_crew/" +
        "with_people with with_genres (discover_tv has no equivalent — it can't filter by person at " +
        "all — so for a person's TV work in one genre, call this tool and check the returned " +
        "media_type 'tv' entries' genres yourself, e.g. via get_tv_shows). Get the id from " +
        "search_people.",
      inputSchema: z
        .object({ id: tmdbId, department: personDepartment, limit: personCreditsLimit })
        .strict(),
      outputSchema: personCreditsSchema,
      annotations: READ_ONLY,
    },
    ({ id, department, limit }) => {
      const stale = trackStale();
      return requireTmdb(
        () => tmdb.getPersonCredits(id, department, limit, undefined, stale.onStale),
        stale.meta,
      );
    },
  );

  // ---- videos / trailers ----------------------------------------------------

  server.registerTool(
    "get_videos",
    {
      title: "Get trailers & videos",
      description:
        "List trailers, teasers and clips for a movie or TV show; YouTube entries include a " +
        "watch URL. Get the id from search_movies/search_tv.",
      inputSchema: z.object({ media_type: mediaType, id: tmdbId }).strict(),
      outputSchema: videosSchema,
      annotations: READ_ONLY,
    },
    ({ media_type, id }) => {
      const stale = trackStale();
      return requireTmdb(
        () => tmdb.getVideos(media_type, id, undefined, stale.onStale),
        stale.meta,
      );
    },
  );

  // ---- reverse lookup -------------------------------------------------------

  server.registerTool(
    "find_by_imdb_id",
    {
      title: "Find by IMDb id",
      description:
        "Resolve an IMDb id (e.g. 'tt0133093') to TMDB entities — returns matching movie, TV and " +
        "person results. Use when you only have an IMDb id and need the TMDB id for the other tools.",
      inputSchema: z
        .object({
          imdb_id: z
            .string()
            .regex(/^(tt|nm)\d+$/, "IMDb ids look like 'tt0133093' or 'nm0000206'.")
            .describe("IMDb title (tt…) or name (nm…) id."),
        })
        .strict(),
      outputSchema: findSchema,
      annotations: READ_ONLY,
    },
    ({ imdb_id }) => {
      const stale = trackStale();
      return requireTmdb(
        () => tmdb.findByExternalId(imdb_id, "imdb_id", stale.onStale),
        stale.meta,
      );
    },
  );

  // ---- TV deep dive ---------------------------------------------------------

  server.registerTool(
    "get_tv_season",
    {
      title: "Get TV season",
      description:
        "Get one season of a TV show (by show id + season number): overview and the episode list " +
        "with air dates, runtimes and ratings, capped at 50 episodes (`episode_count` reports the " +
        "true total). Season 0 is usually specials, which can run to hundreds of bonus clips on a " +
        "long-running show. Use get_tv with expand_episodes=true instead if you need every " +
        "season's episodes in one call. Get the show id from search_tv.",
      inputSchema: z
        .object({
          id: tmdbId,
          season_number: z.number().int().min(0).describe("Season number (0 = specials)."),
        })
        .strict(),
      outputSchema: seasonSchema,
      annotations: READ_ONLY,
    },
    ({ id, season_number }) => {
      const stale = trackStale();
      return requireTmdb(
        () => tmdb.getTvSeason(id, season_number, undefined, stale.onStale),
        stale.meta,
      );
    },
  );

  server.registerTool(
    "get_tv_episode",
    {
      title: "Get TV episode",
      description:
        "Get one episode of a TV show by show id + season number + episode number: overview, air " +
        "date, runtime, rating, guest stars (up to 15) and director/writer. Get the show id from " +
        "search_tv.",
      inputSchema: z
        .object({
          id: tmdbId,
          season_number: z.number().int().min(0).describe("Season number (0 = specials)."),
          episode_number: z.number().int().min(1).describe("Episode number within the season."),
        })
        .strict(),
      outputSchema: episodeSchema,
      annotations: READ_ONLY,
    },
    ({ id, season_number, episode_number }) => {
      const stale = trackStale();
      return requireTmdb(
        () => tmdb.getTvEpisode(id, season_number, episode_number, undefined, stale.onStale),
        stale.meta,
      );
    },
  );
}

/** get_movies/get_tv_shows: a rejected per-id fetch becomes that entry's `reason`. */
function errorReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** get_movie/get_tv's shared shape: fetch the TMDB detail, then fold in OMDb ratings. */
// Overloads narrow the return type by the mediaType literal — movieCard/tvCard
// (get_movies/get_tv_shows) each call this with a fixed "movie"/"tv" and need
// the matching single-shape result, not the movie|tv union the plain
// signature would otherwise give every caller regardless of which literal
// they passed.
async function getEnrichedDetail(
  mediaType: "movie",
  id: number,
  region: string | undefined,
  language: string | undefined,
  wantRatings: boolean,
  tmdb: TmdbClient,
  omdb: OmdbClient,
  expandEpisodes?: boolean,
  onStale?: () => void,
): Promise<z.infer<typeof movieDetailEnrichedSchema>>;
async function getEnrichedDetail(
  mediaType: "tv",
  id: number,
  region: string | undefined,
  language: string | undefined,
  wantRatings: boolean,
  tmdb: TmdbClient,
  omdb: OmdbClient,
  expandEpisodes?: boolean,
  onStale?: () => void,
): Promise<z.infer<typeof tvDetailEnrichedSchema>>;
async function getEnrichedDetail(
  mediaType: "movie" | "tv",
  id: number,
  region: string | undefined,
  language: string | undefined,
  wantRatings: boolean,
  tmdb: TmdbClient,
  omdb: OmdbClient,
  expandEpisodes = false,
  onStale?: () => void,
): Promise<
  Awaited<ReturnType<TmdbClient["getDetailWithImdb"]>>["shaped"] & {
    ratings?: ReturnType<typeof summarizeRatings>;
  }
> {
  const { shaped, imdbId } = await tmdb.getDetailWithImdb(
    mediaType,
    id,
    region,
    language,
    expandEpisodes,
    onStale,
  );
  return maybeEnrich(shaped, imdbId, wantRatings, omdb, onStale);
}

/** Attach OMDb ratings to a TMDB detail object when requested and possible. */
export async function maybeEnrich<T extends Record<string, unknown>>(
  shaped: T,
  imdbId: string | null,
  wantRatings: boolean,
  omdb: OmdbClient,
  onStale?: () => void,
): Promise<T & { ratings?: ReturnType<typeof summarizeRatings> }> {
  if (!wantRatings) return shaped;
  if (!omdb.configured) {
    return { ...shaped, ratings: { found: false, reason: "OMDB_API_KEY not configured" } };
  }
  if (!imdbId) {
    return { ...shaped, ratings: { found: false, reason: "No imdb_id available from TMDB" } };
  }
  // OMDb failures must not sink the TMDB result; degrade to found:false.
  try {
    const ratings = await omdb.ratingsByImdbId(imdbId, onStale);
    return { ...shaped, ratings };
  } catch {
    return { ...shaped, ratings: { found: false, reason: "OMDb lookup failed" } };
  }
}
