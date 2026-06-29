// Read-only client for The Movie Database (TMDB) v3 REST API. Auth is a v4
// "Read Access Token" sent as `Authorization: Bearer <token>`. Wraps the generic
// HttpClient with a polite rate limiter and a TTL cache; all raw→agent-facing
// shaping lives in ../format.js. This is the backbone source (search, metadata,
// people, trending); OMDb (see ./omdb.js) only enriches it with ratings.
import { HttpClient } from "../lib/http.js";
import { RateLimiter } from "../lib/rateLimit.js";
import { TtlCache } from "../lib/cache.js";
import {
  detailMovie,
  detailPerson,
  detailTv,
  page,
  summarizeCredits,
  summarizeEpisode,
  summarizeFind,
  summarizeGenres,
  summarizeMovie,
  summarizeMultiItem,
  summarizePersonCredits,
  summarizeSeason,
  summarizeTv,
  summarizeVideos,
  summarizeWatchProviders,
  type CombinedCredits,
  type FindResponse,
  type TmdbCredits,
  type TmdbMovie,
  type TmdbMultiItem,
  type TmdbPage,
  type TmdbPerson,
  type TmdbSeason,
  type TmdbTv,
  type VideosResponse,
  type WatchProvidersResponse,
} from "../format.js";
import type { Logger } from "../lib/logger.js";
import type { Config } from "../config.js";

type Query = Record<string, string | number | boolean | undefined>;

export interface SearchParams {
  query: string;
  year?: number;
  page?: number;
  include_adult?: boolean;
}

export type TrendingMediaType = "all" | "movie" | "tv" | "person";
export type TrendingWindow = "day" | "week";

// Friendly discover params; mapped to TMDB's dotted query keys in the client so
// callers (and the tool schema) avoid awkward names like "vote_average.gte".
export interface DiscoverParams {
  sort_by?: string;
  with_genres?: string;
  year?: number;
  min_rating?: number;
  max_rating?: number;
  min_votes?: number;
  min_runtime?: number;
  with_original_language?: string;
  page?: number;
}

export type ExternalSource = "imdb_id" | "tvdb_id" | "wikidata_id";

export class TmdbClient {
  readonly #http: HttpClient;
  readonly #cache: TtlCache<Record<string, unknown>>;
  /** True when a TMDB token is configured; tools short-circuit otherwise. */
  readonly configured: boolean;

