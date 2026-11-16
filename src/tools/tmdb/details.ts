// Detail lookups for a known TMDB id: movies, TV, people, credits,
// recommendations, reviews, collections. The OMDb enrichment in
// getEnrichedDetail/maybeEnrich is the one place the two upstreams meet.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { TmdbClient } from "../../clients/tmdb.ts";
import type { OmdbClient } from "../../clients/omdb.ts";
import {
  PERSON_CREDITS_LIMIT,
  movieCard,
  notFoundCard,
  ratingsNotFound,
  ratingsYearConflict,
  summarizeRatings,
  tvCard,
} from "../../format.ts";
import {
  collectionSchema,
  creditsSchema,
  movieCardSchema,
  movieDetailEnrichedSchema,
  movieOrTvSchema,
  movieSummarySchema,
  pageSchema,
  personCreditsSchema,
  personDetailSchema,
  reviewSchema,
  tvCardSchema,
  tvCreditsSchema,
  tvDetailEnrichedSchema,
  tvSummarySchema,
} from "../../format.schemas.ts";
import { toProblem } from "../../lib/result.ts";
import type { Logger } from "../../lib/logger.ts";
import { READ_ONLY } from "../shared.ts";
import {
  includeRatings,
  includeRatingsBatch,
  mediaKind,
  movieIdsBatch,
  page,
  filteredPage,
  personCreditsLimit,
  personDepartment,
  collectionId,
  mediaId,
  movieId,
  personId,
  tvId,
  tvIdsBatch,
  expandEpisodes,
  type TmdbToolDeps,
} from "./fields.ts";

// get_movies/get_tv_shows: what getCards does with an id that fails.
const CARD_FAILURE =
  "An id that fails to load (unknown, or hit by an upstream error such as a rate limit) " +
  "never fails the whole call: that entry comes back `{id, found:false, reason}` instead, in the " +
  "same order as `ids`; read `reason` before concluding the id doesn't exist.";

