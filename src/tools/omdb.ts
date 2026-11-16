// get_movie / get_tv already include OMDb ratings; this tool covers an IMDb id
// from an external source or a raw title lookup.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { OmdbClient } from "../clients/omdb.ts";
import { ratingsSchema } from "../format.schemas.ts";
import { READ_ONLY, requireConfigured } from "./shared.ts";

export function registerOmdbTools(server: McpServer, omdb: OmdbClient): void {
  server.registerTool(
    "get_ratings",
    {
      title: "Get IMDb/RT/Metacritic ratings",
      description:
        "Look up IMDb, Rotten Tomatoes and Metacritic ratings, an awards summary and OMDb's own " +
        "age rating (`rated`) from OMDb, by IMDb id (preferred, e.g. 'tt0133093') or by title " +
        "(+ optional year/type). The awards summary is free text (major-award wins/nominations: " +
        "Oscars, Emmys, Golden Globes, etc.), not a structured count, and covers the whole " +
        "film/show, or one episode when given an episode's imdb_id, never one person. Prefer " +
        "get_movie/get_tv when you have a TMDB id: they already include this. Requires " +
        "OMDB_API_KEY. One of imdb_id or title is required; omitting both returns an error. A " +
        "no-match lookup is not an error: it returns `{found:false, reason}`; a refusal (bad key, " +
        "exhausted daily quota) is. " +
        "A title lookup resolves to whichever single entry OMDb picks, reports no runner-up, and " +
        "cannot be validated, so it can silently return a different work of the same name. " +
        "Checked live: `title:'Halloween'` with no year returns the 1978 original (tt0077651, " +
        "IMDb 7.7, RT 97%), not the 2018 film titled exactly the same (tt1502407, IMDb 6.5, RT " +
        "79%). Always read back the returned `imdb_id`/`title`/`year` to confirm which work you " +
        "got, and pass `year` (and `type`) whenever you know them. When you only have a title, " +
        "prefer search_movies/search_tv → get_movie/get_tv: that path matches by imdb_id and " +
        "also drops an OMDb hit whose release year is more than two years from TMDB's, which " +
        "this tool's title path cannot do.",
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
            "Restrict a title lookup to this entry type. Checked live: without it, OMDb's title " +
              "match can silently prefer one type when the same title exists as more than one, " +
              "e.g. a lookup for 'Chuck' with no `type` returns the 2007 TV series, not the " +
              "unrelated 2016 movie of the same name, with no signal the movie was ever in " +
              "contention. Affects only a title lookup; no effect when imdb_id is given (already " +
              "unambiguous).",
          )
          .optional(),
      }),
      outputSchema: ratingsSchema,
      annotations: READ_ONLY,
    },
    ({ imdb_id, title, year, type }, ctx) => {
      return requireConfigured(
        omdb,
        // title! is safe: the validate() callback below runs before this fn and
        // rejects the both-absent case, so a falsy imdb_id here means title is set.
        () => (imdb_id ? omdb.ratingsByImdbId(imdb_id) : omdb.ratingsByTitle(title!, year, type)),
        () => (!imdb_id && !title ? "Provide either imdb_id or title." : undefined),
        ctx.mcpReq.signal,
      );
    },
  );
}