  constructor(config: Config, logger: Logger) {
    this.configured = Boolean(config.tmdbApiToken);
    const limiter = new RateLimiter(config.tmdbMinIntervalMs);
    this.#http = new HttpClient({
      baseUrl: config.tmdbBaseUrl,
      logger,
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
      defaultHeaders: config.tmdbApiToken ? { Authorization: `Bearer ${config.tmdbApiToken}` } : {},
      beforeRequest: () => limiter.acquire(),
    });
    this.#cache = new TtlCache(config.cacheTtlMs);
  }

  // ---- search ---------------------------------------------------------------

  async searchMovies(p: SearchParams): Promise<Record<string, unknown>> {
    const res = await this.#http.getJson<TmdbPage<TmdbMovie>>("search/movie", {
      query: { query: p.query, year: p.year, page: p.page, include_adult: p.include_adult },
    });
    return page(res, summarizeMovie);
  }

  async searchTv(p: SearchParams): Promise<Record<string, unknown>> {
    const res = await this.#http.getJson<TmdbPage<TmdbTv>>("search/tv", {
      query: {
        query: p.query,
        first_air_date_year: p.year,
        page: p.page,
        include_adult: p.include_adult,
      },
    });
    return page(res, summarizeTv);
  }

  async searchMulti(p: SearchParams): Promise<Record<string, unknown>> {
    const res = await this.#http.getJson<TmdbPage<TmdbMultiItem>>("search/multi", {
      query: { query: p.query, page: p.page, include_adult: p.include_adult },
    });
    return page(res, summarizeMultiItem);
  }

  async searchPeople(p: SearchParams): Promise<Record<string, unknown>> {
    const res = await this.#http.getJson<TmdbPage<TmdbMultiItem>>("search/person", {
      query: { query: p.query, page: p.page, include_adult: p.include_adult },
    });
    return page(res, summarizeMultiItem);
  }

  // ---- details (cached: stable, frequently re-requested) --------------------

  async getMovie(id: number): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(`movie:${id}`, async () => {
      const res = await this.#http.getJson<TmdbMovie>(`movie/${id}`);
      return detailMovie(res);
    });
  }

  /** Like getMovie but also returns the raw imdb_id for OMDb enrichment. */
  async getMovieWithImdb(
    id: number,
  ): Promise<{ shaped: Record<string, unknown>; imdbId: string | null }> {
    const shaped = await this.getMovie(id);
    return { shaped, imdbId: (shaped.imdb_id as string | null) ?? null };
  }

  async getTv(id: number): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(`tv:${id}`, async () => {
      // external_ids appended so the TV detail carries an imdb_id (the base
      // /tv/{id} response, unlike /movie/{id}, does not include one).
      const res = await this.#http.getJson<TmdbTv>(`tv/${id}`, {
        query: { append_to_response: "external_ids" },
      });
      return detailTv(res);
    });
  }

  async getTvWithImdb(
    id: number,
  ): Promise<{ shaped: Record<string, unknown>; imdbId: string | null }> {
    const shaped = await this.getTv(id);
    return { shaped, imdbId: (shaped.imdb_id as string | null) ?? null };
  }

  async getPerson(id: number): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(`person:${id}`, async () => {
      const res = await this.#http.getJson<TmdbPerson>(`person/${id}`);
      return detailPerson(res);
    });
  }

  async getMovieCredits(id: number): Promise<Record<string, unknown>> {
    return this.#cached(`movie-credits:${id}`, `movie/${id}/credits`, (c: TmdbCredits) =>
      summarizeCredits(c),
    );
  }

  async getTvCredits(id: number): Promise<Record<string, unknown>> {
    return this.#cached(`tv-credits:${id}`, `tv/${id}/credits`, (c: TmdbCredits) =>
      summarizeCredits(c),
    );
  }

  async getMovieRecommendations(id: number, pg?: number): Promise<Record<string, unknown>> {
    const res = await this.#http.getJson<TmdbPage<TmdbMovie>>(`movie/${id}/recommendations`, {
      query: { page: pg },
    });
    return page(res, summarizeMovie);
  }

  async getTvRecommendations(id: number, pg?: number): Promise<Record<string, unknown>> {
    const res = await this.#http.getJson<TmdbPage<TmdbTv>>(`tv/${id}/recommendations`, {
      query: { page: pg },
    });
    return page(res, summarizeTv);
  }

  // ---- discovery ------------------------------------------------------------

  async getTrending(
    mediaType: TrendingMediaType,
    window: TrendingWindow,
    pg?: number,
  ): Promise<Record<string, unknown>> {
    const res = await this.#http.getJson<TmdbPage<TmdbMultiItem>>(
      `trending/${mediaType}/${window}`,
      { query: { page: pg } },
    );
    return page(res, summarizeMultiItem);
  }

  // Genre lists drive the readable names in search results; very static → cache.
  async getMovieGenres(): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError("genres:movie", async () => {
      const res = await this.#http.getJson<{ genres: { id?: number; name?: string }[] }>(
        "genre/movie/list",
      );
      return summarizeGenres(res.genres ?? []);
    });
  }

  async getTvGenres(): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError("genres:tv", async () => {
      const res = await this.#http.getJson<{ genres: { id?: number; name?: string }[] }>(
        "genre/tv/list",
      );
      return summarizeGenres(res.genres ?? []);
    });
  }

  // ---- discover -------------------------------------------------------------

  async discoverMovies(p: DiscoverParams): Promise<Record<string, unknown>> {
    const res = await this.#http.getJson<TmdbPage<TmdbMovie>>("discover/movie", {
      query: { ...discoverQuery(p), primary_release_year: p.year },
    });
    return page(res, summarizeMovie);
  }

  async discoverTv(p: DiscoverParams): Promise<Record<string, unknown>> {
    const res = await this.#http.getJson<TmdbPage<TmdbTv>>("discover/tv", {
      query: { ...discoverQuery(p), first_air_date_year: p.year },
    });
    return page(res, summarizeTv);
  }

  // ---- watch providers ------------------------------------------------------

  async getMovieWatchProviders(id: number, region: string): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(`movie-watch:${id}`, async () => {
      const res = await this.#http.getJson<WatchProvidersResponse>(`movie/${id}/watch/providers`);
      return summarizeWatchProviders(res, region);
    });
  }

  async getTvWatchProviders(id: number, region: string): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(`tv-watch:${id}`, async () => {
      const res = await this.#http.getJson<WatchProvidersResponse>(`tv/${id}/watch/providers`);
      return summarizeWatchProviders(res, region);
    });
  }

  // ---- person filmography ---------------------------------------------------

  async getPersonCredits(id: number): Promise<Record<string, unknown>> {
    return this.#cached<CombinedCredits>(
      `person-credits:${id}`,
      `person/${id}/combined_credits`,
      (c) => summarizePersonCredits(c),
    );
  }

  // ---- videos / trailers ----------------------------------------------------

  async getMovieVideos(id: number): Promise<Record<string, unknown>> {
    return this.#cached<VideosResponse>(
      `movie-videos:${id}`,
      `movie/${id}/videos`,
      summarizeVideos,
    );
  }

  async getTvVideos(id: number): Promise<Record<string, unknown>> {
    return this.#cached<VideosResponse>(`tv-videos:${id}`, `tv/${id}/videos`, summarizeVideos);
  }

  // ---- reverse lookup -------------------------------------------------------

  async findByExternalId(
    externalId: string,
    source: ExternalSource,
  ): Promise<Record<string, unknown>> {
    return this.#cached<FindResponse>(
      `find:${source}:${externalId}`,
      `find/${externalId}`,
      summarizeFind,
      { external_source: source },
    );
  }

  // ---- TV deep dive ---------------------------------------------------------

  async getTvSeason(id: number, season: number): Promise<Record<string, unknown>> {
    return this.#cached<TmdbSeason>(
      `tv-season:${id}:${season}`,
      `tv/${id}/season/${season}`,
      summarizeSeason,
    );
  }

  async getTvEpisode(
    id: number,
    season: number,
    episode: number,
  ): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(`tv-episode:${id}:${season}:${episode}`, async () => {
      const res = await this.#http.getJson<Parameters<typeof summarizeEpisode>[0]>(
        `tv/${id}/season/${season}/episode/${episode}`,
      );
      // Inject season_number in case the episode payload omits it.
      return summarizeEpisode({ ...res, season_number: res.season_number ?? season });
    });
  }

  // Cache by `key`, GET `path`, then shape the raw body.
  async #cached<T>(
    key: string,
    path: string,
    shape: (data: T) => Record<string, unknown>,
    query?: Query,
  ): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(key, async () => {
      const res = await this.#http.getJson<T>(path, query ? { query } : undefined);
      return shape(res);
    });
  }
}

// Map friendly DiscoverParams to TMDB's query keys (some use a dotted, range
// syntax like `vote_average.gte`). `year` is mapped per-endpoint by the caller.
function discoverQuery(p: DiscoverParams): Query {
  return {
    sort_by: p.sort_by,
    with_genres: p.with_genres,
    with_original_language: p.with_original_language,
    page: p.page,
    "vote_average.gte": p.min_rating,
    "vote_average.lte": p.max_rating,
    "vote_count.gte": p.min_votes,
    "with_runtime.gte": p.min_runtime,
  };
}
