// TMDB-backed tools (search, details, credits, recommendations, trending,
// genres). get_movie / get_tv optionally enrich their result with OMDb ratings
// (IMDb/RT/Metacritic) keyed by the imdb_id TMDB returns — this cross-linking is
// the whole point of keeping both clients in one server. Descriptions and
// per-field .describe() text are written for the calling model: when to use a
// tool and the meaning of every parameter.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TmdbClient } from "../clients/tmdb.js";
import type { OmdbClient } from "../clients/omdb.js";
import { jsonResult, errorResult, type ToolResult } from "../lib/result.js";
import { guard } from "./guard.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const page = z.number().int().min(1).describe("1-based page number for pagination.");
const tmdbId = z.number().int().positive().describe("TMDB numeric id.");
const includeAdult = z
  .boolean()
  .describe("Include adult (NSFW) results. Defaults to false.")
  .optional();
const includeRatings = z
  .boolean()
  .describe(
    "If true (default), enrich the result with IMDb/Rotten Tomatoes/Metacritic ratings from OMDb " +
      "(requires OMDB_API_KEY). Set false to skip the extra lookup when ratings are not needed.",
  )
  .optional();

const mediaType = z
  .enum(["movie", "tv"])
  .describe("Whether the id refers to a movie or a TV show.");
const region = z
  .string()
  .regex(/^[A-Z]{2}$/, "Use a two-letter ISO-3166-1 country code, e.g. 'US'.")
  .describe("ISO-3166-1 country code for region-specific results (default 'US').")
  .optional();
const sortBy = z
  .string()
  .describe("TMDB sort, e.g. 'popularity.desc', 'vote_average.desc', 'primary_release_date.desc'.")
  .optional();
const withGenres = z
  .string()
  .describe("Comma-separated TMDB genre ids (AND); get ids from get_movie_genres/get_tv_genres.")
  .optional();
const discoverShared = {
  sort_by: sortBy,
  with_genres: withGenres,
  year: z.number().int().min(1870).max(2100).describe("Release / first-air year.").optional(),
  min_rating: z.number().min(0).max(10).describe("Minimum vote average (0-10).").optional(),
  max_rating: z.number().min(0).max(10).describe("Maximum vote average (0-10).").optional(),
  min_votes: z
    .number()
    .int()
    .min(0)
    .describe("Minimum vote count (filters obscure titles).")
    .optional(),
  min_runtime: z.number().int().min(0).describe("Minimum runtime in minutes.").optional(),
  with_original_language: z
    .string()
    .describe("ISO-639-1 language code, e.g. 'en', 'ja'.")
    .optional(),
  page: page.optional(),
};

