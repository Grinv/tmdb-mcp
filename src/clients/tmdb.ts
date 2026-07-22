// Read-only client for The Movie Database (TMDB) v3 REST API. Auth is a v4
// "Read Access Token" sent as `Authorization: Bearer <token>`. Wraps the generic
// HttpClient with a polite rate limiter and a TTL cache; all raw→agent-facing
// shaping lives in ../format.js. This is the backbone source (search, metadata,
// people, trending); OMDb (see ./omdb.js) only enriches it with ratings.
//
// Localization: a default `language` (e.g. "ru-RU") and `region` come from
// config and are applied to every request; callers may override per call.
import { HttpClient } from "../lib/http.js";
import { TtlCache, cacheKey } from "../lib/cache.js";
import { createUpstream } from "../lib/upstream.js";
import {
  detailMovie,
  detailPerson,
  detailTv,
  page,
  summarizeCollection,
  summarizeCompany,
  summarizeCredits,
  summarizeEpisode,
  summarizeFind,
  summarizeGenres,
  summarizeKeywords,
  summarizeMovie,
  summarizeMultiItem,
  summarizePerson,
  summarizePersonCredits,
  summarizeReview,
  summarizeSeason,
  summarizeTv,
  summarizeVideos,
  summarizeWatchProviders,
  type CombinedCredits,
  type KeywordsResponse,
  type Page,
  type TmdbCompany,
  type TmdbCredits,
  type TmdbReview,
  type TmdbMovie,
  type TmdbMultiItem,
  type TmdbPage,
  type TmdbSeason,
  type TmdbTv,
  type WatchProvidersResponse,
} from "../format.js";
import type { Logger } from "../lib/logger.js";
import type { Config } from "../config.js";
// Type-only: DiscoverParams' source of truth is the input zod schema in
// tools/tmdb.ts (per-field descriptions/validation belong there), z.infer'd
// and re-exported for client code — see discoverParamsSchema in tools/tmdb.ts.
// `import type` is fully erased at build, so this doesn't create a runtime
// circular import even though tools/tmdb.ts also imports TmdbClient from here.
import type { DiscoverParams } from "../tools/tmdb.js";

type Query = Record<string, string | number | boolean | undefined>;

// TMDB's hard cap on remote calls per append_to_response request.
const MAX_APPEND_TO_RESPONSE = 20;

// A show can have 30+ seasons, each already under its own 50-episode cap
// (see summarizeSeason) — but the SUM across every season in an
// expand_episodes bulk fetch can still reach into the hundreds and blow past
// a usable response size. Cap the combined episode count across all seasons
// in one getTvSeasonsBulk result; episode_count on each season still reports
// that season's true total even once its episodes are truncated to fit.
const MAX_EXPANDED_EPISODES = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// How many of the source title's genres a "similar" candidate must share to
// count as a real match, not just noise from TMDB's genre/keyword-only
// heuristic. Requiring only "≥1 shared genre" is almost no filter at all once
// a title carries a broad tag like "Drama" — half of TMDB's catalog would
// pass. Requiring "share every genre" is too strict for titles with several
// tags. Half (rounded up), floored at 2 once there are enough genres to ask
// for that: a title with only one genre must match that one exactly.
function minSharedGenres(sourceGenreCount: number): number {
  if (sourceGenreCount <= 1) return sourceGenreCount;
  return Math.min(sourceGenreCount, Math.max(2, Math.ceil(sourceGenreCount / 2)));
}

// Drop "similar" results that only cross the broadest shared genre with the
// source title (see minSharedGenres) — recommendations (behavioral, not
// genre-based) never runs this. Passes everything through unfiltered when the
// source's own genres are unknown (empty sourceGenreIds): no signal, no veto.
//
// A tighter variant was tried and reverted: additionally requiring the
// source's first-listed genre specifically (TMDB empirically lists a title's
// most defining genre first, e.g. Midsommar's ["Horror", "Drama", "Mystery"])
// looked promising on that one title, but a wider live comparison across
// several films showed it swings both ways — it also drops legitimately
// decent candidates (e.g. Fargo/The Silence of the Lambs for Parasite) about
// as often as it removes real noise, and does nothing at all when a title's
// first-listed genre already happens to be a generic one (Drama). Not a net
// improvement over the plain count below, so left out.
function filterByGenreOverlap<T extends { genre_ids?: number[] }>(
  items: T[],
  sourceGenreIds: number[],
): T[] {
  if (sourceGenreIds.length === 0) return items;
  const required = minSharedGenres(sourceGenreIds.length);
  const sourceSet = new Set(sourceGenreIds);
  return items.filter(
    (item) => (item.genre_ids ?? []).filter((g) => sourceSet.has(g)).length >= required,
  );
}