export function registerDetailsTools(
  server: McpServer,
  { tmdb, omdb, requireTmdb, region, language }: TmdbToolDeps,
): void {
  server.registerTool(
    "get_movie",
    {
      title: "Get movie details",
      description:
        "Get full details for one movie by TMDB id: overview, genres, keywords (`{id, name}`), " +
        "runtime, budget/revenue, vote average, the age/content rating (certification) for " +
        "`region` (falling back to the US rating, then any available country, when `region` has " +
        "none; check `certification_region` to see which one was used), and links (TMDB + IMDb). " +
        "By default also includes IMDb/Rotten Tomatoes/Metacritic ratings and an awards summary " +
        "(see include_ratings), plus OMDb's own age rating (`ratings.rated`, separate from this " +
        "tool's `certification`; the two can differ), from OMDb (set include_ratings=false to " +
        "skip). If unavailable (no OMDB_API_KEY, no imdb_id, or the OMDb lookup fails), " +
        "`ratings` degrades to `{found:false, reason}` instead of failing the call. For titles " +
        "like this one, get_movie_recommendations is the first stop; to match its themes " +
        "instead, pass 2-3 distinctive keyword ids to discover_movies' with_keywords joined " +
        "with ',' (all must match; checked live: The Matrix's 'man vs machine', 'artificial " +
        "intelligence', 'dystopia' give the Terminator films); '|' broadens to any one. If you " +
        "only need the headline info (title/year/genres/vote average), for one id or several, " +
        "use get_movies: it's trimmed and skips the rest of this payload. Get the id from " +
        "search_movies.",
      inputSchema: z.strictObject({
        id: movieId,
        region: region.describe(
          "The user's country (pass it when known), whose age rating `certification` shows (falling back to the US " +
            "rating, then any country's).",
        ),
        language,
        include_ratings: includeRatings,
      }),
      outputSchema: movieDetailEnrichedSchema,
      annotations: READ_ONLY,
    },
    ({ id, region: r, language: lang, include_ratings }, ctx) => {
      return requireTmdb(
        () => getEnrichedDetail("movie", id, r, lang, include_ratings, tmdb, omdb, false),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "get_tv",
    {
      title: "Get TV show details",
      description:
        "Get full details for one TV show by TMDB id: overview, genres, keywords (`{id, name}`), " +
        "seasons/episodes counts, networks, created_by (the show's creator(s)), status, the " +
        "age/content rating (certification) for `region` (falling back to the US rating, then " +
        "any available country, when `region` has none; check `certification_region` to see " +
        "which one was used), and links. " +
        "By default also includes IMDb/Rotten Tomatoes/Metacritic ratings and an awards summary " +
        "(see include_ratings), plus OMDb's own age rating (`ratings.rated`, separate from this " +
        "tool's `certification`; the two can differ), from OMDb (set include_ratings=false to " +
        "skip). If unavailable (no OMDB_API_KEY, no imdb_id, or the OMDb lookup fails), " +
        "`ratings` degrades to `{found:false, reason}` instead of failing the call. For shows " +
        "like this one, get_tv_recommendations is the first stop; to match its themes instead, " +
        "pass 2-3 distinctive keyword ids to discover_tv's with_keywords. A show's keywords " +
        "are sparser, so ',' (all) often matches only the show itself and '|' (any) is the " +
        "usual pick (checked live: Breaking Bad's 'drug dealer'|'outlaw' give The Sopranos, " +
        "Narcos, Peaky Blinders). Set expand_episodes=true to also pull the seasons' episode " +
        "lists (up to 250 episodes, 50 per season; see that field) instead of calling " +
        "get_tv_season per season. If you only need the headline info (name/year/genres/vote " +
        "average, season/episode counts), for one id or several, use get_tv_shows: it's " +
        "trimmed and skips the rest of this payload. Get the id from search_tv.",
      inputSchema: z.strictObject({
        id: tvId,
        region: region.describe(
          "The user's country (pass it when known), whose age rating `certification` shows (falling back to the US " +
            "rating, then any country's).",
        ),
        language,
        include_ratings: includeRatings,
        expand_episodes: expandEpisodes,
      }),
      outputSchema: tvDetailEnrichedSchema,
      annotations: READ_ONLY,
    },
    ({ id, region: r, language: lang, include_ratings, expand_episodes }, ctx) => {
      return requireTmdb(
        () => getEnrichedDetail("tv", id, r, lang, include_ratings, tmdb, omdb, expand_episodes),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "get_movies",
    {
      title: "Get compact movie card(s)",
      description:
        "Get a compact card (title, year, genres, vote average, and opt-in ratings) for 1-20 " +
        "movies by TMDB id in one call. Trimmed: no overview, cast, budget, certifications, " +
        "production companies, etc. Use it for a single id too when you only need that headline " +
        "info, not just for checking many at once. Call get_movie instead for the full details " +
        "of a title (including region-specific certification). " +
        CARD_FAILURE,
      inputSchema: z.strictObject({
        ids: movieIdsBatch,
        language,
        include_ratings: includeRatingsBatch,
      }),
      outputSchema: z.strictObject({ results: z.array(movieCardSchema) }),
      annotations: READ_ONLY,
    },
    ({ ids, language: lang, include_ratings }, ctx) => {
      return requireTmdb(
        () =>
          getCards(
            ids,
            (id) =>
              getEnrichedDetail("movie", id, undefined, lang, include_ratings, tmdb, omdb, false),
            movieCard,
            tmdb.logger,
          ),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "get_tv_shows",
    {
      title: "Get compact TV show card(s)",
      description:
        "Get a compact card (name, year, genres, vote average, season/episode counts, and " +
        "opt-in ratings) for 1-20 TV shows by TMDB id in one call. A quick way to spot " +
        "short/miniseries shows (low episode count) across many candidates without a per-title " +
        "get_tv call. Otherwise trimmed: no overview, episode list, networks, certifications, " +
        "etc. Use it for a single id too when you only need that headline info, not just for " +
        "checking many at once. Call get_tv instead for the full details of a title (including " +
        "region-specific certification). " +
        CARD_FAILURE,
      inputSchema: z.strictObject({
        ids: tvIdsBatch,
        language,
        include_ratings: includeRatingsBatch,
      }),
      outputSchema: z.strictObject({ results: z.array(tvCardSchema) }),
      annotations: READ_ONLY,
    },
    ({ ids, language: lang, include_ratings }, ctx) => {
      return requireTmdb(
        () =>
          getCards(
            ids,
            (id) =>
              getEnrichedDetail("tv", id, undefined, lang, include_ratings, tmdb, omdb, false),
            tvCard,
            tmdb.logger,
          ),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "get_person",
    {
      title: "Get person details",
      description:
        "Get full details for one person by TMDB id: biography, birthday/deathday, department, and " +
        "links (TMDB + IMDb). Does not include filmography; use get_person_credits for that. Get " +
        "the id from search_people or a credits list.",
      inputSchema: z.strictObject({ id: personId, language }),
      outputSchema: personDetailSchema,
      annotations: READ_ONLY,
    },
    ({ id, language: lang }, ctx) => {
      return requireTmdb(() => tmdb.getPerson(id, lang), ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "get_movie_credits",
    {
      title: "Get movie cast & crew",
      description:
        "List the top-billed cast (up to 20) and the headline crew (director, writers, composer, " +
        "DoP, …) of a movie by TMDB id. Get the id from search_movies.",
      inputSchema: z.strictObject({ id: movieId }),
      outputSchema: creditsSchema,
      annotations: READ_ONLY,
    },
    ({ id }, ctx) => {
      return requireTmdb(() => tmdb.getMovieCredits(id, undefined), ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "get_tv_credits",
    {
      title: "Get TV cast & crew",
      description:
        "List a TV show's cast and key crew across its whole run, by TMDB id: up to 20 cast " +
        "members ranked by how many episodes they appear in (each with their main character and " +
        "episode_count), plus up to 5 people per key crew job — Director, Writer, Teleplay, " +
        "Story, Executive Producer, Producer, Original Music Composer, Director of Photography, " +
        "ranked by episode_count, so 'who directed most of it' is the first Director listed. " +
        "Creators aren't listed here; use get_tv's `created_by`. For one specific episode's " +
        "director/writer, use get_tv_episode. Get the id from search_tv.",
      inputSchema: z.strictObject({ id: tvId }),
      outputSchema: tvCreditsSchema,
      annotations: READ_ONLY,
    },
    ({ id }, ctx) => {
      return requireTmdb(() => tmdb.getTvCredits(id, undefined), ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "get_movie_recommendations",
    {
      title: "Get movie recommendations",
      description:
        "Get movies TMDB recommends for the given movie id, based on co-viewing/personalization " +
        "data (what users who liked this also liked), usually the more thematically relevant " +
        "list. Prefer this over get_similar by default; get_similar matches on shared " +
        "genres/keywords, a blunter heuristic that can surface tonally unrelated titles. Get the " +
        "id from search_movies.",
      inputSchema: z.strictObject({ id: movieId, page: filteredPage.optional() }),
      outputSchema: pageSchema(movieSummarySchema),
      annotations: READ_ONLY,
    },
    ({ id, page: pg }, ctx) =>
      requireTmdb(
        () => tmdb.getRecommendations("movie", id, pg, undefined, ctx.mcpReq.signal),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "get_tv_recommendations",
    {
      title: "Get TV recommendations",
      description:
        "Get TV shows TMDB recommends for the given show id, based on co-viewing/personalization " +
        "data (what users who liked this also liked), usually the more thematically relevant " +
        "list. Prefer this over get_similar by default; get_similar matches on shared " +
        "genres/keywords, a blunter heuristic that can surface tonally unrelated titles. Get the " +
        "id from search_tv.",
      inputSchema: z.strictObject({ id: tvId, page: filteredPage.optional() }),
      outputSchema: pageSchema(tvSummarySchema),
      annotations: READ_ONLY,
    },
    ({ id, page: pg }, ctx) =>
      requireTmdb(
        () => tmdb.getRecommendations("tv", id, pg, undefined, ctx.mcpReq.signal),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "get_similar",
    {
      title: "Get similar titles",
      description:
        "Get titles TMDB considers similar to a given movie or TV show, based on shared genres " +
        "and keywords. This is a blunter heuristic than get_movie_recommendations/" +
        "get_tv_recommendations' behavioral (co-viewing) data, so results are often " +
        "thematically noisy (checked live: The Matrix's first page mixes Videodrome and Dune " +
        "with The Man with the Golden Gun). Returned in TMDB's order, up to 20 per page " +
        "(adult/softcore titles are dropped, as on every list TMDB doesn't filter itself). The " +
        "list runs into the whole catalog (total_results 20001 for The Matrix), so only the " +
        "first page or two are worth reading. Try recommendations first for thematically closer " +
        "picks; use this when you specifically want genre/keyword-adjacent titles. Get the id " +
        "from search_movies/search_tv.",
      inputSchema: z.strictObject({
        media_type: mediaKind,
        id: mediaId,
        page: filteredPage.optional(),
      }),
      outputSchema: pageSchema(movieOrTvSchema),
      annotations: READ_ONLY,
    },
    ({ media_type, id, page: pg }, ctx) =>
      requireTmdb(
        () => tmdb.getSimilar(media_type, id, pg, undefined, ctx.mcpReq.signal),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "get_reviews",
    {
      title: "Get user reviews",
      description:
        "Get user reviews for a movie or TV show: author, that reviewer's own 0-10 `rating` if " +
        "they left one (a single person's score, not the aggregate `vote_average` and not an " +
        "IMDb/RT/Metacritic value; it can be null), and the review text, clipped to ~1500 " +
        "characters. Get the id from search_movies/search_tv.",
      inputSchema: z.strictObject({ media_type: mediaKind, id: mediaId, page: page.optional() }),
      outputSchema: pageSchema(reviewSchema),
      annotations: READ_ONLY,
    },
    ({ media_type, id, page: pg }, ctx) =>
      requireTmdb(
        () => tmdb.getReviews(media_type, id, pg, undefined, ctx.mcpReq.signal),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "get_collection",
    {
      title: "Get a movie collection",
      description:
        "Get a movie collection/franchise and all its parts in release order (e.g. the whole " +
        "'The Dark Knight Collection'). Get the collection id from search_collections (by " +
        "franchise name) or from a movie's `collection` field in get_movie. Adult/softcore parts " +
        "are left out.",
      inputSchema: z.strictObject({ id: collectionId, language }),
      outputSchema: collectionSchema,
      annotations: READ_ONLY,
    },
    ({ id, language: lang }, ctx) => {
      return requireTmdb(() => tmdb.getCollection(id, lang), ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "get_person_credits",
    {
      title: "Get person filmography",
      description:
        "List the movies and TV shows a person is known for (cast roles and crew jobs; " +
        "adult/softcore titles left out), most " +
        `popular first, capped to the top ${PERSON_CREDITS_LIMIT} of each by default. ` +
        "Talk-show/awards-show guest appearances ('Self'/'Himself'/'Herself', plus any cast " +
        "credit on a TV talk or news show) and repeat entries for the same title are excluded " +
        "so the list stays about actual roles. A cameo credited under the person's own name is " +
        "kept, since TMDB marks it no differently from a real role (checked live: Tom Hanks's " +
        "top cast row is The Simpsons as 'Tom Hanks (voice)'). A title with several crew jobs " +
        "(writer AND director AND producer on one film) counts once against the crew cap. Cast " +
        "entries include a vote_average; crew entries (director, writer, …) do not, so call " +
        "get_movie/get_tv on the id for a crew credit's own vote_average. Pass department (e.g. " +
        "'Directing') to restrict crew to just that role: the reliable way to get someone's " +
        "complete filmography in one department when their other departments would compete for " +
        "the same cap. For a handful of very prolific people even that isn't enough (e.g. 50+ " +
        "directing credits), so raise `limit` too when department alone still looks short. Use " +
        "for 'what has this actor/director been in'. This tool has no genre filter; for 'which " +
        "of X's movies are animated/horror/etc.' use discover_movies, combining " +
        "with_cast/with_crew/with_people with with_genres. discover_tv can't filter by person at " +
        "all, so for a person's TV work in one genre, call this tool and check the returned " +
        "media_type 'tv' entries' genres yourself, e.g. via get_tv_shows. Get the id from " +
        "search_people.",
      inputSchema: z.strictObject({
        id: personId,
        department: personDepartment,
        limit: personCreditsLimit,
      }),
      outputSchema: personCreditsSchema,
      annotations: READ_ONLY,
    },
    ({ id, department, limit }, ctx) => {
      return requireTmdb(
        () => tmdb.getPersonCredits(id, department, limit, undefined),
        ctx.mcpReq.signal,
      );
    },
  );
}

/** get_movie/get_tv's shared shape: fetch the TMDB detail, then fold in OMDb ratings. */
// Overloads narrow the return type by the mediaType literal, so movieCard/tvCard
// get the single-shape result rather than the movie|tv union.
async function getEnrichedDetail(
  mediaType: "movie",
  id: number,
  region: string | undefined,
  language: string | undefined,
  wantRatings: boolean,
  tmdb: TmdbClient,
  omdb: OmdbClient,
  expandEpisodes?: boolean,
): Promise<z.infer<typeof movieDetailEnrichedSchema>>;
async function getEnrichedDetail(
  mediaType: "tv",
  id: number,
  region: string | undefined,
  language: string | undefined,
  wantRatings: boolean,
  tmdb: TmdbClient,
  omdb: OmdbClient,
  expandEpisodes?: boolean,
): Promise<z.infer<typeof tvDetailEnrichedSchema>>;
async function getEnrichedDetail(
  mediaType: "movie" | "tv",
  id: number,
  region: string | undefined,
  language: string | undefined,
  wantRatings: boolean,
  tmdb: TmdbClient,
  omdb: OmdbClient,
  expandEpisodes = false,
): Promise<
  Awaited<ReturnType<TmdbClient["getMovie"] | TmdbClient["getTv"]>> & {
    ratings?: ReturnType<typeof summarizeRatings>;
  }
> {
  const shaped =
    mediaType === "tv"
      ? await tmdb.getTv(id, region, language, expandEpisodes)
      : await tmdb.getMovie(id, region, language);
  return maybeEnrich(shaped, shaped.imdb_id, wantRatings, omdb);
}

/** get_movies/get_tv_shows' shared body: one compact card per id, in `ids` order;
 * a failed id becomes a `{id, found:false, reason}` card instead of failing the call. */
async function getCards<D, C>(
  ids: number[],
  fetchOne: (id: number) => Promise<D>,
  toCard: (detail: D) => C,
  logger: Logger,
): Promise<{ results: (C | ReturnType<typeof notFoundCard>)[] }> {
  const settled = await Promise.allSettled(ids.map(fetchOne));
  return {
    results: settled.map((result, i) =>
      result.status === "fulfilled"
        ? toCard(result.value)
        : // Same tool-facing text as any other failure, never the raw message.
          notFoundCard(ids[i]!, toProblem(result.reason, logger).detail),
    ),
  };
}

/** Attach OMDb ratings to a TMDB detail object when requested and possible. */
export async function maybeEnrich<T extends Record<string, unknown>>(
  shaped: T,
  imdbId: string | null,
  wantRatings: boolean,
  omdb: OmdbClient,
): Promise<T & { ratings?: ReturnType<typeof summarizeRatings> }> {
  if (!wantRatings) return shaped;
  if (!omdb.configured) {
    return { ...shaped, ratings: ratingsNotFound("OMDB_API_KEY not configured") };
  }
  if (!imdbId) {
    return { ...shaped, ratings: ratingsNotFound("No imdb_id available from TMDB") };
  }
  // OMDb failures must not sink the TMDB result; degrade to found:false.
  try {
    const ratings = await omdb.ratingsByImdbId(imdbId);
    // TMDB's imdb_id is occasionally stale or wrong, and OMDb then returns an
    // unrelated title's ratings. If the release years are far apart, report no
    // match. Year is language-independent, unlike localized titles.
    if (
      ratings.found &&
      ratingsYearConflict(
        (shaped.release_date ?? shaped.first_air_date) as string | null | undefined,
        ratings.year,
      )
    ) {
      return {
        ...shaped,
        ratings: ratingsNotFound(
          "OMDb entry looks unrelated to this title (release-year mismatch — likely a stale imdb_id from TMDB)",
        ),
      };
    }
    return { ...shaped, ratings };
  } catch (err) {
    // Name the cause (e.g. a rejected OMDB_API_KEY → "unauthorized") so the
    // caller can tell a config problem from a transient outage.
    return {
      ...shaped,
      ratings: ratingsNotFound(`OMDb lookup failed: ${toProblem(err, omdb.logger).detail}`),
    };
  }
}
