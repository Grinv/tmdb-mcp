// Read-only client for The Movie Database (TMDB) v3 REST API. Auth is a v4
// "Read Access Token" sent as `Authorization: Bearer <token>`. Wraps the generic
// HttpClient with a polite rate limiter and a TTL cache; all raw→agent-facing
// shaping lives in ../format.js. This is the backbone source (search, metadata,
// people, trending); OMDb (see ./omdb.js) only enriches it with ratings.
//
// Localization: a default `language` (e.g. "ru-RU") and `region` come from
// config and are applied to every request; callers may override per call.
import { HttpClient } from "../lib/http.js";
import { TtlCache } from "../lib/cache.js";
import { createUpstream } from "../lib/upstream.js";
import {
  detailMovie,
  detailPerson,
  detailTv,
  page,
  summarizeCollection,
  summarizeCredits,
  summarizeEpisode,
  summarizeFind,
  summarizeGenres,
  summarizeKeywords,
  summarizeMovie,
  summarizeMultiItem,
  summarizePersonCredits,
  summarizeReview,
  summarizeSeason,
  summarizeTv,
  summarizeVideos,
  summarizeWatchProviders,
  type CombinedCredits,
  type FindResponse,
  type KeywordsResponse,
  type TmdbCollection,
  type TmdbCredits,
  type TmdbReview,
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
  language?: string;
  /** search/movie only: bias release-date relevance to a country. */
  region?: string;
}

export type TrendingMediaType = "all" | "movie" | "tv" | "person";
export type TrendingWindow = "day" | "week";

// Friendly discover params; mapped to TMDB's query keys in the client so callers
// (and the tool schema) avoid awkward names like "vote_average.gte". `year` and
// the date range map to the movie- or tv-specific keys per endpoint.
export interface DiscoverParams {
  sort_by?: string;
  with_genres?: string;
  without_genres?: string;
  year?: number;
  release_date_gte?: string;
  release_date_lte?: string;
  min_rating?: number;
  max_rating?: number;
  min_votes?: number;
  min_runtime?: number;
  max_runtime?: number;
  with_original_language?: string;
  with_cast?: string;
  with_crew?: string;
  with_people?: string;
  with_companies?: string;
  with_keywords?: string;
  without_keywords?: string;
  with_watch_providers?: string;
  watch_region?: string;
  with_networks?: string; // tv only
  certification?: string; // movie only
  certification_country?: string; // movie only
  language?: string;
  page?: number;
}

export type ExternalSource = "imdb_id" | "tvdb_id" | "wikidata_id";

export class TmdbClient {
  readonly #http: HttpClient;
  readonly #cache: TtlCache<Record<string, unknown>>;
  readonly #language: string;
  readonly #region: string;
  /** True when a TMDB token is configured; tools short-circuit otherwise. */
  readonly configured: boolean;
  /** Actionable error shown by tools when `configured` is false. */
  readonly notConfiguredMessage =
    "TMDB is not configured. Set TMDB_API_TOKEN to a TMDB v4 'Read Access Token' " +
    "(https://www.themoviedb.org/settings/api).";

  constructor(config: Config, logger: Logger) {
    this.configured = Boolean(config.tmdbApiToken);
    this.#language = config.tmdbLanguage;
    this.#region = config.tmdbRegion;
    const { http, cache } = createUpstream({
      baseUrl: config.tmdbBaseUrl,
      logger,
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
      minIntervalMs: config.tmdbMinIntervalMs,
      cacheTtlMs: config.cacheTtlMs,
      defaultHeaders: config.tmdbApiToken ? { Authorization: `Bearer ${config.tmdbApiToken}` } : {},
    });
    this.#http = http;
    this.#cache = cache;
  }

