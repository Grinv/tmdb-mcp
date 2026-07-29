// Supplementary per-title lookups fetched separately from the main
// get_movie/get_tv detail payload: where to watch, videos/trailers, an
// IMDb-id reverse lookup, and TV season/episode deep dives.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { TmdbClient } from "../../clients/tmdb.js";
import {
  episodeSchema,
  findSchema,
  seasonSchema,
  videosSchema,
  watchProvidersSchema,
} from "../../format.schemas.js";
import { READ_ONLY } from "../shared.js";
import { mediaType, regionSchema, tmdbId, type RequireTmdbCached } from "./fields.js";

export function registerLookupTools(
  server: McpServer,
  tmdb: TmdbClient,
  requireTmdbCached: RequireTmdbCached,
  region: ReturnType<typeof regionSchema>,
): void {
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
      return requireTmdbCached((onStale) => tmdb.getWatchProviders(media_type, id, r, onStale));
    },
  );

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
      return requireTmdbCached((onStale) => tmdb.getVideos(media_type, id, undefined, onStale));
    },
  );

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
      return requireTmdbCached((onStale) => tmdb.findByExternalId(imdb_id, "imdb_id", onStale));
    },
  );

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
      return requireTmdbCached((onStale) =>
        tmdb.getTvSeason(id, season_number, undefined, onStale),
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
      return requireTmdbCached((onStale) =>
        tmdb.getTvEpisode(id, season_number, episode_number, undefined, onStale),
      );
    },
  );
}
