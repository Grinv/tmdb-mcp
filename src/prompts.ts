// MCP Prompts: reusable prompt templates that hand the calling model a
// multi-step plan instead of a single structured result. A prompt returns
// instructions the model then carries out using the tools registered in
// tools/tmdb.ts (search/get_similar/discover/...) — it doesn't call any
// upstream itself.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
        "model's own knowledge.",
      argsSchema: {
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
      },
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
                `merge the candidates.\n` +
                `3. If that pool has fewer than ${n} good candidates, broaden with discover_movies/` +
                `discover_tv filtered to the same genres.\n` +
                `4. Return the best ${n}: title, year, and a one-line reason it fits — include ratings ` +
                `(get_movie/get_tv's include_ratings, or get_ratings) where available.`,
            },
          },
        ],
      };
    },
  );
}
