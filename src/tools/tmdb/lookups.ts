// Per-title lookups kept out of the get_movie/get_tv payload: watch providers,
// videos, IMDb-id reverse lookup, TV season/episode details.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  episodeSchema,
  findSchema,
  seasonSchema,
  videosSchema,
  watchProvidersSchema,
} from "../../format.schemas.ts";
import { READ_ONLY } from "../shared.ts";
import { mediaId, mediaKind, seasonNumber, tvId, type TmdbToolDeps } from "./fields.ts";

export function registerLookupTools(
  server: McpServer,
  { tmdb, requireTmdb, region }: TmdbToolDeps,
): void {
  server.registerTool(
    "get_watch_providers",
    {
      title: "Where to watch",
      description:
        "Find where a movie or TV show can be streamed, rented or bought in a given country " +
        "(JustWatch data via TMDB). Returns provider names per access type for that country; with " +
        "no data there, returns `available:false` plus `available_regions` to retry with. Get the " +
        "id from search_movies/search_tv.",
      inputSchema: z.strictObject({
        media_type: mediaKind,
        id: mediaId,
        region: region.describe(
          "The user's country (pass it when known), whose streaming/rental/purchase providers to list.",
        ),
      }),
      outputSchema: watchProvidersSchema,
      annotations: READ_ONLY,
    },
    ({ media_type, id, region: r }, ctx) => {
      return requireTmdb(() => tmdb.getWatchProviders(media_type, id, r), ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "get_videos",
    {
      title: "Get trailers & videos",
      description:
        "List trailers, teasers and clips for a movie or TV show; YouTube entries include a " +
        "watch URL. Get the id from search_movies/search_tv. Returns videos in the server's " +
        "configured TMDB_LANGUAGE (default 'en-US') plus English, the title's original language " +
        "(e.g. Spirited Away's Japanese trailer) and untagged ones; each entry's `language` " +
        "(ISO-639-1) says which. No per-call language override.",
      inputSchema: z.strictObject({ media_type: mediaKind, id: mediaId }),
      outputSchema: videosSchema,
      annotations: READ_ONLY,
    },
    ({ media_type, id }, ctx) => {
      return requireTmdb(() => tmdb.getVideos(media_type, id, undefined), ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "find_by_imdb_id",
    {
      title: "Find by IMDb id",
      description:
        "Resolve an IMDb id (e.g. 'tt0133093') to TMDB entities: returns matching movie, TV, " +
        "person and TV-episode results. Use when you only have an IMDb id and need the TMDB id for " +
        "the other tools. IMDb also gives individual episodes 'tt' ids (e.g. Breaking Bad's pilot " +
        "'tt0959621'); those land in tv_episode_results as show_id + season_number + " +
        "episode_number, ready for get_tv_episode. An unknown id comes back with every list empty.",
      inputSchema: z.strictObject({
        imdb_id: z
          .string()
          .regex(/^(tt|nm)\d+$/, "IMDb ids look like 'tt0133093' or 'nm0000206'.")
          .describe("IMDb title (tt…) or name (nm…) id."),
      }),
      outputSchema: findSchema,
      annotations: READ_ONLY,
    },
    ({ imdb_id }, ctx) => {
      return requireTmdb(() => tmdb.findByExternalId(imdb_id, "imdb_id"), ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "get_tv_season",
    {
      title: "Get TV season",
      description:
        "Get one season of a TV show (by show id + season number): overview and the episode list " +
        "with air dates, runtimes and TMDB vote averages, capped at 50 episodes (`episode_count` " +
        "reports the true total). Per-episode `vote_average` is TMDB's own 0-10 user score, not " +
        "the IMDb/RT/Metacritic scores get_movie/get_tv return as `ratings`, which are whole-show " +
        "only; this tool makes no OMDb call, and TMDB's season payload carries no per-episode IMDb " +
        "ids either, so call get_tv_episode when you need one episode's `imdb_id` for " +
        "get_ratings. Season 0 is usually specials, which can run to hundreds of bonus clips on a " +
        "long-running show. Use get_tv with expand_episodes=true instead if you need every " +
        "season's episodes in one call. Get the show id from search_tv.",
      inputSchema: z.strictObject({
        id: tvId,
        season_number: seasonNumber,
      }),
      outputSchema: seasonSchema,
      annotations: READ_ONLY,
    },
    ({ id, season_number }, ctx) => {
      return requireTmdb(() => tmdb.getTvSeason(id, season_number, undefined), ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "get_tv_episode",
    {
      title: "Get TV episode",
      description:
        "Get one episode of a TV show by show id + season number + episode number: overview, air " +
        "date, runtime, TMDB vote average (`vote_average`, TMDB's own 0-10 user score, not an " +
        "IMDb/RT/Metacritic score; get_movie/get_tv's `ratings` are whole-show only and this " +
        "tool makes no OMDb call), guest stars (up to 15) and director/writer. Also returns the " +
        "episode's own `imdb_id`/`imdb_url`; pass that id to get_ratings for this episode's " +
        "IMDb rating, the only way to get a per-episode IMDb score here. Get the show id from " +
        "search_tv.",
      inputSchema: z.strictObject({
        id: tvId,
        season_number: seasonNumber,
        episode_number: z.int().min(1).describe("Episode number within the season."),
      }),
      outputSchema: episodeSchema,
      annotations: READ_ONLY,
    },
    ({ id, season_number, episode_number }, ctx) => {
      return requireTmdb(
        () => tmdb.getTvEpisode(id, season_number, episode_number, undefined),
        ctx.mcpReq.signal,
      );
    },
  );
}
