// Zod field builders, the requireTmdb type and the TmdbToolDeps bag shared by
// the sibling tool files, so one concept (a TMDB id, a region code, ...) has one
// definition.
import { z } from "zod";
import type { TmdbClient } from "../../clients/tmdb.ts";
import type { OmdbClient } from "../../clients/omdb.ts";
import { LANGUAGE_REGEX } from "../../config.ts";
import { TMDB_MAX_PAGE } from "../../format.ts";
import type { ToolResult } from "../../lib/result.ts";

// Shape of the closure index.ts builds over the tmdb client. `signal` is the
// handler's `ctx.mcpReq.signal`: handlers also pass it to an uncached client
// call, which is what aborts that fetch, while requireConfigured races it so a
// cancelled call stops waiting on a cache-shared one.
export type RequireTmdb = <T extends Record<string, unknown>>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
) => Promise<ToolResult>;

// The dependency bag every register*Tools function takes; each destructures
// only what it needs.
export interface TmdbToolDeps {
  tmdb: TmdbClient;
  omdb: OmdbClient;
  requireTmdb: RequireTmdb;
  region: ReturnType<typeof regionSchema>;
}

const PAGE = `1-based page number for pagination (TMDB returns up to 20 results per page, max ${TMDB_MAX_PAGE}).`;
export const page = z.int().min(1).max(TMDB_MAX_PAGE).describe(PAGE);
// For the lists this server filters itself (format.ts's withoutExplicit):
// TMDB hides adult titles on search/discover, so only these come up short.
export const filteredPage = page.describe(
  `${PAGE} Adult/softcore titles are dropped from this list, so a page can come back ` +
    "shorter, even empty, while total_pages/total_results stay TMDB's own — keep paging up to total_pages.",
);
export const tmdbId = z.int().positive().describe("TMDB numeric id.");
export const mediaKind = z.enum(["movie", "tv"]).describe("Media type: 'movie' or 'tv'.");
// Shared by get_tv_season/get_tv_episode.
export const seasonNumber = z.int().min(0).describe("Season number (0 = specials).");
// Year filter for discover_* and search_movies/search_tv: same TMDB range,
// wording varies per call site.
export const yearFilter = (what: string) => z.int().min(1870).max(2100).describe(what).optional();
// Used by discover_*'s with_watch_providers and search_watch_providers:
// availability, and even a provider's id, is region-specific.
export const watchRegion = z
  .string()
  .regex(/^[A-Z]{2}$/, "Two-letter ISO-3166-1 country code.")
  .describe("Two-letter ISO-3166-1 country code, e.g. 'US'.");
// TMDB's fixed department list for crew jobs (from /configuration/jobs).
// Used by get_person_credits' department filter.
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
// get_movies/get_tv_shows cap. TMDB has no batch API, so each id is its own
// upstream request, fanned out through the shared rate limiter.
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

// Built from config because the description names the server's TMDB_REGION default.
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
