// Name/title → TMDB id resolvers: search_movies/search_tv/search_people/
// search_multi for titles and people, plus search_keywords/search_companies/
// search_watch_providers for the ids discover_movies/discover_tv's filters need.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  companySchema,
  keywordsSchema,
  multiItemSchema,
  pageSchema,
  personSummarySchema,
  movieSummarySchema,
  tvSummarySchema,
  watchProviderMatchesSchema,
} from "../../format.schemas.js";
import { READ_ONLY } from "../shared.js";
import {
  includeAdult,
  language,
  mediaKind,
  page,
  watchRegion,
  type TmdbToolDeps,
} from "./fields.js";

export function registerSearchTools(
  server: McpServer,
  { tmdb, requireTmdb, requireTmdbCached, region }: TmdbToolDeps,
): void {
  server.registerTool(
    "search_movies",
    {
      title: "Search movies",
      description:
        "Search TMDB movies by title; returns compact summaries with the TMDB id that the other " +
        "movie tools (get_movie, get_movie_credits, …) require, plus pagination info. Use this over " +
        "search_multi when you already know the result is a movie. `region` here only picks which " +
        "country's release_date is shown per result (e.g. a title's US vs. India theatrical date) — " +
        "verified live, it does not filter which movies match or reorder them; for actual " +
        "region-based availability use get_watch_providers instead.",
      inputSchema: z
        .object({
          query: z.string().min(1).describe("Movie title to search for."),
          year: z.number().int().min(1870).max(2100).describe("Filter by release year.").optional(),
          include_adult: includeAdult,
          language,
          region,
          page: page.optional(),
        })
        .strict(),
      outputSchema: pageSchema(movieSummarySchema),
      annotations: READ_ONLY,
    },
    (args, ctx) => requireTmdb(() => tmdb.searchMovies(args, ctx.mcpReq.signal), ctx.mcpReq.signal),
  );

  server.registerTool(
    "search_tv",
    {
      title: "Search TV shows",
      description:
        "Search TMDB TV shows by name; returns compact summaries with the TMDB id that get_tv and " +
        "the other TV tools require. Use this over search_multi when you already know the result is " +
        "a TV show.",
      inputSchema: z
        .object({
          query: z.string().min(1).describe("TV show name to search for."),
          year: z
            .number()
            .int()
            .min(1870)
            .max(2100)
            .describe("Filter by first-air-date year.")
            .optional(),
          include_adult: includeAdult,
          language,
          page: page.optional(),
        })
        .strict(),
      outputSchema: pageSchema(tvSummarySchema),
      annotations: READ_ONLY,
    },
    (args, ctx) => requireTmdb(() => tmdb.searchTv(args, ctx.mcpReq.signal), ctx.mcpReq.signal),
  );

  server.registerTool(
    "search_multi",
    {
      title: "Search everything",
      description:
        "Search movies, TV shows and people in one call. Each result carries a media_type " +
        "('movie' | 'tv' | 'person') so you can route to the right get_* tool. Use when the user's " +
        "query could be any of these; if you already know the type, search_movies/search_tv/" +
        "search_people are more precise.",
      inputSchema: z
        .object({
          query: z.string().min(1).describe("Free-text query."),
          include_adult: includeAdult,
          language,
          page: page.optional(),
        })
        .strict(),
      outputSchema: pageSchema(multiItemSchema),
      annotations: READ_ONLY,
    },
    (args, ctx) => requireTmdb(() => tmdb.searchMulti(args, ctx.mcpReq.signal), ctx.mcpReq.signal),
  );

  server.registerTool(
    "search_people",
    {
      title: "Search people",
      description:
        "Search TMDB people (actors, directors, crew) by name; returns the TMDB id needed by " +
        "get_person plus their top 5 best-known titles (known_for). Use this over search_multi when " +
        "you already know the result is a person.",
      inputSchema: z
        .object({
          query: z.string().min(1).describe("Person name to search for."),
          include_adult: includeAdult,
          language,
          page: page.optional(),
        })
        .strict(),
      outputSchema: pageSchema(personSummarySchema),
      annotations: READ_ONLY,
    },
    (args, ctx) => requireTmdb(() => tmdb.searchPeople(args, ctx.mcpReq.signal), ctx.mcpReq.signal),
  );

  server.registerTool(
    "search_keywords",
    {
      title: "Search keywords",
      description:
        "Resolve keyword names to TMDB keyword ids (e.g. 'time travel', 'based on true story'). " +
        "Feed the ids into discover_movies/discover_tv via with_keywords / without_keywords.",
      inputSchema: z
        .object({
          query: z.string().min(1).describe("Keyword text to look up."),
          page: page.optional(),
        })
        .strict(),
      outputSchema: keywordsSchema,
      annotations: READ_ONLY,
    },
    ({ query, page: pg }, ctx) =>
      requireTmdb(() => tmdb.searchKeywords(query, pg, ctx.mcpReq.signal), ctx.mcpReq.signal),
  );

  server.registerTool(
    "search_companies",
    {
      title: "Search production companies",
      description:
        "Resolve a production company's name to its TMDB numeric id (e.g. 'A24', 'Pixar'). Feed the " +
        "id into discover_movies/discover_tv via with_companies. Company names aren't unique — TMDB " +
        "can have several unrelated companies sharing the same name (e.g. two different 'A24's, one " +
        "US and one GB) — check origin_country and logo_url to tell rows apart when a name matches " +
        "more than one.",
      inputSchema: z
        .object({
          query: z.string().min(1).describe("Company name to look up."),
          page: page.optional(),
        })
        .strict(),
      outputSchema: pageSchema(companySchema),
      annotations: READ_ONLY,
    },
    ({ query, page: pg }, ctx) =>
      requireTmdb(() => tmdb.searchCompanies(query, pg, ctx.mcpReq.signal), ctx.mcpReq.signal),
  );

  server.registerTool(
    "search_watch_providers",
    {
      title: "Search streaming/rental providers",
      description:
        "Resolve a streaming/rental/purchase service's name (e.g. 'Netflix', 'Disney Plus') to its " +
        "TMDB numeric provider id. Feed the id into discover_movies/discover_tv's " +
        "with_watch_providers (with watch_region set to the same region given here, if any) to " +
        "find top titles on that service — TMDB has no name-based lookup of its own for this, only " +
        "numeric ids, and there are hundreds of providers (269+ for the US alone, more elsewhere), " +
        "so don't guess an id. A provider's id and even whether it's offered at all can differ by " +
        "region (e.g. a service bundled as a channel add-on in one country vs. standalone in " +
        "another) — pass watch_region to match what discover_movies/discover_tv will actually see; " +
        "omitting it searches the full global provider list instead, which may include ids not valid " +
        "for the region the caller actually cares about.",
      inputSchema: z
        .object({
          query: z
            .string()
            .min(1)
            .describe("Service name (or part of it) to look up, e.g. 'Netflix'."),
          media_type: mediaKind.describe(
            "Whether to search movie or TV providers — the same service can have a different id " +
              "per media type.",
          ),
          watch_region: watchRegion.optional(),
          page: page.optional(),
        })
        .strict(),
      outputSchema: watchProviderMatchesSchema,
      annotations: READ_ONLY,
    },
    ({ query, media_type, watch_region, page: pg }, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.searchWatchProviders(media_type, query, watch_region, pg, onStale),
        ctx.mcpReq.signal,
      );
    },
  );
}
