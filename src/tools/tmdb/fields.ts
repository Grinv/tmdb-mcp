// Shared Zod field/schema builders, plus the requireTmdb
// function shapes and the TmdbToolDeps bag every sibling file in this
// directory (search.ts, details.ts, discover.ts, lookups.ts) registers its
// tools from — kept in one place so the same concept (a TMDB id, a
// media-type toggle, a region code, the configured-client short-circuit, …)
// isn't redefined slightly differently in more than one spot.
import { z } from "zod";
import type { TmdbClient } from "../../clients/tmdb.ts";
import type { OmdbClient } from "../../clients/omdb.ts";
import { LANGUAGE_REGEX } from "../../config.ts";
import { TMDB_MAX_PAGE } from "../../format.ts";
import type { ToolResult } from "../../lib/result.ts";

// index.ts constructs the real closure over the actual tmdb client and passes
// it into each register*Tools function below — this is just its shape.
// `signal`, when given, is the calling tool handler's own `ctx.mcpReq.signal`:
// handlers also forward it into an uncached, unshared client call, which is
// what actually aborts that fetch, while requireConfigured races it so a
// cancelled call stops waiting on a cache-shared fetch.
export type RequireTmdb = <T extends Record<string, unknown>>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
) => Promise<ToolResult>;

// The one dependency bag every register*Tools function below takes, so
// adding a new cross-cutting dependency means editing this interface once
// instead of up to 4 differently-shaped function signatures and their call
// sites in index.ts. Not every file uses every field (e.g. discover.ts has
// no need for `region`), but each just destructures what it needs.
export interface TmdbToolDeps {
  tmdb: TmdbClient;
  omdb: OmdbClient;
  requireTmdb: RequireTmdb;
  region: ReturnType<typeof regionSchema>;
}

export const page = z
  .int()
  .min(1)
  .max(TMDB_MAX_PAGE)
  .describe(
    `1-based page number for pagination (TMDB returns up to 20 results per page, max ${TMDB_MAX_PAGE}). ` +
      "Lists that drop adult/softcore titles can return a shorter, even empty, page while " +
      "total_pages/total_results stay TMDB's own — keep paging up to total_pages.",
  );
export const tmdbId = z.int().positive().describe("TMDB numeric id.");
export const mediaKind = z.enum(["movie", "tv"]).describe("Media type: 'movie' or 'tv'.");
// Shared by get_tv_season/get_tv_episode.
export const seasonNumber = z.int().min(0).describe("Season number (0 = specials).");
// Shared by discover_movies/discover_tv's year filter and search_movies/search_tv's
// disambiguating year param — same TMDB-supported range, different wording per call site.
export const yearFilter = (what: string) => z.int().min(1870).max(2100).describe(what).optional();
// Shared by discover_*'s with_watch_providers pairing and search_watch_providers:
// watch-provider availability (and even a provider's own numeric id) is
// region-specific, so both need the same "which country" field.
export const watchRegion = z
  .string()
  .regex(/^[A-Z]{2}$/, "Two-letter ISO-3166-1 country code.")
  .describe("Two-letter ISO-3166-1 country code, e.g. 'US'.");
