// MCP Prompts: reusable prompt templates that hand the calling model a
// multi-step plan instead of a single structured result. A prompt returns
// instructions the model then carries out using the tools registered in
// tools/tmdb/ (search/get_similar/discover/...) — it doesn't call any
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
        "Plan a merged, ranked shortlist of movies/TV similar to a given title, using TMDB's " +
        "similarity/recommendation data (with discover as fallback) rather than model memory. Use " +
        "instead of calling get_similar/get_movie_recommendations yourself; call those directly " +
        "only when you already have a TMDB id and just want its raw candidate list.",
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
          .regex(/^[1-9]\d*$/, "count must be a positive whole number, e.g. '5'.")
          .describe(`How many recommendations to return (default ${COUNT_DEFAULT}).`)
          .optional(),
      }),
    },
    ({ title, media_type, count }) => {
      const n = count ?? COUNT_DEFAULT;
      const kindHint = media_type ? ` (a ${media_type === "tv" ? "TV show" : "movie"})` : "";
      // Name only the given media type's tools, so a TV request isn't told to
      // weigh get_movie_recommendations.
      const t =
        media_type === "tv"
          ? {
              search: "search_tv",
              recs: "get_tv_recommendations",
              discover: "discover_tv",
              batch: "get_tv_shows",
              detail: "get_tv",
              what: "TV shows",
            }
          : media_type === "movie"
            ? {
                search: "search_movies",
                recs: "get_movie_recommendations",
                discover: "discover_movies",
                batch: "get_movies",
                detail: "get_movie",
                what: "movies",
              }
            : {
                search: "search_multi",
                recs: "get_movie_recommendations/get_tv_recommendations",
                discover: "discover_movies/discover_tv",
                batch: "get_movies/get_tv_shows",
                detail: "get_movie/get_tv",
                what: "movies or TV shows",
              };
      return {
        description: `Recommend titles similar to "${title}"`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `I liked "${title}"${kindHint}. Recommend ${n} similar ${t.what} using ` +
                `the available tools — don't rely on your own memory for the candidate list or ratings.\n\n` +
                `1. Resolve "${title}" to a TMDB id: use ${t.search}${media_type ? "" : " (or search_movies/search_tv if the media type is already known)"} and pick the best match.\n` +
                `2. Call get_similar and ${t.recs} for that id and ` +
                `merge the candidates — weigh ${t.recs} as the stronger signal (it's ` +
                `behavioral/co-viewing data), and use get_similar's genre/keyword matches mainly to fill ` +
                `gaps, discarding any that don't actually fit thematically.\n` +
                `3. If that pool has fewer than ${n} good candidates, broaden with ${t.discover} ` +
                `filtered to the same genres.\n` +
                `4. Once you've picked the best ${n} ids, call ${t.batch} with ` +
                `include_ratings=true (not ${t.detail} per title) to get title, year and ratings ` +
                `together — ${t.batch} caps each call at 20 ids, so split into multiple ` +
                `calls if ${n} is more than that. Return each with a one-line reason it fits.`,
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
        "Rank a person's or studio's best-regarded movies/TV, optionally within one genre — " +
        "'A24's top movies', 'Tarantino's best films', 'which of Joe Hisaishi's scores are for " +
        "animated films'. Resolves the name to a TMDB id (search_people/search_companies), then " +
        "ranks via discover_movies/discover_tv (a person's TV work goes through get_person_credits, " +
        "since discover_tv can't filter by person). Use instead of doing that multi-step lookup " +
        "yourself.",
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
          .regex(/^[1-9]\d*$/, "count must be a positive whole number, e.g. '5'.")
          .describe(`How many titles to return (default ${COUNT_DEFAULT}).`)
          .optional(),
      }),
    },
    ({ name, entity_type, genre, media_type, count }) => {
      const n = count ?? COUNT_DEFAULT;
      const typeHint = entity_type ? ` (a ${entity_type})` : "";
      const genreHint = genre ? ` in the ${genre} genre` : "";
      const mediaHint = media_type ? ` (${media_type} only)` : " (movies and/or TV)";
      const includeMovies = media_type !== "tv";
      const includeTv = media_type !== "movie";

      // entity_type, when given, is the caller's answer to "person or company?"
      // — resolve straight to the matching search tool and drop the other
      // branch's disambiguation advice, rather than restating the guess.
      const resolveStep =
        entity_type === "person"
          ? `Resolve "${name}" to a TMDB person id with search_people. Names aren't always unique — ` +
            `disambiguate with known_for_department/popularity.`
          : entity_type === "company"
            ? `Resolve "${name}" to a TMDB company id with search_companies. Company names aren't ` +
              `unique — it can return several unrelated companies sharing the exact same name in ` +
              `different countries (e.g. "A24" also matches unrelated companies literally named ` +
              `"A24" elsewhere) — disambiguate with origin_country (prefer the one based where the ` +
              `studio actually is).`
            : `Resolve "${name}" to a TMDB id: use search_people if it's a person, search_companies if ` +
              `it's a company/studio (guess from context — entity_type wasn't given). Names aren't always ` +
              `unique — search_companies in particular can return several unrelated companies sharing the ` +
              `exact same name in different countries (e.g. "A24" also matches unrelated companies literally ` +
              `named "A24" elsewhere) — for a person, disambiguate with known_for_department/popularity; for ` +
              `a company, with origin_country (prefer the one based where the studio actually is).`;
      const steps: string[] = [resolveStep];
      let genreStepNum: number | undefined;
      if (genre) {
        steps.push(`Resolve "${genre}" to a genre id via get_movie_genres/get_tv_genres.`);
        genreStepNum = steps.length;
      }
      const withGenresHint = genre ? `, plus with_genres from step ${genreStepNum}` : "";
      if (includeMovies) {
        const filterHint =
          entity_type === "person"
            ? `with_people (the person id — matches cast OR crew)`
            : entity_type === "company"
              ? `with_companies (the company id)`
              : `with_people (person id — matches cast OR crew) or with_companies (company id)`;
        steps.push(
          `For movies: call discover_movies with ${filterHint}${withGenresHint}, ` +
            `sort_by=vote_average.desc, and a min_votes floor (e.g. 100-1000, higher for a very well-known ` +
            `entity) to exclude single-vote noise.`,
        );
      }
      if (includeTv) {
        // discover_tv can filter by company but not by person, so this step
        // splits entirely on entity_type — state only the applicable branch
        // when the caller already told us which one it is.
        const companyTvStep =
          `For TV: discover_tv's with_companies works the same way as discover_movies' ` +
          `with_companies filter${genre ? ` (also add with_genres from step ${genreStepNum})` : ""}.`;
        const personTvStep =
          `For TV: discover_tv can NOT filter by person at all — it doesn't even accept ` +
          `with_cast/with_crew/with_people as parameters for TV (a validation error, not a silent ` +
          `no-op) — instead call get_person_credits for that id, keep only entries with media_type ` +
          `'tv', then batch-fetch ratings/genres for those ids via get_tv_shows in one call` +
          `${genre ? ` and filter to the requested genre yourself` : ""}.`;
        steps.push(
          entity_type === "company"
            ? companyTvStep
            : entity_type === "person"
              ? personTvStep
              : `For TV: if this is a COMPANY, discover_tv's with_companies works the same way as ` +
                `discover_movies's with_companies filter${
                  genre ? ` (also add with_genres from step ${genreStepNum})` : ""
                }. If this is a PERSON, discover_tv can NOT filter ` +
                `by person at all — it doesn't even accept with_cast/with_crew/with_people as parameters ` +
                `for TV (a validation error, not a silent no-op) — instead call get_person_credits for ` +
                `that id, keep only entries with media_type 'tv', then batch-fetch ratings/genres for those ids ` +
                `via get_tv_shows in one call${genre ? ` and filter to the requested genre yourself` : ""}.`,
        );
      }
      // "rating" alone would be ambiguous here: the discover step above sorted
      // on TMDB's vote_average, while the get_tv_shows fallback can also carry
      // IMDb/RT/Metacritic values — different scales, not interchangeable.
      const sortTail =
        `sort by TMDB vote_average and return the top ${n}: title/name, year, media type, and that ` +
        `vote_average. If you also pulled IMDb/RT/Metacritic values (include_ratings), report them ` +
        `separately and labeled — they're other scales and audiences, so don't merge or average them ` +
        `into one score.`;
      steps.push(
        includeMovies && includeTv
          ? `Merge whichever of movies/TV apply, then ${sortTail}`
          : `${sortTail.charAt(0).toUpperCase()}${sortTail.slice(1)}`,
      );

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
                steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
            },
          },
        ],
      };
    },
  );
}
