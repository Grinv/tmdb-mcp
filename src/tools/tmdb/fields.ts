// Zod field builders, the requireTmdb type and the TmdbToolDeps bag shared by
// the sibling tool files, so one concept (a TMDB id, a region code, ...) has one
// definition.
import { z } from "zod";
import type { TmdbClient } from "../../clients/tmdb.ts";
import type { OmdbClient } from "../../clients/omdb.ts";
import { COUNTRY_REGEX, LANGUAGE_REGEX } from "../../config.ts";
import { PERSON_CREDITS_LIMIT, TMDB_MAX_PAGE } from "../../format.ts";
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
  language: ReturnType<typeof languageSchema>;
}

const PAGE = `1-based page number for pagination (TMDB returns up to 20 results per page, max ${TMDB_MAX_PAGE}).`;
export const page = z.int().min(1).max(TMDB_MAX_PAGE).describe(PAGE);
// For the lists this server filters itself (format.ts's withoutExplicit):
// TMDB hides adult titles on search/discover, so only these come up short.
export const filteredPage = page.describe(
  `${PAGE} Adult/softcore titles are dropped from this list, so a page can come back ` +
    "shorter, even empty, while total_pages/total_results stay TMDB's own; keep paging up to total_pages.",
);
export const tmdbId = z.int().positive().describe("TMDB numeric id.");
// The same id, named for what it identifies, so the caller knows which search
// yields it.
export const movieId = tmdbId.describe("TMDB movie id (from search_movies).");
export const tvId = tmdbId.describe("TMDB TV show id (from search_tv).");
export const personId = tmdbId.describe("TMDB person id (from search_people).");
export const collectionId = tmdbId.describe(
  "TMDB collection id (from search_collections, or a movie's `collection` in get_movie).",
);
export const mediaId = tmdbId.describe(
  "TMDB id of the movie or TV show (as media_type says; from search_movies/search_tv).",
);
export const mediaKind = z.enum(["movie", "tv"]).describe("Media type: 'movie' or 'tv'.");
// Shared by get_tv_season/get_tv_episode.
export const seasonNumber = z.int().min(0).describe("Season number (0 = specials).");
// Year filter for discover_* and search_movies/search_tv: same TMDB range,
// wording varies per call site.
export const yearFilter = (what: string) => z.int().min(1870).max(2100).describe(what).optional();
// Every country-code field; each use describes what the country selects there.
export const country = z
  .string()
  .regex(COUNTRY_REGEX, "Use a two-letter ISO-3166-1 country code, e.g. 'US'.");
// Used by discover_*'s watch filters and search_watch_providers: availability,
// and even a provider's id, is region-specific.
export const watchRegion = country.describe("Two-letter ISO-3166-1 country code, e.g. 'US'.");
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
      "Without it, a multi-hyphenate's other departments (writing, producing, ...) compete for the " +
      `same ${PERSON_CREDITS_LIMIT}-credit cap and can crowd out the department you want.`,
  )
  .optional();
export const personCreditsLimit = z
  .int()
  .min(1)
  .max(100)
  .default(PERSON_CREDITS_LIMIT)
  .describe(
    "Max cast entries and max crew entries to return (each capped separately, 1-100). Raise " +
      "this for a very prolific person (e.g. a director with 50+ films) when even a " +
      "department filter leaves more titles than the default cap keeps.",
  );
export const includeAdult = z.boolean().default(false).describe("Include adult (NSFW) results.");
export const includeRatings = z
  .boolean()
  .default(true)
  .describe(
    "Add IMDb/Rotten Tomatoes/Metacritic ratings and an awards summary from OMDb (requires " +
      "OMDB_API_KEY). The summary is free text (major-award wins/nominations: Oscars, Emmys, " +
      "Golden Globes, etc., whatever OMDb aggregates), not a structured count, and covers the " +
      "whole film/show, not any one person's award. Set false to skip the extra lookup.",
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
    "Add compact IMDb/Rotten Tomatoes/Metacritic ratings from OMDb to every card (requires " +
      "OMDB_API_KEY). Costs one extra OMDb lookup per id, so a large batch means a burst of " +
      "OMDb calls; mind OMDb's own rate limit. Off by default here, unlike get_movie/get_tv.",
  );

export const expandEpisodes = z
  .boolean()
  .default(false)
  .describe(
    "Also fetch every season's full episode list (name, air date, runtime, and TMDB " +
      "`vote_average`, TMDB's own 0-10 user score, not this tool's IMDb/RT/Metacritic `ratings`) as " +
      "`seasons_detail`, in one extra request (more only past 20 seasons). Use this instead of " +
      "calling get_tv_season once per season when you need all episodes of a multi-season show. " +
      "Episode overviews are omitted to keep the response usable; call get_tv_season for one " +
      "season's full detail including overview. Each season's episode list is capped at 50 " +
      "(season 0 'Specials' can otherwise run to hundreds of bonus clips), the combined count " +
      "across every season is capped at 250, and the whole aggregate has a hard size ceiling " +
      "(it trims further if episode names are unusually long), since a 30+ season show could " +
      "otherwise still exceed a usable size. `episode_count` on each season still reports that " +
      "season's true total. The 250 budget is spent in season order starting at season 0, so on a " +
      "long-running show the specials are served first and the last seasons fall off. A season " +
      "entirely beyond the 250-episode budget is skipped rather than fetched and discarded, so its " +
      "`overview`/`poster_url` come back null too, not just its `episodes` list; call " +
      "get_tv_season for that season's full detail.",
  );

// The user's country: every country a tool can't answer without (age rating,
// cinemas, where to watch) defaults to the server's TMDB_REGION. Each tool
// overrides the description with what the country selects there.
export const regionSchema = (defaultRegion: string) =>
  country.default(defaultRegion).describe("The user's country (ISO-3166-1); pass it when known.");

export const languageCode = z
  .string()
  .regex(
    LANGUAGE_REGEX,
    "Use an ISO-639-1 language code, optionally with a region, e.g. 'en' or 'en-US'.",
  )
  .describe(
    "Response language (ISO-639-1, optionally with a region), e.g. 'ru-RU' or 'en-US'; pass the " +
      "user's language when it isn't the default. Localizes titles/overviews/genre names. A " +
      "well-formed code TMDB has no translation for (e.g. 'xx') is not an error: overviews come " +
      "back null, movies/shows keep their original-language title, and episodes get a generic " +
      "'Episode N' name.",
  );
// The user's language: the server's TMDB_LANGUAGE unless the call gives one.
export const languageSchema = (defaultLanguage: string) => languageCode.default(defaultLanguage);