// TMDB's own fixed department vocabulary for crew jobs (from
// /configuration/jobs, verified live — stable reference data, not something
// tmdb-mcp invents). get_person_credits' department filter uses this.
export const PERSON_DEPARTMENTS = [
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
export const personDepartment = z
  .enum(PERSON_DEPARTMENTS)
  .describe(
    "Restrict crew credits to this department (e.g. 'Directing' for a director's filmography). " +
      "Without it, a multi-hyphenate's OTHER departments (writing, producing, …) compete for the " +
      "same 25-credit cap and can crowd out titles in the department you actually want.",
  )
  .optional();
export const personCreditsLimit = z
  .int()
  .min(1)
  .max(100)
  .describe(
    "Max cast entries and max crew entries to return (each capped separately; default 25). Raise " +
      "this for an exceptionally prolific person — e.g. a director with 50+ films — where even a " +
      "department filter still leaves more titles than the default cap keeps.",
  )
  .optional();
// Defaults live in the schema (.default), which both publishes them in the
// tool's JSON Schema and hands the handler the resolved value — never restate
// one in prose or in the handler.
export const includeAdult = z.boolean().default(false).describe("Include adult (NSFW) results.");
export const includeRatings = z
  .boolean()
  .default(true)
  .describe(
    "Enrich the result with IMDb/Rotten Tomatoes/Metacritic ratings plus an " +
      "awards summary (major-award wins/nominations — Oscars, Emmys, Golden Globes, etc., whatever " +
      "OMDb aggregates; free text, not a structured count, and describes the whole film/show, not " +
      "any one person's award) from OMDb (requires OMDB_API_KEY). Set false to skip the extra " +
      "lookup when ratings are not needed.",
  );
// get_movies/get_tv_shows: capped well under TMDB's own per-request limits
// (e.g. append_to_response's 20) since, unlike Steam's real batch endpoints,
// TMDB has no batch API at all — each id here is still its own upstream
// request under the hood, just fanned out concurrently through the same
// rate limiter every other call shares.
export const MAX_BATCH_IDS = 20;
export const movieIdsBatch = z
  .array(z.int().positive())
  .min(1)
  .max(MAX_BATCH_IDS)
  .describe(
    `TMDB movie ids to fetch (1-${MAX_BATCH_IDS}). Get them from search_movies/discover_movies/get_similar/` +
      "get_movie_recommendations/etc.",
  );
export const tvIdsBatch = z
  .array(z.int().positive())
  .min(1)
  .max(MAX_BATCH_IDS)
  .describe(
    `TMDB TV show ids to fetch (1-${MAX_BATCH_IDS}). Get them from search_tv/discover_tv/get_similar/` +
      "get_tv_recommendations/etc.",
  );
export const includeRatingsBatch = z
  .boolean()
  .default(false)
  .describe(
    "Enrich every card with compact IMDb/Rotten Tomatoes/Metacritic ratings from OMDb " +
      "(requires OMDB_API_KEY) — one extra OMDb lookup per id, so a large batch means a burst of " +
      "OMDb calls; mind OMDb's own rate limit. Off by default here, unlike get_movie/get_tv.",
  );

export const expandEpisodes = z
  .boolean()
  .default(false)
  .describe(
    "Also fetch every season's full episode list (name, air date, runtime, and TMDB " +
      "`vote_average` — TMDB's own 0-10 user score, not this tool's IMDb/RT/Metacritic `ratings`) as " +
      "`seasons_detail`, in one extra request — use this instead of calling get_tv_season once per " +
      "season when you need all episodes of a multi-season show. Episode overviews are omitted " +
      "here to keep that aggregate response usable — call get_tv_season for one season's full " +
      "detail including overview. Each season's episode list is capped at 50 (season 0 'Specials' " +
      "in particular can otherwise run to hundreds of bonus clips), and the combined count across " +
      "every season is capped at 250 total, and the whole aggregate additionally has a hard size " +
      "ceiling (trims further if episode names are unusually long) since a 30+ season show could " +
      "otherwise still exceed a usable response size even with the per-season cap alone; " +
      "`episode_count` on each season still reports that season's true total. The 250 budget is " +
      "spent in season order starting at season 0, so on a long-running show the specials are " +
      "served first and the last seasons are the ones that fall off. A season that falls " +
      "entirely beyond the 250-episode budget is skipped rather than fetched-then-discarded, so its " +
      "`overview`/`poster_url` come back null too, not just its `episodes` list — call get_tv_season " +
      "for that season's full detail.",
  );

// The default named in the description must match the server's actual
// TMDB_REGION, so it's built per-server from config rather than hardcoded.
export const regionSchema = (defaultRegion: string) =>
  z
    .string()
    .regex(/^[A-Z]{2}$/, "Use a two-letter ISO-3166-1 country code, e.g. 'US'.")
    .describe(`ISO-3166-1 country code for region-specific results (default '${defaultRegion}').`)
    .optional();

export const language = z
  .string()
  .regex(
    LANGUAGE_REGEX,
    "Use an ISO-639-1 language code, optionally with a region, e.g. 'en' or 'en-US'.",
  )
  .describe(
    "Override the response language (ISO-639-1, optionally with a region), e.g. 'ru-RU' or 'en-US'. " +
      "Localizes titles/overviews/genre names. Defaults to the server's TMDB_LANGUAGE. A " +
      "well-formed code TMDB has no translation for (e.g. 'xx') is not an error: overviews come " +
      "back null, movies/shows keep their original-language title, and episodes get a generic " +
      "'Episode N' name.",
  )
  .optional();
