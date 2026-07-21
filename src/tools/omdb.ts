// OMDb-backed tool. get_movie / get_tv already fold OMDb ratings into their
// result; this standalone tool is for the cases where you only have an IMDb id
// (e.g. from an external source) or want to look up ratings by raw title.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { OmdbClient } from "../clients/omdb.js";
import { ratingsSchema } from "../format.schemas.js";
import { READ_ONLY, requireConfigured, trackStale } from "./shared.js";

export function registerOmdbTools(server: McpServer, omdb: OmdbClient): void {
  server.registerTool(
    "get_ratings",
    {
      title: "Get IMDb/RT/Metacritic ratings",
      description:
        "Look up IMDb, Rotten Tomatoes and Metacritic ratings from OMDb by IMDb id (preferred, " +
        "e.g. 'tt0133093') or by title (+ optional year). Prefer get_movie/get_tv when you have a " +
        "TMDB id — they already include these ratings. Requires OMDB_API_KEY. One of imdb_id or " +
        "title is required; omitting both returns an error. A no-match lookup is not an error: it " +
        "returns `{found:false, reason}`.",
      inputSchema: z
        .object({
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
        })
        .strict(),
      outputSchema: ratingsSchema,
      annotations: READ_ONLY,
    },
    ({ imdb_id, title, year }) => {
      const stale = trackStale();
      return requireConfigured(
        omdb,
        () =>
          imdb_id
            ? omdb.ratingsByImdbId(imdb_id, stale.onStale)
            : omdb.ratingsByTitle(title!, year, stale.onStale),
        () => (!imdb_id && !title ? "Provide either imdb_id or title." : undefined),
        stale.meta,
      );
    },
  );
}