  /** Resolve the effective language for a call (override → config default). */
  #lang(language?: string): string {
    return language ?? this.#language;
  }

  /** GET with the effective `language` injected (an explicit query.language wins). */
  #get<T>(path: string, query: Query = {}, language?: string): Promise<T> {
    return this.#http.getJson<T>(path, { query: { language: this.#lang(language), ...query } });
  }

  // ---- search ---------------------------------------------------------------

  async searchMovies(p: SearchParams): Promise<Record<string, unknown>> {
    const res = await this.#get<TmdbPage<TmdbMovie>>(
      "search/movie",
      {
        query: p.query,
        year: p.year,
        page: p.page,
        include_adult: p.include_adult,
        region: p.region ?? this.#region,
      },
      p.language,
    );
    return page(res, summarizeMovie);
  }

  async searchTv(p: SearchParams): Promise<Record<string, unknown>> {
    const res = await this.#get<TmdbPage<TmdbTv>>(
      "search/tv",
      {
        query: p.query,
        first_air_date_year: p.year,
        page: p.page,
        include_adult: p.include_adult,
      },
      p.language,
    );
    return page(res, summarizeTv);
  }

  async searchMulti(p: SearchParams): Promise<Record<string, unknown>> {
    const res = await this.#get<TmdbPage<TmdbMultiItem>>(
      "search/multi",
      { query: p.query, page: p.page, include_adult: p.include_adult },
      p.language,
    );
    return page(res, summarizeMultiItem);
  }

  async searchPeople(p: SearchParams): Promise<Record<string, unknown>> {
    const res = await this.#get<TmdbPage<TmdbMultiItem>>(
      "search/person",
      { query: p.query, page: p.page, include_adult: p.include_adult },
      p.language,
    );
    return page(res, summarizeMultiItem);
  }

  // Keyword ids feed discover_*'s with_keywords; this resolves names → ids.
  async searchKeywords(query: string, pg?: number): Promise<Record<string, unknown>> {
    const res = await this.#get<KeywordsResponse>("search/keyword", { query, page: pg });
    return summarizeKeywords(res);
  }

  // ---- details (cached: stable, frequently re-requested) --------------------

  async getMovie(
    id: number,
    region = this.#region,
    language?: string,
  ): Promise<Record<string, unknown>> {
    // Cache key includes region + language because the headline `certification`
    // and the localized text fields vary by them.
    return this.#cache.wrapStaleOnError(
      `movie:${id}:${region}:${this.#lang(language)}`,
      async () => {
        // release_dates appended so the detail carries age/content certifications.
        const res = await this.#get<TmdbMovie>(
          `movie/${id}`,
          { append_to_response: "release_dates" },
          language,
        );
        return detailMovie(res, region);
      },
    );
  }

  /** Like getMovie but also returns the raw imdb_id for OMDb enrichment. */
  async getMovieWithImdb(
    id: number,
    region = this.#region,
    language?: string,
  ): Promise<{ shaped: Record<string, unknown>; imdbId: string | null }> {
    const shaped = await this.getMovie(id, region, language);
    return { shaped, imdbId: (shaped.imdb_id as string | null) ?? null };
  }

  async getTv(
    id: number,
    region = this.#region,
    language?: string,
  ): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(`tv:${id}:${region}:${this.#lang(language)}`, async () => {
      // external_ids appended so the TV detail carries an imdb_id (the base
      // /tv/{id} response, unlike /movie/{id}, does not include one);
      // content_ratings appended for age/content certifications.
      const res = await this.#get<TmdbTv>(
        `tv/${id}`,
        { append_to_response: "external_ids,content_ratings" },
        language,
      );
      return detailTv(res, region);
    });
  }

  async getTvWithImdb(
    id: number,
    region = this.#region,
    language?: string,
  ): Promise<{ shaped: Record<string, unknown>; imdbId: string | null }> {
    const shaped = await this.getTv(id, region, language);
    return { shaped, imdbId: (shaped.imdb_id as string | null) ?? null };
  }

  async getPerson(id: number, language?: string): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(`person:${id}:${this.#lang(language)}`, async () => {
      const res = await this.#get<TmdbPerson>(`person/${id}`, {}, language);
      return detailPerson(res);
    });
  }

  async getMovieCredits(id: number, language?: string): Promise<Record<string, unknown>> {
    return this.#cached(
      `movie-credits:${id}:${this.#lang(language)}`,
      `movie/${id}/credits`,
      (c: TmdbCredits) => summarizeCredits(c),
      {},
      language,
    );
  }

  async getTvCredits(id: number, language?: string): Promise<Record<string, unknown>> {
    return this.#cached(
      `tv-credits:${id}:${this.#lang(language)}`,
      `tv/${id}/credits`,
      (c: TmdbCredits) => summarizeCredits(c),
      {},
      language,
    );
  }

  // Paged movie/tv title list under a per-title sub-resource. `recommendations`
  // (editorial) and `similar` (algorithmic) share this shape; the endpoint
  // segment differs and the summarizer follows the media type.
  #pagedTitles(
    mediaType: "movie" | "tv",
    id: number,
    kind: "recommendations" | "similar",
    pg?: number,
    language?: string,
  ): Promise<Record<string, unknown>> {
    if (mediaType === "tv") {
      return this.#get<TmdbPage<TmdbTv>>(`tv/${id}/${kind}`, { page: pg }, language).then((res) =>
        page(res, summarizeTv),
      );
    }
    return this.#get<TmdbPage<TmdbMovie>>(`movie/${id}/${kind}`, { page: pg }, language).then(
      (res) => page(res, summarizeMovie),
    );
  }

  /** TMDB's editorial recommendations for a movie or TV show. */
  getRecommendations(
    mediaType: "movie" | "tv",
    id: number,
    pg?: number,
    language?: string,
  ): Promise<Record<string, unknown>> {
    return this.#pagedTitles(mediaType, id, "recommendations", pg, language);
  }

  /** TMDB's algorithmic "similar" list (distinct from getRecommendations). */
  getSimilar(
    mediaType: "movie" | "tv",
    id: number,
    pg?: number,
    language?: string,
  ): Promise<Record<string, unknown>> {
    return this.#pagedTitles(mediaType, id, "similar", pg, language);
  }

  // User reviews for a movie or TV show (same response shape for both).
  async getReviews(
    mediaType: "movie" | "tv",
    id: number,
    pg?: number,
    language?: string,
  ): Promise<Record<string, unknown>> {
    const res = await this.#get<TmdbPage<TmdbReview>>(
      `${mediaType}/${id}/reviews`,
      { page: pg },
      language,
    );
    return page(res, summarizeReview);
  }

  // A movie collection/franchise (e.g. "The Dark Knight Collection") + its parts.
  // Cached: collections are stable and small.
  async getCollection(id: number, language?: string): Promise<Record<string, unknown>> {
    return this.#cached<TmdbCollection>(
      `collection:${id}:${this.#lang(language)}`,
      `collection/${id}`,
      summarizeCollection,
      {},
      language,
    );
  }

  // ---- discovery ------------------------------------------------------------

  async getTrending(
    mediaType: TrendingMediaType,
    window: TrendingWindow,
    pg?: number,
    language?: string,
  ): Promise<Record<string, unknown>> {
    const res = await this.#get<TmdbPage<TmdbMultiItem>>(
      `trending/${mediaType}/${window}`,
      { page: pg },
      language,
    );
    return page(res, summarizeMultiItem);
  }

  // Genre lists drive the readable names in search results; very static → cache.
  // Cached per language so localized names are not mixed.
  async getGenres(mediaType: "movie" | "tv", language?: string): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(`genres:${mediaType}:${this.#lang(language)}`, async () => {
      const res = await this.#get<{ genres: { id?: number; name?: string }[] }>(
        `genre/${mediaType}/list`,
        {},
        language,
      );
      return summarizeGenres(res.genres ?? []);
    });
  }

  // ---- discover -------------------------------------------------------------

  async discover(kind: "movie" | "tv", p: DiscoverParams): Promise<Record<string, unknown>> {
    if (kind === "tv") {
      const res = await this.#get<TmdbPage<TmdbTv>>(
        "discover/tv",
        discoverQuery(p, "tv"),
        p.language,
      );
      return page(res, summarizeTv);
    }
    const res = await this.#get<TmdbPage<TmdbMovie>>(
      "discover/movie",
      discoverQuery(p, "movie"),
      p.language,
    );
    return page(res, summarizeMovie);
  }

  // ---- watch providers ------------------------------------------------------

  async getWatchProviders(
    mediaType: "movie" | "tv",
    id: number,
    region: string,
  ): Promise<Record<string, unknown>> {
    // region is part of the cache key: summarizeWatchProviders returns a
    // region-specific slice, so caching it under an id-only key would serve one
    // region's providers for another.
    return this.#cache.wrapStaleOnError(`watch:${mediaType}:${id}:${region}`, async () => {
      const res = await this.#http.getJson<WatchProvidersResponse>(
        `${mediaType}/${id}/watch/providers`,
      );
      return summarizeWatchProviders(res, region);
    });
  }

  // ---- person filmography ---------------------------------------------------

  async getPersonCredits(id: number, language?: string): Promise<Record<string, unknown>> {
    return this.#cached<CombinedCredits>(
      `person-credits:${id}:${this.#lang(language)}`,
      `person/${id}/combined_credits`,
      (c) => summarizePersonCredits(c),
      {},
      language,
    );
  }

  // ---- videos / trailers ----------------------------------------------------

  async getVideos(
    mediaType: "movie" | "tv",
    id: number,
    language?: string,
  ): Promise<Record<string, unknown>> {
    return this.#cached<VideosResponse>(
      `${mediaType}-videos:${id}:${this.#lang(language)}`,
      `${mediaType}/${id}/videos`,
      summarizeVideos,
      {},
      language,
    );
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

  async getTvSeason(
    id: number,
    season: number,
    language?: string,
  ): Promise<Record<string, unknown>> {
    return this.#cached<TmdbSeason>(
      `tv-season:${id}:${season}:${this.#lang(language)}`,
      `tv/${id}/season/${season}`,
      summarizeSeason,
      {},
      language,
    );
  }

  async getTvEpisode(
    id: number,
    season: number,
    episode: number,
    language?: string,
  ): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(
      `tv-episode:${id}:${season}:${episode}:${this.#lang(language)}`,
      async () => {
        const res = await this.#get<Parameters<typeof summarizeEpisode>[0]>(
          `tv/${id}/season/${season}/episode/${episode}`,
          {},
          language,
        );
        // Inject season_number in case the episode payload omits it.
        return summarizeEpisode({ ...res, season_number: res.season_number ?? season });
      },
    );
  }

  // Cache by `key`, GET `path` (with language injected), then shape the body.
  async #cached<T>(
    key: string,
    path: string,
    shape: (data: T) => Record<string, unknown>,
    query: Query = {},
    language?: string,
  ): Promise<Record<string, unknown>> {
    return this.#cache.wrapStaleOnError(key, async () => {
      const res = await this.#get<T>(path, query, language);
      return shape(res);
    });
  }
}

