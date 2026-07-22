// MCP Prompts: reusable prompt templates that hand the calling model a
// multi-step plan instead of a single structured result. A prompt returns
// instructions the model then carries out using the tools registered in
// tools/tmdb.ts (search/get_similar/discover/...) — it doesn't call any
// upstream itself.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

// Prompt arguments always arrive as strings over MCP (there's no argument
// JSON-Schema, only name/description/required) — z.string()/z.enum() only.
const COUNT_DEFAULT = "5";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "recommend_similar",
    {
      title: "Recommend similar movies/TV",
      description:
        "Plan a search for movies or TV shows similar to a given title, using TMDB's " +
        "similarity/recommendation data (and discover as a fallback) rather than the " +
        "model's own knowledge. Use this instead of calling get_similar/get_movie_recommendations " +
        "yourself when you want the merged, ranked shortlist in one step; call those tools " +
        "directly only if you already have a specific TMDB id and just need its raw candidate list.",
      argsSchema: z.object({
        title: z.string().min(1).describe("A movie or TV show title the user liked."),
        media_type: z
          .enum(["movie", "tv"])
          .describe(
            "Restrict to movie or tv; omit to let the model resolve it from search results.",
          )
          .optional(),
        count: z
          .string()
          .regex(/^\d+$/, "count must be a whole number, e.g. '5'.")
          .describe(`How many recommendations to return (default ${COUNT_DEFAULT}).`)
          .optional(),
      }),
    },
    ({ title, media_type, count }) => {
      const n = count ?? COUNT_DEFAULT;
      const kindHint = media_type ? ` (a ${media_type})` : "";
      return {
        description: `Recommend titles similar to "${title}"`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `I liked "${title}"${kindHint}. Recommend ${n} similar movies or TV shows using ` +
                `the available tools — don't rely on your own memory for the candidate list or ratings.\n\n` +
                `1. Resolve "${title}" to a TMDB id: use search_multi (or search_movies/search_tv if the ` +
                `media type is already known) and pick the best match.\n` +
                `2. Call get_similar and get_movie_recommendations/get_tv_recommendations for that id and ` +
                `merge the candidates — weigh get_movie_recommendations as the stronger signal (it's ` +
                `behavioral/co-viewing data), and use get_similar's genre/keyword matches mainly to fill ` +
                `gaps, discarding any that don't actually fit thematically.\n` +
                `3. If that pool has fewer than ${n} good candidates, broaden with discover_movies/` +
                `discover_tv filtered to the same genres.\n` +
                `4. Once you've picked the best ${n} ids, call get_movies/get_tv_shows with ` +
                `include_ratings=true for all of them in one call (not get_movie/get_tv per title) to ` +
                `get title, year and ratings together. Return each with a one-line reason it fits.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "top_by_entity",
    {
      title: "Top titles from a person or studio",
      description:
        "Find the best-regarded movies/TV from a specific person (actor, director, composer, …) " +
        "or production company/studio, optionally restricted to one genre — 'A24's top movies', " +
        "'Tarantino's best films', 'which of Joe Hisaishi's scores are for animated films'. " +
        "Resolves the name to a TMDB id (search_people/search_companies) then ranks with " +
        "discover_movies/discover_tv, filtering out low-vote noise; for a person's TV work " +
        "specifically it goes through get_person_credits instead, since discover_tv can't filter " +
        "by person at all. Use this instead of doing that yourself when you want the ranked " +
        "shortlist in one step.",
      argsSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe(
            "A person's name (actor/director/composer/…) or a production company/studio name.",
          ),
        entity_type: z
          .enum(["person", "company"])
          .describe(
            "Whether `name` is a person or a company/studio. Omit to infer it from search results.",
          )
          .optional(),
        genre: z
          .string()
          .describe("Restrict to one genre, e.g. 'Animation', 'Horror'. Omit for all their work.")
          .optional(),
        media_type: z
          .enum(["movie", "tv"])
          .describe("Restrict to movies or TV shows. Omit to check both.")
          .optional(),
        count: z
          .string()
          .regex(/^\d+$/, "count must be a whole number, e.g. '5'.")
          .describe(`How many titles to return (default ${COUNT_DEFAULT}).`)
          .optional(),
      }),
    },
    ({ name, entity_type, genre, media_type, count }) => {
      const n = count ?? COUNT_DEFAULT;
      const typeHint = entity_type ? ` (a ${entity_type})` : "";
      const genreHint = genre ? ` in the ${genre} genre` : "";
      const mediaHint = media_type ? ` (${media_type} only)` : " (movies and/or TV)";
      return {
        description: `Top ${n} titles from "${name}"${genreHint}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Find the top ${n} best-regarded titles${mediaHint} from "${name}"${typeHint}${genreHint} ` +
                `using the available tools — don't rely on your own memory for the candidate list or ratings.\n\n` +
                `1. Resolve "${name}" to a TMDB id: use search_people if it's a person, search_companies if ` +
                `it's a company/studio (guess from context if entity_type wasn't given). Names aren't always ` +
                `unique — search_companies in particular can return several unrelated companies sharing the ` +
                `exact same name in different countries (e.g. "A24" also matches unrelated companies literally ` +
                `named "A24" elsewhere) — for a person, disambiguate with known_for_department/popularity; for ` +
                `a company, with origin_country (prefer the one based where the studio actually is).\n` +
                (genre
                  ? `2. Resolve "${genre}" to a genre id via get_movie_genres/get_tv_genres.\n`
                  : "") +
                `${genre ? "3" : "2"}. For movies: call discover_movies with with_people (person id — ` +
                `matches cast OR crew) or with_companies (company id)${genre ? ", plus with_genres from step 2" : ""}, ` +
                `sort_by=vote_average.desc, and a min_votes floor (e.g. 100-1000, higher for a very well-known ` +
                `entity) to exclude single-vote noise.\n` +
                `${genre ? "4" : "3"}. For TV: if this is a COMPANY, discover_tv's with_companies works the same ` +
                `way as step above. If this is a PERSON, discover_tv can NOT filter by person at all (TMDB ` +
                `silently ignores with_cast/with_crew/with_people there) — instead call get_person_credits for ` +
                `that id, keep only entries with media_type 'tv', then batch-fetch ratings/genres for those ids ` +
                `via get_tv_shows in one call and filter to the requested genre yourself if one was given.\n` +
                `${genre ? "5" : "4"}. Merge whichever of movies/TV apply, sort by rating, and return the top ` +
                `${n}: title/name, year, media type, and rating.`,
            },
          },
        ],
      };
    },
  );
}