function capTotalEpisodes(
  seasons: ReturnType<typeof summarizeSeason>[],
  limit: number,
): ReturnType<typeof summarizeSeason>[] {
  let remaining = limit;
  return seasons.map((s) => {
    if (remaining <= 0) return { ...s, episodes: [] };
    if (s.episodes.length <= remaining) {
      remaining -= s.episodes.length;
      return s;
    }
    const capped = { ...s, episodes: s.episodes.slice(0, remaining) };
    remaining = 0;
    return capped;
  });
}

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

export type { DiscoverParams };

export type ExternalSource = "imdb_id" | "tvdb_id" | "wikidata_id";

// Shared by every method that dispatches on a runtime "movie" | "tv" media
// kind and returns a page of the corresponding summary — the return type is
// a real union (which branch you get depends on the `mediaType` argument,
// not on anything visible in the static type), not a cop-out to `unknown`.
type MovieOrTvPage = Page<ReturnType<typeof summarizeMovie>> | Page<ReturnType<typeof summarizeTv>>;

// getTv's return shape: detailTv's fields, plus the optional per-season
// episode expansion (only populated when a caller passes expandEpisodes).
type TvDetail = ReturnType<typeof detailTv> & {
  seasons_detail?: ReturnType<typeof summarizeSeason>[];
};