/** Run a client call and wrap its result (or any failure) as a tool result. */
const reply = (fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> =>
  guard(async () => jsonResult(await fn()));

export function registerTmdbTools(server: McpServer, tmdb: TmdbClient, omdb: OmdbClient): void {
  // Every TMDB tool needs the token; short-circuit with one clear message
  // instead of letting each call round-trip to a 401.
  const requireTmdb = (fn: () => Promise<Record<string, unknown>>): Promise<ToolResult> => {
    if (!tmdb.configured) {
      return Promise.resolve(
        errorResult(
          "TMDB is not configured. Set TMDB_API_TOKEN to a TMDB v4 'Read Access Token' " +
            "(https://www.themoviedb.org/settings/api).",
        ),
      );
    }
    return reply(fn);
  };

  // ---- search ---------------------------------------------------------------

  server.registerTool(
    "search_movies",
    {
      title: "Search movies",
      description:
        "Search TMDB movies by title; returns compact summaries with the TMDB id that the other " +
        "movie tools (get_movie, get_movie_credits, …) require, plus pagination info.",
      inputSchema: {
        query: z.string().min(1).describe("Movie title to search for."),
        year: z.number().int().min(1870).max(2100).describe("Filter by release year.").optional(),
        include_adult: includeAdult,
        page: page.optional(),
      },
      annotations: READ_ONLY,
    },
    (args) => requireTmdb(() => tmdb.searchMovies(args)),
  );

  server.registerTool(
    "search_tv",
    {
      title: "Search TV shows",
      description:
        "Search TMDB TV shows by name; returns compact summaries with the TMDB id that get_tv and " +
        "the other TV tools require.",
      inputSchema: {
        query: z.string().min(1).describe("TV show name to search for."),
        year: z
          .number()
          .int()
          .min(1870)
          .max(2100)
          .describe("Filter by first-air-date year.")
          .optional(),
        include_adult: includeAdult,
        page: page.optional(),
      },
      annotations: READ_ONLY,
    },
    (args) => requireTmdb(() => tmdb.searchTv(args)),
  );

  server.registerTool(
    "search_multi",
    {
      title: "Search everything",
      description:
        "Search movies, TV shows and people in one call. Each result carries a media_type " +
        "('movie' | 'tv' | 'person') so you can route to the right get_* tool. Use when the user's " +
        "query could be any of these.",
      inputSchema: {
        query: z.string().min(1).describe("Free-text query."),
        include_adult: includeAdult,
        page: page.optional(),
      },
      annotations: READ_ONLY,
    },
    (args) => requireTmdb(() => tmdb.searchMulti(args)),
  );

  server.registerTool(
    "search_people",
    {
      title: "Search people",
      description:
        "Search TMDB people (actors, directors, crew) by name; returns the TMDB id needed by " +
        "get_person plus their best-known titles.",
      inputSchema: {
        query: z.string().min(1).describe("Person name to search for."),
        include_adult: includeAdult,
        page: page.optional(),
      },
      annotations: READ_ONLY,
    },
    (args) => requireTmdb(() => tmdb.searchPeople(args)),
  );

  // ---- details --------------------------------------------------------------

  server.registerTool(
    "get_movie",
    {
      title: "Get movie details",
      description:
        "Get full details for one movie by TMDB id: overview, genres, runtime, budget/revenue, " +
        "vote average, and links (TMDB + IMDb). By default also includes IMDb/Rotten Tomatoes/" +
        "Metacritic ratings from OMDb (set include_ratings=false to skip). Get the id from search_movies.",
      inputSchema: { id: tmdbId, include_ratings: includeRatings },
      annotations: READ_ONLY,
    },
    ({ id, include_ratings }) =>
      requireTmdb(async () => {
        const { shaped, imdbId } = await tmdb.getMovieWithImdb(id);
        return maybeEnrich(shaped, imdbId, include_ratings ?? true, omdb);
      }),
  );

  server.registerTool(
    "get_tv",
    {
      title: "Get TV show details",
      description:
        "Get full details for one TV show by TMDB id: overview, genres, seasons/episodes counts, " +
        "networks, status, and links. By default also includes IMDb/Rotten Tomatoes/Metacritic " +
        "ratings from OMDb (set include_ratings=false to skip). Get the id from search_tv.",
      inputSchema: { id: tmdbId, include_ratings: includeRatings },
      annotations: READ_ONLY,
    },
    ({ id, include_ratings }) =>
      requireTmdb(async () => {
        const { shaped, imdbId } = await tmdb.getTvWithImdb(id);
        return maybeEnrich(shaped, imdbId, include_ratings ?? true, omdb);
      }),
  );

  server.registerTool(
    "get_person",
    {
      title: "Get person details",
      description:
        "Get full details for one person by TMDB id: biography, birthday/deathday, department, and " +
        "links (TMDB + IMDb). Get the id from search_people or a credits list.",
      inputSchema: { id: tmdbId },
      annotations: READ_ONLY,
    },
    ({ id }) => requireTmdb(() => tmdb.getPerson(id)),
  );

  server.registerTool(
    "get_movie_credits",
    {
      title: "Get movie cast & crew",
      description:
        "List the top-billed cast and the headline crew (director, writers, composer, DoP, …) of a " +
        "movie by TMDB id. Get the id from search_movies.",
      inputSchema: { id: tmdbId },
      annotations: READ_ONLY,
    },
    ({ id }) => requireTmdb(() => tmdb.getMovieCredits(id)),
  );

  server.registerTool(
    "get_tv_credits",
    {
      title: "Get TV cast & crew",
      description:
        "List the main cast and headline crew (creators, writers, …) of a TV show by TMDB id. " +
        "Get the id from search_tv.",
      inputSchema: { id: tmdbId },
      annotations: READ_ONLY,
    },
    ({ id }) => requireTmdb(() => tmdb.getTvCredits(id)),
  );

  server.registerTool(
    "get_movie_recommendations",
    {
      title: "Get movie recommendations",
      description:
        "Get movies TMDB recommends as similar to the given movie id. Get the id from search_movies.",
      inputSchema: { id: tmdbId, page: page.optional() },
      annotations: READ_ONLY,
    },
    ({ id, page: pg }) => requireTmdb(() => tmdb.getMovieRecommendations(id, pg)),
  );

  server.registerTool(
    "get_tv_recommendations",
    {
      title: "Get TV recommendations",
      description:
        "Get TV shows TMDB recommends as similar to the given show id. Get the id from search_tv.",
      inputSchema: { id: tmdbId, page: page.optional() },
      annotations: READ_ONLY,
    },
    ({ id, page: pg }) => requireTmdb(() => tmdb.getTvRecommendations(id, pg)),
  );

  // ---- discovery ------------------------------------------------------------

  server.registerTool(
    "get_trending",
    {
      title: "Get trending titles",
      description:
        "Get what's trending on TMDB. media_type selects movies, TV, people, or all; time_window " +
        "is the trending period (today vs this week). Good for 'what's popular right now'.",
      inputSchema: {
        media_type: z
          .enum(["all", "movie", "tv", "person"])
          .describe("Which kind of entity to rank.")
          .optional(),
        time_window: z
          .enum(["day", "week"])
          .describe("Trending period: 'day' or 'week'. Defaults to 'week'.")
          .optional(),
        page: page.optional(),
      },
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
        "List TMDB movie genres with their numeric ids and names (reference data; rarely changes).",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => requireTmdb(() => tmdb.getMovieGenres()),
  );

  server.registerTool(
    "get_tv_genres",
    {
      title: "List TV genres",
      description:
        "List TMDB TV genres with their numeric ids and names (reference data; rarely changes).",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => requireTmdb(() => tmdb.getTvGenres()),
  );

  // ---- discover -------------------------------------------------------------

  server.registerTool(
    "discover_movies",
    {
      title: "Discover movies (filters)",
      description:
        "Find movies by structured filters instead of a title query: genres, year, rating range, " +
        "minimum vote count, runtime, original language, and sort order. Use for requests like " +
        "'popular sci-fi movies from the 1990s rated above 7'. Get genre ids from get_movie_genres.",
      inputSchema: discoverShared,
      annotations: READ_ONLY,
    },
    (args) => requireTmdb(() => tmdb.discoverMovies(args)),
  );

  server.registerTool(
    "discover_tv",
    {
      title: "Discover TV shows (filters)",
      description:
        "Find TV shows by structured filters (genres, first-air year, rating range, vote count, " +
        "runtime, language, sort). The TV counterpart of discover_movies.",
      inputSchema: discoverShared,
      annotations: READ_ONLY,
    },
    (args) => requireTmdb(() => tmdb.discoverTv(args)),
  );

  // ---- watch providers ------------------------------------------------------

  server.registerTool(
    "get_watch_providers",
    {
      title: "Where to watch",
      description:
        "Find where a movie or TV show can be streamed, rented or bought in a given country " +
        "(JustWatch data via TMDB). Returns provider names per access type plus the regions that " +
        "have data. Get the id from search_movies/search_tv.",
      inputSchema: {
        media_type: mediaType,
        id: tmdbId,
        region,
      },
      annotations: READ_ONLY,
    },
    ({ media_type, id, region: r }) =>
      requireTmdb(() =>
        media_type === "tv"
          ? tmdb.getTvWatchProviders(id, r ?? "US")
          : tmdb.getMovieWatchProviders(id, r ?? "US"),
      ),
  );

  // ---- person filmography ---------------------------------------------------

  server.registerTool(
    "get_person_credits",
    {
      title: "Get person filmography",
      description:
        "List the movies and TV shows a person is known for (cast roles and crew jobs), most " +
        "popular first. Use for 'what has this actor/director been in'. Get the id from search_people.",
      inputSchema: { id: tmdbId },
      annotations: READ_ONLY,
    },
    ({ id }) => requireTmdb(() => tmdb.getPersonCredits(id)),
  );

  // ---- videos / trailers ----------------------------------------------------

  server.registerTool(
    "get_videos",
    {
      title: "Get trailers & videos",
      description:
        "List trailers, teasers and clips for a movie or TV show; YouTube entries include a " +
        "watch URL. Get the id from search_movies/search_tv.",
      inputSchema: { media_type: mediaType, id: tmdbId },
      annotations: READ_ONLY,
    },
    ({ media_type, id }) =>
      requireTmdb(() => (media_type === "tv" ? tmdb.getTvVideos(id) : tmdb.getMovieVideos(id))),
  );

  // ---- reverse lookup -------------------------------------------------------

  server.registerTool(
    "find_by_imdb_id",
    {
      title: "Find by IMDb id",
      description:
        "Resolve an IMDb id (e.g. 'tt0133093') to TMDB entities — returns matching movie, TV and " +
        "person results. Use when you only have an IMDb id and need the TMDB id for the other tools.",
      inputSchema: {
        imdb_id: z
          .string()
          .regex(/^(tt|nm)\d+$/, "IMDb ids look like 'tt0133093' or 'nm0000206'.")
          .describe("IMDb title (tt…) or name (nm…) id."),
      },
      annotations: READ_ONLY,
    },
    ({ imdb_id }) => requireTmdb(() => tmdb.findByExternalId(imdb_id, "imdb_id")),
  );

  // ---- TV deep dive ---------------------------------------------------------

  server.registerTool(
    "get_tv_season",
    {
      title: "Get TV season",
      description:
        "Get one season of a TV show (by show id + season number): overview and the episode list " +
        "with air dates, runtimes and ratings. Season 0 is usually specials. Get the show id from search_tv.",
      inputSchema: {
        id: tmdbId,
        season_number: z.number().int().min(0).describe("Season number (0 = specials)."),
      },
      annotations: READ_ONLY,
    },
    ({ id, season_number }) => requireTmdb(() => tmdb.getTvSeason(id, season_number)),
  );

  server.registerTool(
    "get_tv_episode",
    {
      title: "Get TV episode",
      description:
        "Get one episode of a TV show by show id + season number + episode number: overview, air " +
        "date, runtime, rating, guest stars and director/writer. Get the show id from search_tv.",
      inputSchema: {
        id: tmdbId,
        season_number: z.number().int().min(0).describe("Season number (0 = specials)."),
        episode_number: z.number().int().min(1).describe("Episode number within the season."),
      },
      annotations: READ_ONLY,
    },
    ({ id, season_number, episode_number }) =>
      requireTmdb(() => tmdb.getTvEpisode(id, season_number, episode_number)),
  );
}

/** Attach OMDb ratings to a TMDB detail object when requested and possible. */
async function maybeEnrich(
  shaped: Record<string, unknown>,
  imdbId: string | null,
  wantRatings: boolean,
  omdb: OmdbClient,
): Promise<Record<string, unknown>> {
  if (!wantRatings) return shaped;
  if (!omdb.configured) {
    return { ...shaped, ratings: { found: false, reason: "OMDB_API_KEY not configured" } };
  }
  if (!imdbId) {
    return { ...shaped, ratings: { found: false, reason: "No imdb_id available from TMDB" } };
  }
  // OMDb failures must not sink the TMDB result; degrade to found:false.
  try {
    const ratings = await omdb.ratingsByImdbId(imdbId);
    return { ...shaped, ratings };
  } catch {
    return { ...shaped, ratings: { found: false, reason: "OMDb lookup failed" } };
  }
}