// Map friendly DiscoverParams to TMDB's query keys (some use a dotted, range
// syntax like `vote_average.gte`). Movie and TV differ on the date/year keys
// and a few exclusive filters (certification = movie, networks = tv).
function discoverQuery(p: DiscoverParams, kind: "movie" | "tv"): Query {
  const common: Query = {
    sort_by: p.sort_by,
    with_genres: p.with_genres,
    without_genres: p.without_genres,
    with_original_language: p.with_original_language,
    with_companies: p.with_companies,
    with_keywords: p.with_keywords,
    without_keywords: p.without_keywords,
    with_watch_providers: p.with_watch_providers,
    watch_region: p.watch_region,
    page: p.page,
    "vote_average.gte": p.min_rating,
    "vote_average.lte": p.max_rating,
    "vote_count.gte": p.min_votes,
    "with_runtime.gte": p.min_runtime,
    "with_runtime.lte": p.max_runtime,
  };
  if (kind === "movie") {
    return {
      ...common,
      primary_release_year: p.year,
      "primary_release_date.gte": p.release_date_gte,
      "primary_release_date.lte": p.release_date_lte,
      with_cast: p.with_cast,
      with_crew: p.with_crew,
      with_people: p.with_people,
      certification: p.certification,
      certification_country: p.certification_country,
    };
  }
  return {
    ...common,
    first_air_date_year: p.year,
    "first_air_date.gte": p.release_date_gte,
    "first_air_date.lte": p.release_date_lte,
    with_networks: p.with_networks,
  };
}
