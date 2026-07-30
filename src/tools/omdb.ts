// OMDb-backed tool. get_movie / get_tv already fold OMDb ratings into their
// result; this standalone tool is for the cases where you only have an IMDb id
// (e.g. from an external source) or want to look up ratings by raw title.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { OmdbClient } from "../clients/omdb.js";
import { ratingsSchema } from "../format.schemas.js";
import { READ_ONLY, requireConfiguredCached } from "./shared.js";

export function registerOmdbTools(server: McpServer, omdb: OmdbClient): void {
  server.registerTool(
    "get_ratings",
    {
      title: "Get IMDb/RT/Metacritic ratings",
      description:
        "Look up IMDb, Rotten Tomatoes and Metacritic ratings, an awards summary (major-award " +
        "wins/nominations — Oscars, Emmys, Golden Globes, etc.; free text, not a structured count, " +
        "for the whole film/show, not one person), and OMDb's own age rating (`rated`), from OMDb " +
        "by IMDb id (preferred, e.g. 'tt0133093') or by title (+ optional year/type). Prefer " +
        "get_movie/get_tv when you have a TMDB id — they already include this. Requires " +
        "OMDB_API_KEY. One of imdb_id or title is required; omitting both returns an error. A " +
        "no-match lookup is not an error: it returns `{found:false, reason}`.",
      inputSchema: z.strictObject({
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
        year: z.int().min(1870).max(2100).describe("Year, to disambiguate a title.").optional(),
        type: z
          .enum(["movie", "series", "episode"])
          .describe(
            "Restrict a title lookup to this entry type. Verified live: without it, OMDb's own " +
              "title match can silently prefer one type over another when the exact same title " +
              "exists as more than one — e.g. a title lookup for 'Chuck' with no `type` returns " +
              "the 2007 TV series, not the unrelated 2016 movie of the same name, with no signal " +
              "the movie was ever in contention. Only affects a title lookup; has no effect when " +
              "imdb_id is given (already unambiguous).",
          )
          .optional(),
      }),
      outputSchema: ratingsSchema,
      annotations: READ_ONLY,
    },
    ({ imdb_id, title, year, type }, ctx) => {
      return requireConfiguredCached(
        omdb,
        (onStale) =>
          imdb_id
            ? omdb.ratingsByImdbId(imdb_id, onStale)
            : omdb.ratingsByTitle(title!, year, type, onStale),
        () => (!imdb_id && !title ? "Provide either imdb_id or title." : undefined),
        ctx.mcpReq.signal,
      );
    },
  );
}
