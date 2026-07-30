// Full/compact detail lookups for a known TMDB id: get_movie/get_tv (full,
// OMDb-enriched), get_movies/get_tv_shows (compact batch), get_person +
// get_person_credits, cast/crew, recommendations/similar, reviews, and
// collections. get_movie/get_tv's OMDb-ratings enrichment (getEnrichedDetail/
// maybeEnrich below) is the one place this server's two upstreams meet.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { TmdbClient } from "../../clients/tmdb.js";
import type { OmdbClient } from "../../clients/omdb.js";
import { movieCard, notFoundCard, summarizeRatings, tvCard } from "../../format.js";
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
  tvDetailEnrichedSchema,
  tvSummarySchema,
} from "../../format.schemas.js";
import { READ_ONLY } from "../shared.js";
import {
  includeRatings,
  includeRatingsBatch,
  language,
  mediaKind,
  movieIdsBatch,
  page,
  personCreditsLimit,
  personDepartment,
  tmdbId,
  tvIdsBatch,
  expandEpisodes,
  type TmdbToolDeps,
} from "./fields.js";

export function registerDetailsTools(
  server: McpServer,
  { tmdb, omdb, requireTmdb, requireTmdbCached, region }: TmdbToolDeps,
): void {
  server.registerTool(
    "get_movie",
    {
      title: "Get movie details",
      description:
        "Get full details for one movie by TMDB id: overview, genres, runtime, budget/revenue, " +
        "vote average, the age/content rating (certification) for `region` — falling back to the " +
        "US rating, then any available country, when `region` has none; check `certification_region` " +
        "to see which one was used — and links (TMDB + IMDb). " +
        "By default also includes IMDb/Rotten Tomatoes/Metacritic ratings, an awards summary " +
        "(major-award wins/nominations — Oscars, Emmys, Golden Globes, etc.; free text, not a " +
        "structured count, for the whole film/show, not one person), and OMDb's own age rating " +
        "(`ratings.rated` — separate from this tool's own `certification` above; the two can differ) " +
        "from OMDb (set include_ratings=false to skip); if unavailable (no OMDB_API_KEY, no imdb_id, or the " +
        "OMDb lookup fails), `ratings` degrades to `{found:false, reason}` instead of failing the " +
        "call. If you only need the headline info (title/year/genres/vote average) — for one id or " +
        "several — use get_movies instead; it's trimmed on purpose and skips the rest of this " +
        "payload. Get the id from search_movies.",
      inputSchema: z
        .object({ id: tmdbId, region, language, include_ratings: includeRatings })
        .strict(),
      outputSchema: movieDetailEnrichedSchema,
      annotations: READ_ONLY,
    },
    ({ id, region: r, language: lang, include_ratings }, ctx) => {
      return requireTmdbCached(
        (onStale) =>
          getEnrichedDetail(
            "movie",
            id,
            r,
            lang,
            include_ratings ?? true,
            tmdb,
            omdb,
            false,
            onStale,
          ),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "get_tv",
    {
      title: "Get TV show details",
      description:
        "Get full details for one TV show by TMDB id: overview, genres, seasons/episodes counts, " +
        "networks, created_by (the show's creator(s)), status, the age/content rating " +
        "(certification) for `region` — falling back to " +
        "the US rating, then any available country, when `region` has none; check " +
        "`certification_region` to see which one was used — and links. " +
        "By default also includes IMDb/Rotten Tomatoes/Metacritic ratings, an awards summary " +
        "(major-award wins/nominations — Oscars, Emmys, Golden Globes, etc.; free text, not a " +
        "structured count, for the whole film/show, not one person), and OMDb's own age rating " +
        "(`ratings.rated` — separate from this tool's own `certification` above; the two can differ) " +
        "from OMDb (set include_ratings=false to skip); if unavailable (no OMDB_API_KEY, no imdb_id, or the " +
        "OMDb lookup fails), `ratings` degrades to `{found:false, reason}` instead of failing the " +
        "call. Set expand_episodes=true to also pull every season's episode list in one extra " +
        "request instead of calling get_tv_season per season. If you only need the headline info " +
        "(name/year/genres/vote average, season/episode counts) — for one id or several — use " +
        "get_tv_shows instead; it's trimmed on purpose and skips the rest of this payload. Get the " +
        "id from search_tv.",
      inputSchema: z
        .object({
          id: tmdbId,
          region,
          language,
          include_ratings: includeRatings,
          expand_episodes: expandEpisodes,
        })
        .strict(),
      outputSchema: tvDetailEnrichedSchema,
      annotations: READ_ONLY,
    },
    ({ id, region: r, language: lang, include_ratings, expand_episodes }, ctx) => {
      return requireTmdbCached(
        (onStale) =>
          getEnrichedDetail(
            "tv",
            id,
            r,
            lang,
            include_ratings ?? true,
            tmdb,
            omdb,
            expand_episodes ?? false,
            onStale,
          ),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "get_movies",
    {
      title: "Get compact movie card(s)",
      description:
        "Get a compact card — title, year, genres, vote average, and (opt-in) ratings — for 1-20 " +
        "movies by TMDB id in one call. Deliberately trimmed (no overview, cast, budget, " +
        "certifications, production companies, etc.): use this for a single id too when you only " +
        "need that headline info and not the full get_movie payload, not just for checking many at " +
        "once. Call get_movie instead when you need the full details for a title (including " +
        "region-specific certification). A bad/unknown id " +
        "never fails the whole call — that entry comes back `{id, found:false, reason}` instead, in " +
        "the same order as `ids`.",
      inputSchema: z
        .object({ ids: movieIdsBatch, language, include_ratings: includeRatingsBatch })
        .strict(),
      outputSchema: z.object({ results: z.array(movieCardSchema) }).strict(),
      annotations: READ_ONLY,
    },
    ({ ids, language: lang, include_ratings }, ctx) => {
      return requireTmdbCached(async (onStale) => {
        const settled = await Promise.allSettled(
          ids.map((id) =>
            getEnrichedDetail(
              "movie",
              id,
              undefined,
              lang,
              include_ratings ?? false,
              tmdb,
              omdb,
              false,
              onStale,
            ),
          ),
        );
        return {
          results: settled.map((result, i) =>
            result.status === "fulfilled"
              ? movieCard(result.value)
              : notFoundCard(ids[i]!, errorReason(result.reason)),
          ),
        };
      }, ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "get_tv_shows",
    {
      title: "Get compact TV show card(s)",
      description:
        "Get a compact card — name, year, genres, vote average, season/episode counts, and (opt-in) " +
        "ratings — for 1-20 TV shows by TMDB id in one call. A quick way to spot short/miniseries " +
        "shows (low episode count) across many candidates without a per-title get_tv call. " +
        "Deliberately trimmed otherwise (no overview, the actual episode list, networks, " +
        "certifications, etc.): use this for a single id too when you only need that headline info " +
        "and not the full get_tv payload, not just for checking many at once. Call get_tv instead " +
        "when you need the full details for a title (including region-specific certification). A " +
        "bad/unknown id never fails the whole call — " +
        "that entry comes back `{id, found:false, reason}` instead, in the same order as `ids`.",
      inputSchema: z
        .object({ ids: tvIdsBatch, language, include_ratings: includeRatingsBatch })
        .strict(),
      outputSchema: z.object({ results: z.array(tvCardSchema) }).strict(),
      annotations: READ_ONLY,
    },
    ({ ids, language: lang, include_ratings }, ctx) => {
      return requireTmdbCached(async (onStale) => {
        const settled = await Promise.allSettled(
          ids.map((id) =>
            getEnrichedDetail(
              "tv",
              id,
              undefined,
              lang,
              include_ratings ?? false,
              tmdb,
              omdb,
              false,
              onStale,
            ),
          ),
        );
        return {
          results: settled.map((result, i) =>
            result.status === "fulfilled"
              ? tvCard(result.value)
              : notFoundCard(ids[i]!, errorReason(result.reason)),
          ),
        };
      }, ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "get_person",
    {
      title: "Get person details",
      description:
        "Get full details for one person by TMDB id: biography, birthday/deathday, department, and " +
        "links (TMDB + IMDb). Does not include filmography — use get_person_credits for that. Get " +
        "the id from search_people or a credits list.",
      inputSchema: z.object({ id: tmdbId, language }).strict(),
      outputSchema: personDetailSchema,
      annotations: READ_ONLY,
    },
    ({ id, language: lang }, ctx) => {
      return requireTmdbCached((onStale) => tmdb.getPerson(id, lang, onStale), ctx.mcpReq.signal);
    },
  );

  server.registerTool(
    "get_movie_credits",
    {
      title: "Get movie cast & crew",
      description:
        "List the top-billed cast (up to 20) and the headline crew (director, writers, composer, " +
        "DoP, …) of a movie by TMDB id. Get the id from search_movies.",
      inputSchema: z.object({ id: tmdbId }).strict(),
      outputSchema: creditsSchema,
      annotations: READ_ONLY,
    },
    ({ id }, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.getMovieCredits(id, undefined, onStale),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "get_tv_credits",
    {
      title: "Get TV cast & crew",
      description:
        "List the main cast (up to 20) and production crew (executive producers, producers, " +
        "composer, DoP, …) of a TV show by TMDB id. TMDB's show-level TV credits data does not " +
        "reliably expose director/writer/creator credits — verified live across several shows " +
        "(Breaking Bad, Stranger Things, Chernobyl, The Queen's Gambit): each show's actual " +
        "creator/head-writer/director appears only as 'Executive Producer', never as 'Writer', " +
        "'Director' or 'Creator'. For who created the show, use get_tv's own `created_by` field " +
        "instead; for a specific episode's actual director/writer (which TMDB does track " +
        "reliably at that level), use get_tv_episode. Get the id from search_tv.",
      inputSchema: z.object({ id: tmdbId }).strict(),
      outputSchema: creditsSchema,
      annotations: READ_ONLY,
    },
    ({ id }, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.getTvCredits(id, undefined, onStale),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "get_movie_recommendations",
    {
      title: "Get movie recommendations",
      description:
        "Get movies TMDB recommends for the given movie id, based on co-viewing/personalization " +
        "data (what users who liked this also liked) — usually the more thematically relevant " +
        "list. Prefer this over get_similar as the default choice; get_similar matches on shared " +
        "genres/keywords, a blunter heuristic that can surface tonally unrelated titles. Get the " +
        "id from search_movies.",
      inputSchema: z.object({ id: tmdbId, page: page.optional() }).strict(),
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
        "data (what users who liked this also liked) — usually the more thematically relevant " +
        "list. Prefer this over get_similar as the default choice; get_similar matches on shared " +
        "genres/keywords, a blunter heuristic that can surface tonally unrelated titles. Get the " +
        "id from search_tv.",
      inputSchema: z.object({ id: tmdbId, page: page.optional() }).strict(),
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
        "and keywords — a blunter heuristic than get_movie_recommendations'/get_tv_recommendations' " +
        "behavioral (co-viewing) data, so results can still be thematically noisy (matching on a " +
        "shared keyword despite an unrelated tone or plot). Results sharing only the source title's " +
        "broadest genre (e.g. two titles that are both merely tagged 'Drama' among several genres) " +
        "are filtered out per page, since a title with a common genre can otherwise return results " +
        "spanning TMDB's entire catalog; a page can come back thin or empty for a niche title once " +
        "that filter applies. Try recommendations first for thematically closer picks; use this when " +
        "you specifically want genre/keyword-adjacent titles. Get the id from search_movies/search_tv.",
      inputSchema: z.object({ media_type: mediaKind, id: tmdbId, page: page.optional() }).strict(),
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
        "Get user reviews for a movie or TV show (author, their rating, and the review text, " +
        "clipped to ~1500 characters). Get the id from search_movies/search_tv.",
      inputSchema: z.object({ media_type: mediaKind, id: tmdbId, page: page.optional() }).strict(),
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
        "'The Dark Knight Collection'). Get the collection id from a movie's `collection` field in get_movie.",
      inputSchema: z.object({ id: tmdbId, language: language.optional() }).strict(),
      outputSchema: collectionSchema,
      annotations: READ_ONLY,
    },
    ({ id, language: lang }, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.getCollection(id, lang, onStale),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "get_person_credits",
    {
      title: "Get person filmography",
      description:
        "List the movies and TV shows a person is known for (cast roles and crew jobs), most " +
        "popular first, capped to the top 25 of each by default; talk-show/awards-show guest " +
        "appearances ('Self'/'Himself'/'Herself') and repeat entries for the same title are excluded " +
        "so the list stays about actual roles. A title with several crew jobs (writer AND director " +
        "AND producer on one film) still only counts once against the crew cap. Cast entries " +
        "include a vote_average; crew entries (director, writer, …) do not — call get_movie/get_tv " +
        "on the id for a crew credit's rating. Pass department (e.g. 'Directing') to restrict crew " +
        "to just that role — the reliable way to get someone's complete filmography in one " +
        "department when their other departments would otherwise compete for the same cap; for a " +
        "handful of exceptionally prolific people even that isn't enough (e.g. 50+ directing " +
        "credits), so raise `limit` too when department alone still looks short. Use for 'what has " +
        "this actor/director been in'. This tool has no genre filter — for 'which of X's movies are " +
        "animated/horror/etc.' use discover_movies instead, combining with_cast/with_crew/" +
        "with_people with with_genres (discover_tv has no equivalent — it can't filter by person at " +
        "all — so for a person's TV work in one genre, call this tool and check the returned " +
        "media_type 'tv' entries' genres yourself, e.g. via get_tv_shows). Get the id from " +
        "search_people.",
      inputSchema: z
        .object({ id: tmdbId, department: personDepartment, limit: personCreditsLimit })
        .strict(),
      outputSchema: personCreditsSchema,
      annotations: READ_ONLY,
    },
    ({ id, department, limit }, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.getPersonCredits(id, department, limit, undefined, onStale),
        ctx.mcpReq.signal,
      );
    },
  );
}

/** get_movies/get_tv_shows: a rejected per-id fetch becomes that entry's `reason`. */
function errorReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** get_movie/get_tv's shared shape: fetch the TMDB detail, then fold in OMDb ratings. */
// Overloads narrow the return type by the mediaType literal — movieCard/tvCard
// (get_movies/get_tv_shows) each call this with a fixed "movie"/"tv" and need
// the matching single-shape result, not the movie|tv union the plain
// signature would otherwise give every caller regardless of which literal
// they passed.
async function getEnrichedDetail(
  mediaType: "movie",
  id: number,
  region: string | undefined,
  language: string | undefined,
  wantRatings: boolean,
  tmdb: TmdbClient,
  omdb: OmdbClient,
  expandEpisodes?: boolean,
  onStale?: () => void,
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
  onStale?: () => void,
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
  onStale?: () => void,
): Promise<
  Awaited<ReturnType<TmdbClient["getDetailWithImdb"]>>["shaped"] & {
    ratings?: ReturnType<typeof summarizeRatings>;
  }
> {
  const { shaped, imdbId } = await tmdb.getDetailWithImdb(
    mediaType,
    id,
    region,
    language,
    expandEpisodes,
    onStale,
  );
  return maybeEnrich(shaped, imdbId, wantRatings, omdb, onStale);
}

/** Attach OMDb ratings to a TMDB detail object when requested and possible. */
export async function maybeEnrich<T extends Record<string, unknown>>(
  shaped: T,
  imdbId: string | null,
  wantRatings: boolean,
  omdb: OmdbClient,
  onStale?: () => void,
): Promise<T & { ratings?: ReturnType<typeof summarizeRatings> }> {
  if (!wantRatings) return shaped;
  if (!omdb.configured) {
    return { ...shaped, ratings: { found: false, reason: "OMDB_API_KEY not configured" } };
  }
  if (!imdbId) {
    return { ...shaped, ratings: { found: false, reason: "No imdb_id available from TMDB" } };
  }
  // OMDb failures must not sink the TMDB result; degrade to found:false.
  try {
    const ratings = await omdb.ratingsByImdbId(imdbId, onStale);
    return { ...shaped, ratings };
  } catch {
    return { ...shaped, ratings: { found: false, reason: "OMDb lookup failed" } };
  }
}
