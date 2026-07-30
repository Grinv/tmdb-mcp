// Finding titles by criteria rather than a known id/title: get_trending
// (what's popular right now), get_movie_genres/get_tv_genres (reference data
// feeding with_genres/without_genres below), and discover_movies/discover_tv
// (the actual structured-filter search). TV_TYPES/TV_STATUSES/DiscoverParams/
// discoverParamsSchema are exported for clients/tmdb.ts's discoverQuery — see
// AGENTS.md's Conventions section for why that's a lower-layer file type-
// importing from this higher-layer one (intentional, erased at build).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  genresSchema,
  movieSummarySchema,
  multiItemSchema,
  pageSchema,
  tvSummarySchema,
} from "../../format.schemas.js";
import { READ_ONLY } from "../shared.js";
import { includeAdult, language, page, watchRegion, type TmdbToolDeps } from "./fields.js";

const SHARED_SORT_FIELDS = ["popularity", "vote_average", "vote_count"] as const;
const MOVIE_SORT_BY = [
  ...SHARED_SORT_FIELDS.flatMap((f) => [`${f}.asc`, `${f}.desc`] as const),
  "original_title.asc",
  "original_title.desc",
  "primary_release_date.asc",
  "primary_release_date.desc",
  "revenue.asc",
  "revenue.desc",
] as const;
const TV_SORT_BY = [
  ...SHARED_SORT_FIELDS.flatMap((f) => [`${f}.asc`, `${f}.desc`] as const),
  "name.asc",
  "name.desc",
  "first_air_date.asc",
  "first_air_date.desc",
] as const;
const withGenres = z
  .string()
  .describe("Comma-separated TMDB genre ids (AND); get ids from get_movie_genres/get_tv_genres.")
  .optional();
// TMDB's with_original_language discover filter, unlike `language` above,
// takes a plain ISO-639-1 code with no region suffix.
const originalLanguageRegex = /^[a-z]{2}$/;
const dateStr = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date YYYY-MM-DD.")
    .describe(what)
    .optional();
const discoverShared = {
  with_genres: withGenres,
  without_genres: z
    .string()
    .describe(
      "Comma-separated TMDB genre ids to exclude; get ids from get_movie_genres/get_tv_genres.",
    )
    .optional(),
  year: z.int().min(1870).max(2100).describe("Release / first-air year.").optional(),
  release_date_gte: dateStr("Only entries released on/after this date (YYYY-MM-DD)."),
  release_date_lte: dateStr("Only entries released on/before this date (YYYY-MM-DD)."),
  min_rating: z
    .number()
    .min(0)
    .max(10)
    .describe("Minimum vote average (0-10). Must be <= max_rating if both are given.")
    .optional(),
  max_rating: z.number().min(0).max(10).describe("Maximum vote average (0-10).").optional(),
  min_votes: z.int().min(0).describe("Minimum vote count (filters obscure titles).").optional(),
  min_runtime: z
    .int()
    .min(0)
    .describe("Minimum runtime in minutes. Must be <= max_runtime if both are given.")
    .optional(),
  max_runtime: z.int().min(0).describe("Maximum runtime in minutes.").optional(),
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
  without_keywords: z.string().describe("Comma-separated TMDB keyword ids to exclude.").optional(),
  with_watch_providers: z
    .string()
    .describe(
      "Comma-separated TMDB watch-provider ids (use search_watch_providers to resolve a " +
        "service name, e.g. 'Netflix', to its numeric id); requires watch_region to also be set.",
    )
    .optional(),
  watch_region: watchRegion.optional(),
  // Shared, not movie-only: verified live against the real /discover/tv (not
  // just /discover/movie) — an unsupported/nonsense certification value
  // returns zero results there too, confirming TMDB actually applies it
  // rather than silently ignoring an undocumented param.
  //
  // The opposite case — an unrecognized certification_country — is a silent
  // no-op instead: verified live against /discover/movie, pairing a real
  // certification ("PG-13") with a nonsense certification_country ("ZZ")
  // returned a total_results count matching the fully-unfiltered call
  // (~1.16M either way), not the ~10K a real US-certification-country filter
  // returns, confirming the filter is disabled rather than applied-and-empty.
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
  // Verified live against both /discover/movie and /discover/tv: unlike
  // region below, this measurably changes the result set on both endpoints
  // (a five/six-figure swing in total_results with no other filters at all).
  include_adult: includeAdult,
  page: page.optional(),
};

