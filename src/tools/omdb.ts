// OMDb-backed tool. get_movie / get_tv already fold OMDb ratings into their
// result; this standalone tool is for the cases where you only have an IMDb id
// (e.g. from an external source) or want to look up ratings by raw title.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmdbClient } from "../clients/omdb.js";
import { errorResult } from "../lib/result.js";
import { READ_ONLY, requireConfigured } from "./shared.js";

export function registerOmdbTools(server: McpServer, omdb: OmdbClient): void {
  server.registerTool(
    "get_ratings",
    {
      title: "Get IMDb/RT/Metacritic ratings",
      description:
        "Look up IMDb, Rotten Tomatoes and Metacritic ratings from OMDb by IMDb id (preferred, " +
        "e.g. 'tt0133093') or by title (+ optional year). Prefer get_movie/get_tv when you have a " +
        "TMDB id — they already include these ratings. Requires OMDB_API_KEY. A no-match lookup is " +
        "not an error: it returns `{found:false, reason}`.",
      inputSchema: {
        imdb_id: z
          .string()
          .regex(/^tt\d+$/, "IMDb ids look like 'tt0133093'.")
          .describe("IMDb title id. Takes precedence over title when both are given.")
          .optional(),
        title: z
          .string()
          .min(1)
          .describe("Movie/show title (used when imdb_id is absent).")
          .optional(),
        year: z
          .number()
          .int()
          .min(1870)
          .max(2100)
          .describe("Year, to disambiguate a title.")
          .optional(),
      },
      annotations: READ_ONLY,
    },
    ({ imdb_id, title, year }) => {
      if (!omdb.configured) {
        return Promise.resolve(errorResult(omdb.notConfiguredMessage));
      }
      if (!imdb_id && !title) {
        return Promise.resolve(errorResult("Provide either imdb_id or title."));
      }
      return requireConfigured(omdb, () =>
        imdb_id ? omdb.ratingsByImdbId(imdb_id) : omdb.ratingsByTitle(title!, year),
      );
    },
  );
}
