// Supplementary per-title lookups fetched separately from the main
// get_movie/get_tv detail payload: where to watch, videos/trailers, an
// IMDb-id reverse lookup, and TV season/episode deep dives.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  episodeSchema,
  findSchema,
  seasonSchema,
  videosSchema,
  watchProvidersSchema,
} from "../../format.schemas.js";
import { READ_ONLY } from "../shared.js";
import { mediaKind, tmdbId, type TmdbToolDeps } from "./fields.js";

export function registerLookupTools(
  server: McpServer,
  { tmdb, requireTmdbCached, region }: TmdbToolDeps,
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
          media_type: mediaKind,
          id: tmdbId,
          region,
        })
        .strict(),
      outputSchema: watchProvidersSchema,
      annotations: READ_ONLY,
    },
    ({ media_type, id, region: r }, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.getWatchProviders(media_type, id, r, onStale),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "get_videos",
    {
      title: "Get trailers & videos",
      description:
        "List trailers, teasers and clips for a movie or TV show; YouTube entries include a " +
        "watch URL. Get the id from search_movies/search_tv.",
      inputSchema: z.object({ media_type: mediaKind, id: tmdbId }).strict(),
      outputSchema: videosSchema,
      annotations: READ_ONLY,
    },
    ({ media_type, id }, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.getVideos(media_type, id, undefined, onStale),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "find_by_imdb_id",
    {
      title: "Find by IMDb id",
      description:
        "Resolve an IMDb id (e.g. 'tt0133093') to TMDB entities — returns matching movie, TV and " +
        "person results. Use when you only have an IMDb id and need the TMDB id for the other " +
        "tools. Only matches whole movies/shows/people: IMDb also assigns 'tt' ids to individual " +
        "episodes (verified live, e.g. Breaking Bad's pilot 'tt0959621'), which this tool does " +
        "not resolve — such an id comes back with every result list empty, indistinguishable " +
        "from a genuinely unknown id.",
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
    ({ imdb_id }, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.findByExternalId(imdb_id, "imdb_id", onStale),
        ctx.mcpReq.signal,
      );
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
    ({ id, season_number }, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.getTvSeason(id, season_number, undefined, onStale),
        ctx.mcpReq.signal,
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
    ({ id, season_number, episode_number }, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.getTvEpisode(id, season_number, episode_number, undefined, onStale),
        ctx.mcpReq.signal,
      );
    },
  );
}