// Movie discover adds cast/crew/people filters.
const discoverMovieSchema = {
  ...discoverShared,
  sort_by: z
    .enum(MOVIE_SORT_BY)
    .describe("Sort order. Defaults to TMDB's own default (roughly popularity-based) if omitted.")
    .optional(),
  with_cast: z
    .string()
    .describe(
      "Comma-separated TMDB person ids, restricted to cast (actor) roles. Use search_people to " +
        "resolve an actor's name to their id.",
    )
    .optional(),
  with_crew: z
    .string()
    .describe(
      "Comma-separated TMDB person ids, restricted to crew roles (e.g. a director). Use " +
        "search_people to resolve a name to their id.",
    )
    .optional(),
  with_people: z
    .string()
    .describe(
      "Comma-separated TMDB person ids, matching either a cast or crew role. Use search_people " +
        "to resolve a name to their id.",
    )
    .optional(),
  // TMDB's own docs describe this as picking which country's release date
  // counts as a movie's release date for date-based filtering/sorting — but
  // verified live, combining it with release_date_gte/lte, year, or
  // with_release_type produced byte-identical total_results/ordering with
  // vs. without it, for a real region (US/FR/DE/JP), so don't rely on the
  // documented mechanism actually kicking in. The one live-reproducible
  // effect: even with NO other filter at all, supplying any value here
  // (including one TMDB doesn't recognize, e.g. "ZZ") shifts total_results
  // by a handful of titles versus omitting the field — real and repeatable,
  // but too small/unexplained to use for precise filtering.
  // Movie-only: verified live against /discover/tv, every value (real,
  // nonsense, or omitted) returns identical total_results there — TMDB does
  // not support this param for TV discover at all.
  // Deliberately NOT built via the shared regionSchema(defaultRegion) factory
  // above: that factory's description asserts a "(default 'XXX')" fallback,
  // but discoverQuery (clients/tmdb.ts) never defaults this to config.tmdbRegion
  // the way getMovie/getTv/getWatchProviders do — it's a pure pass-through,
  // omitted entirely from the query when not given. Reusing that factory here
  // would advertise a fallback that doesn't exist.
  region: z
    .string()
    .regex(/^[A-Z]{2}$/, "Use a two-letter ISO-3166-1 country code, e.g. 'US'.")
    .describe(
      "ISO-3166-1 country code. TMDB's docs describe this as picking which country's release " +
        "date counts as a movie's release date for date-based filtering (year, release_date_gte/" +
        "lte) — but live testing found no measurable effect there; use certification_country " +
        "instead to scope the certification filter, which does work. The one confirmed live " +
        "effect: supplying any value (even one TMDB doesn't recognize) shifts total_results by a " +
        "handful of titles versus omitting this field entirely, even with no other filter — real " +
        "but too small and unexplained to use for precise filtering. Movie-only.",
    )
    .optional(),
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
  sort_by: z
    .enum(TV_SORT_BY)
    .describe(
      "Sort order. Defaults to TMDB's own default (roughly popularity-based) if omitted. TV's " +
        "vocabulary differs from discover_movies' — 'name'/'first_air_date' instead of " +
        "'original_title'/'primary_release_date', and no 'revenue' (TMDB doesn't track it per-show).",
    )
    .optional(),
  with_networks: z
    .string()
    .describe(
      "Comma-separated TMDB TV network ids, e.g. HBO=49, Netflix=213 (verified live). Unlike " +
        "with_companies/with_keywords/with_people, this server has no name-based resolver for " +
        "networks — supply the raw TMDB network id directly; a well-known network's id may " +
        "already be known, otherwise there's no in-server way to look one up.",
    )
    .optional(),
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
// sort_by is spread from both variants with genuinely different enums (movie
// vs. tv vocabulary) — the plain object spread below would let discoverTvSchema's
// definition silently win, narrowing the merged type to TV-only values and
// breaking assignability from a real discover_movies call's args. Re-widen it
// explicitly to the union of both, matching what discoverQuery actually forwards.
export const discoverParamsSchema = z.object({
  ...discoverMovieSchema,
  ...discoverTvSchema,
  sort_by: z.union([z.enum(MOVIE_SORT_BY), z.enum(TV_SORT_BY)]).optional(),
});
export type DiscoverParams = z.infer<typeof discoverParamsSchema>;

// TMDB silently ignores certification/with_watch_providers when their required
// pair field is missing, instead of erroring — which reads as "the filter was
// applied" when it wasn't. Catch that here instead of round-tripping to TMDB.
function checkDiscoverFilterPairs(
  val: {
    min_rating?: number;
    max_rating?: number;
    min_runtime?: number;
    max_runtime?: number;
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
  if (
    val.min_runtime !== undefined &&
    val.max_runtime !== undefined &&
    val.min_runtime > val.max_runtime
  ) {
    ctx.addIssue({
      code: "custom",
      message: "min_runtime must be <= max_runtime.",
      path: ["min_runtime"],
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

export function registerDiscoverTools(
  server: McpServer,
  { tmdb, requireTmdb, requireTmdbCached }: TmdbToolDeps,
): void {
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
    ({ media_type, time_window, page: pg }, ctx) =>
      requireTmdb(
        () =>
          tmdb.getTrending(
            media_type ?? "all",
            time_window ?? "week",
            pg,
            undefined,
            ctx.mcpReq.signal,
          ),
        ctx.mcpReq.signal,
      ),
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
    (_args, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.getGenres("movie", undefined, onStale),
        ctx.mcpReq.signal,
      );
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
    (_args, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.getGenres("tv", undefined, onStale),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "discover_movies",
    {
      title: "Discover movies (filters)",
      description:
        "Find movies by structured filters instead of a title query: genres (include/exclude), " +
        "year or release-date range, rating range, vote count, runtime range, original language, " +
        "cast/crew/people, companies, keywords, watch providers, certification, a region code " +
        "(minor effect only — see its own description), an adult-content toggle, and sort order. " +
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
    (args, ctx) =>
      requireTmdb(() => tmdb.discover("movie", args, ctx.mcpReq.signal), ctx.mcpReq.signal),
  );

  server.registerTool(
    "discover_tv",
    {
      title: "Discover TV shows (filters)",
      description:
        "Find TV shows by structured filters (genres, first-air year or date range, rating range, " +
        "vote count, runtime, language, companies, networks, keywords, watch providers, type, " +
        "status, certification, an adult-content toggle, sort) — but NOT cast/crew/person: this " +
        "tool doesn't accept those " +
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
    (args, ctx) =>
      requireTmdb(() => tmdb.discover("tv", args, ctx.mcpReq.signal), ctx.mcpReq.signal),
  );
}