export class TmdbClient {
  readonly #http: HttpClient;
  readonly #cache: TtlCache;
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
  #get<T>(path: string, query: Query = {}, language?: string, signal?: AbortSignal): Promise<T> {
    return this.#http.getJson<T>(path, {
      query: { language: this.#lang(language), ...query },
      signal,
    });
  }

  // ---- search ---------------------------------------------------------------

  // These search/discover/similar-family methods are NOT cached (unlike the
  // detail getters below), so they accept the caller's AbortSignal and can be
  // genuinely cancelled mid-flight when the MCP client cancels the tool call.

  async searchMovies(
    p: SearchParams,
    signal?: AbortSignal,
  ): Promise<Page<ReturnType<typeof summarizeMovie>>> {
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
      signal,
    );
    return page(res, summarizeMovie);
  }

  async searchTv(
    p: SearchParams,
    signal?: AbortSignal,
  ): Promise<Page<ReturnType<typeof summarizeTv>>> {
    const res = await this.#get<TmdbPage<TmdbTv>>(
      "search/tv",
      {
        query: p.query,
        first_air_date_year: p.year,
        page: p.page,
        include_adult: p.include_adult,
      },
      p.language,
      signal,
    );
    return page(res, summarizeTv);
  }

  async searchMulti(
    p: SearchParams,
    signal?: AbortSignal,
  ): Promise<Page<ReturnType<typeof summarizeMultiItem>>> {
    const res = await this.#get<TmdbPage<TmdbMultiItem>>(
      "search/multi",
      { query: p.query, page: p.page, include_adult: p.include_adult },
      p.language,
      signal,
    );
    return page(res, summarizeMultiItem);
  }

  async searchPeople(
    p: SearchParams,
    signal?: AbortSignal,
  ): Promise<Page<ReturnType<typeof summarizePerson>>> {
    const res = await this.#get<TmdbPage<TmdbMultiItem>>(
      "search/person",
      { query: p.query, page: p.page, include_adult: p.include_adult },
      p.language,
      signal,
    );
    // /search/person never carries media_type, unlike /search/multi, so
    // dispatch-by-media_type (summarizeMultiItem) would misclassify every row.
    return page(res, summarizePerson);
  }

  // Keyword ids feed discover_*'s with_keywords; this resolves names → ids.
  async searchKeywords(
    query: string,
    pg?: number,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof summarizeKeywords>> {
    const res = await this.#get<KeywordsResponse>(
      "search/keyword",
      { query, page: pg },
      undefined,
      signal,
    );
    return summarizeKeywords(res);
  }

  // Company ids feed discover_*'s with_companies; this resolves names → ids.
  // Names aren't unique (e.g. TMDB has two unrelated "A24"s) — origin_country
  // is kept in the shaped result so a caller can tell rows apart.
  async searchCompanies(
    query: string,
    pg?: number,
    signal?: AbortSignal,
  ): Promise<Page<ReturnType<typeof summarizeCompany>>> {
    const res = await this.#get<TmdbPage<TmdbCompany>>(
      "search/company",
      { query, page: pg },
      undefined,
      signal,
    );
    return page(res, summarizeCompany);
  }

  // ---- details (cached: stable, frequently re-requested) --------------------

  async getMovie(
    id: number,
    region = this.#region,
    language?: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof detailMovie>> {
    // region + language are dims because the headline `certification` and the
    // localized text fields vary by them.
    return this.#cache.wrapStaleOnError(
      cacheKey(`movie:${id}`, { region, language: this.#lang(language) }),
      async () => {
        // release_dates appended so the detail carries age/content certifications.
        const res = await this.#get<TmdbMovie>(
          `movie/${id}`,
          { append_to_response: "release_dates" },
          language,
        );
        return detailMovie(res, region);
      },
      onStale,
    );
  }

  async getTv(
    id: number,
    region = this.#region,
    language?: string,
    expandEpisodes = false,
    onStale?: () => void,
  ): Promise<TvDetail> {
    const shaped = await this.#cache.wrapStaleOnError(
      cacheKey(`tv:${id}`, { region, language: this.#lang(language) }),
      async () => {
        // external_ids appended so the TV detail carries an imdb_id (the base
        // /tv/{id} response, unlike /movie/{id}, does not include one);
        // content_ratings appended for age/content certifications.
        const res = await this.#get<TmdbTv>(
          `tv/${id}`,
          { append_to_response: "external_ids,content_ratings" },
          language,
        );
        return detailTv(res, region);
      },
      onStale,
    );
    if (!expandEpisodes) return shaped;
    const seasonNumbers = shaped.seasons
      .map((s) => s.season_number)
      .filter((n): n is number => n !== null);
    if (seasonNumbers.length === 0) return shaped;
    return {
      ...shaped,
      seasons_detail: await this.getTvSeasonsBulk(id, seasonNumbers, language, onStale),
    };
  }

  // Fetch every season's full episode list via append_to_response=season/1,
  // season/2,..., instead of one getTvSeason call per season. TMDB caps
  // append_to_response at 20 remote calls per request, so shows with more
  // seasons (e.g. long-running sitcoms/soaps) are split into multiple
  // append_to_response requests of at most that many seasons each. Cached
  // separately from getTv (and keyed by the season list) since it's only
  // fetched when a caller opts in via expandEpisodes.
  async getTvSeasonsBulk(
    id: number,
    seasonNumbers: number[],
    language?: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizeSeason>[]> {
    const key = cacheKey(`tv-seasons-bulk:${id}`, {
      seasons: seasonNumbers.join(","),
      language: this.#lang(language),
    });
    const bulk = await this.#cache.wrapStaleOnError(
      key,
      async () => {
        const chunks = chunk(seasonNumbers, MAX_APPEND_TO_RESPONSE);
        const chunkResults = await Promise.all(
          chunks.map(async (numbers) => {
            const append = numbers.map((n) => `season/${n}`).join(",");
            const res = await this.#get<Record<string, TmdbSeason>>(
              `tv/${id}`,
              { append_to_response: append },
              language,
            );
            return numbers.map((n) => summarizeSeason(res[`season/${n}`] ?? {}));
          }),
        );
        return { seasons: capTotalEpisodes(chunkResults.flat(), MAX_EXPANDED_EPISODES) };
      },
      onStale,
    );
    return bulk.seasons;
  }

  /** Like getMovie/getTv but also returns the raw imdb_id for OMDb enrichment. */
  async getDetailWithImdb(
    mediaType: "movie" | "tv",
    id: number,
    region = this.#region,
    language?: string,
    expandEpisodes = false,
    onStale?: () => void,
  ): Promise<{
    shaped: ReturnType<typeof detailMovie> | TvDetail;
    imdbId: string | null;
  }> {
    const shaped =
      mediaType === "tv"
        ? await this.getTv(id, region, language, expandEpisodes, onStale)
        : await this.getMovie(id, region, language, onStale);
    return { shaped, imdbId: shaped.imdb_id };
  }

  async getPerson(
    id: number,
    language?: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof detailPerson>> {
    return this.#cached(
      cacheKey(`person:${id}`, { language: this.#lang(language) }),
      `person/${id}`,
      detailPerson,
      {},
      language,
      onStale,
    );
  }

  async getMovieCredits(
    id: number,
    language?: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizeCredits>> {
    return this.#cached(
      cacheKey(`movie-credits:${id}`, { language: this.#lang(language) }),
      `movie/${id}/credits`,
      (c: TmdbCredits) => summarizeCredits(c),
      {},
      language,
      onStale,
    );
  }

  async getTvCredits(
    id: number,
    language?: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizeCredits>> {
    return this.#cached(
      cacheKey(`tv-credits:${id}`, { language: this.#lang(language) }),
      `tv/${id}/credits`,
      (c: TmdbCredits) => summarizeCredits(c),
      {},
      language,
      onStale,
    );
  }

  // The source title's own genre ids, used only to filter getSimilar's noise
  // (see filterByGenreOverlap). Cheap+cacheable: a bare detail fetch, no
  // append_to_response. Degrades to "no signal" on any failure — losing this
  // enhancement should never take down the similar-titles call it supports.
  async #sourceGenreIds(
    mediaType: "movie" | "tv",
    id: number,
    language?: string,
  ): Promise<number[]> {
    try {
      return await this.#cache.wrap(
        cacheKey(`${mediaType}-genre-ids:${id}`, { language: this.#lang(language) }),
        async () => {
          const res =
            mediaType === "tv"
              ? await this.#get<TmdbTv>(`tv/${id}`, {}, language)
              : await this.#get<TmdbMovie>(`movie/${id}`, {}, language);
          return (res.genres ?? [])
            .map((g) => g.id)
            .filter((genreId): genreId is number => typeof genreId === "number");
        },
      );
    } catch {
      return [];
    }
  }

  // Paged movie/tv title list under a per-title sub-resource. `recommendations`
  // (editorial) and `similar` (algorithmic) share this shape; the endpoint
  // segment differs and the summarizer follows the media type. `similar`
  // additionally gets filtered against the source title's own genres — see
  // filterByGenreOverlap — since recommendations isn't genre-based to begin with.
  async #pagedTitles(
    mediaType: "movie" | "tv",
    id: number,
    kind: "recommendations" | "similar",
    pg?: number,
    language?: string,
    signal?: AbortSignal,
  ): Promise<MovieOrTvPage> {
    if (mediaType === "tv") {
      const res = await this.#get<TmdbPage<TmdbTv>>(
        `tv/${id}/${kind}`,
        { page: pg },
        language,
        signal,
      );
      if (kind !== "similar") return page(res, summarizeTv);
      const sourceGenreIds = await this.#sourceGenreIds("tv", id, language);
      return page(
        { ...res, results: filterByGenreOverlap(res.results ?? [], sourceGenreIds) },
        summarizeTv,
      );
    }
    const res = await this.#get<TmdbPage<TmdbMovie>>(
      `movie/${id}/${kind}`,
      { page: pg },
      language,
      signal,
    );
    if (kind !== "similar") return page(res, summarizeMovie);
    const sourceGenreIds = await this.#sourceGenreIds("movie", id, language);
    return page(
      { ...res, results: filterByGenreOverlap(res.results ?? [], sourceGenreIds) },
      summarizeMovie,
    );
  }

  /** TMDB's editorial recommendations for a movie or TV show. */
  getRecommendations(
    mediaType: "movie" | "tv",
    id: number,
    pg?: number,
    language?: string,
    signal?: AbortSignal,
  ): Promise<MovieOrTvPage> {
    return this.#pagedTitles(mediaType, id, "recommendations", pg, language, signal);
  }

  /** TMDB's algorithmic "similar" list (distinct from getRecommendations). */
  getSimilar(
    mediaType: "movie" | "tv",
    id: number,
    pg?: number,
    language?: string,
    signal?: AbortSignal,
  ): Promise<MovieOrTvPage> {
    return this.#pagedTitles(mediaType, id, "similar", pg, language, signal);
  }

  // User reviews for a movie or TV show (same response shape for both).
  async getReviews(
    mediaType: "movie" | "tv",
    id: number,
    pg?: number,
    language?: string,
    signal?: AbortSignal,
  ): Promise<Page<ReturnType<typeof summarizeReview>>> {
    const res = await this.#get<TmdbPage<TmdbReview>>(
      `${mediaType}/${id}/reviews`,
      { page: pg },
      language,
      signal,
    );
    return page(res, summarizeReview);
  }

  // A movie collection/franchise (e.g. "The Dark Knight Collection") + its parts.
  // Cached: collections are stable and small.
  async getCollection(
    id: number,
    language?: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizeCollection>> {
    return this.#cached(
      cacheKey(`collection:${id}`, { language: this.#lang(language) }),
      `collection/${id}`,
      summarizeCollection,
      {},
      language,
      onStale,
    );
  }

  // ---- discovery ------------------------------------------------------------

  async getTrending(
    mediaType: TrendingMediaType,
    window: TrendingWindow,
    pg?: number,
    language?: string,
  ): Promise<Page<ReturnType<typeof summarizeMultiItem>>> {
    const res = await this.#get<TmdbPage<TmdbMultiItem>>(
      `trending/${mediaType}/${window}`,
      { page: pg },
      language,
    );
    return page(res, summarizeMultiItem);
  }

  // Genre lists drive the readable names in search results; very static → cache.
  // Cached per language so localized names are not mixed.
  async getGenres(
    mediaType: "movie" | "tv",
    language?: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizeGenres>> {
    return this.#cached(
      cacheKey(`genres:${mediaType}`, { language: this.#lang(language) }),
      `genre/${mediaType}/list`,
      (res: { genres: { id?: number; name?: string }[] }) => summarizeGenres(res.genres ?? []),
      {},
      language,
      onStale,
    );
  }

  // ---- discover -------------------------------------------------------------

  async discover(
    kind: "movie" | "tv",
    p: DiscoverParams,
    signal?: AbortSignal,
  ): Promise<MovieOrTvPage> {
    if (kind === "tv") {
      const res = await this.#get<TmdbPage<TmdbTv>>(
        "discover/tv",
        discoverQuery(p, "tv"),
        p.language,
        signal,
      );
      return page(res, summarizeTv);
    }
    const res = await this.#get<TmdbPage<TmdbMovie>>(
      "discover/movie",
      discoverQuery(p, "movie"),
      p.language,
      signal,
    );
    return page(res, summarizeMovie);
  }

  // ---- watch providers ------------------------------------------------------

  async getWatchProviders(
    mediaType: "movie" | "tv",
    id: number,
    region = this.#region,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizeWatchProviders>> {
    // region is a dim: summarizeWatchProviders returns a region-specific
    // slice, so caching it under an id-only key would serve one region's
    // providers for another.
    return this.#cache.wrapStaleOnError(
      cacheKey(`watch:${mediaType}:${id}`, { region }),
      async () => {
        const res = await this.#http.getJson<WatchProvidersResponse>(
          `${mediaType}/${id}/watch/providers`,
        );
        return summarizeWatchProviders(res, region);
      },
      onStale,
    );
  }

  // ---- person filmography ---------------------------------------------------

  async getPersonCredits(
    id: number,
    department?: string,
    limit?: number,
    language?: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizePersonCredits>> {
    return this.#cached(
      cacheKey(`person-credits:${id}`, { department, limit, language: this.#lang(language) }),
      `person/${id}/combined_credits`,
      (c: CombinedCredits) => summarizePersonCredits(c, department, limit),
      {},
      language,
      onStale,
    );
  }

  // ---- videos / trailers ----------------------------------------------------

  async getVideos(
    mediaType: "movie" | "tv",
    id: number,
    language?: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizeVideos>> {
    return this.#cached(
      cacheKey(`${mediaType}-videos:${id}`, { language: this.#lang(language) }),
      `${mediaType}/${id}/videos`,
      summarizeVideos,
      {},
      language,
      onStale,
    );
  }

  // ---- reverse lookup -------------------------------------------------------

  async findByExternalId(
    externalId: string,
    source: ExternalSource,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizeFind>> {
    return this.#cached(
      cacheKey(`find:${source}:${externalId}`),
      `find/${externalId}`,
      summarizeFind,
      { external_source: source },
      undefined,
      onStale,
    );
  }

  // ---- TV deep dive ---------------------------------------------------------

  async getTvSeason(
    id: number,
    season: number,
    language?: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizeSeason>> {
    return this.#cached(
      cacheKey(`tv-season:${id}:${season}`, { language: this.#lang(language) }),
      `tv/${id}/season/${season}`,
      summarizeSeason,
      {},
      language,
      onStale,
    );
  }

  async getTvEpisode(
    id: number,
    season: number,
    episode: number,
    language?: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizeEpisode>> {
    return this.#cached(
      cacheKey(`tv-episode:${id}:${season}:${episode}`, { language: this.#lang(language) }),
      `tv/${id}/season/${season}/episode/${episode}`,
      // Inject season_number in case the episode payload omits it.
      (res: Parameters<typeof summarizeEpisode>[0]) =>
        summarizeEpisode({ ...res, season_number: res.season_number ?? season }),
      {},
      language,
      onStale,
    );
  }

  // Cache by `key`, GET `path` (with language injected), then shape the body.
  // R is inferred from `shape`'s own return type at each call site, so every
  // caller above gets back its real shape instead of a common denominator.
  async #cached<T, R>(
    key: string,
    path: string,
    shape: (data: T) => R,
    query: Query = {},
    language?: string,
    onStale?: () => void,
  ): Promise<R> {
    return this.#cache.wrapStaleOnError(
      key,
      async () => {
        const res = await this.#get<T>(path, query, language);
        return shape(res);
      },
      onStale,
    );
  }
}

// Maps each DiscoverParams field to the TMDB query key(s) it becomes for
// movie and/or tv (some use a dotted range syntax like "vote_average.gte";
// some differ per kind; some — certification = movie, with_networks = tv —
// are exclusive to one). The Record type requires every DiscoverParams field
// (other than `language`, applied separately) to have a row here, so adding a
// field to either tool-facing discover schema in tools/tmdb.ts without adding
// its mapping here is a compile error instead of a filter that silently never
// reaches TMDB — DiscoverParams itself is z.infer'd from that schema (see
// discoverParamsSchema in tools/tmdb.ts), so there's no third hand-kept copy
// left to drift.
const DISCOVER_FIELD_MAP: Record<
  Exclude<keyof DiscoverParams, "language">,
  Partial<Record<"movie" | "tv", string>>
> = {
  sort_by: { movie: "sort_by", tv: "sort_by" },
  with_genres: { movie: "with_genres", tv: "with_genres" },
  without_genres: { movie: "without_genres", tv: "without_genres" },
  year: { movie: "primary_release_year", tv: "first_air_date_year" },
  release_date_gte: { movie: "primary_release_date.gte", tv: "first_air_date.gte" },
  release_date_lte: { movie: "primary_release_date.lte", tv: "first_air_date.lte" },
  min_rating: { movie: "vote_average.gte", tv: "vote_average.gte" },
  max_rating: { movie: "vote_average.lte", tv: "vote_average.lte" },
  min_votes: { movie: "vote_count.gte", tv: "vote_count.gte" },
  min_runtime: { movie: "with_runtime.gte", tv: "with_runtime.gte" },
  max_runtime: { movie: "with_runtime.lte", tv: "with_runtime.lte" },
  with_original_language: { movie: "with_original_language", tv: "with_original_language" },
  with_cast: { movie: "with_cast" },
  with_crew: { movie: "with_crew" },
  with_people: { movie: "with_people" },
  with_companies: { movie: "with_companies", tv: "with_companies" },
  with_keywords: { movie: "with_keywords", tv: "with_keywords" },
  without_keywords: { movie: "without_keywords", tv: "without_keywords" },
  with_watch_providers: { movie: "with_watch_providers", tv: "with_watch_providers" },
  watch_region: { movie: "watch_region", tv: "watch_region" },
  with_networks: { tv: "with_networks" },
  certification: { movie: "certification" },
  certification_country: { movie: "certification_country" },
  page: { movie: "page", tv: "page" },
};

export function discoverQuery(p: DiscoverParams, kind: "movie" | "tv"): Query {
  const query: Query = {};
  for (const field of Object.keys(DISCOVER_FIELD_MAP) as (keyof typeof DISCOVER_FIELD_MAP)[]) {
    const tmdbKey = DISCOVER_FIELD_MAP[field][kind];
    if (tmdbKey) query[tmdbKey] = p[field];
  }
  return query;
}
