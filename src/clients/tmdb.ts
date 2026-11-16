// Read-only client for The Movie Database (TMDB) v3 REST API. Auth is a v4
// "Read Access Token" sent as `Authorization: Bearer <token>`. Wraps the generic
// HttpClient with a rate limiter and a TTL cache; all raw→agent-facing shaping
// lives in ../format.ts. TMDB is the backbone source (search, metadata, people,
// trending); OMDb (./omdb.ts) only adds ratings.
//
// A default `language` (e.g. "ru-RU") and `region` come from config and apply
// to every request; callers may override per call.
import { HttpClient, nullAsAbsent } from "../lib/http.ts";
import { TtlCache, cacheKey, degraded } from "../lib/cache.ts";
import { unlessOutage } from "../lib/errors.ts";
import { createUpstream } from "../lib/upstream.ts";
import {
  detailMovie,
  detailPerson,
  detailTv,
  page,
  parseSeasons,
  summarizeCollection,
  summarizeCollectionMatch,
  summarizeCompany,
  summarizeCredits,
  summarizeTvCredits,
  summarizeEpisode,
  summarizeFind,
  summarizeGenres,
  summarizeKeywords,
  summarizeMovieReleases,
  summarizeMovie,
  summarizeMultiItem,
  withoutExplicit,
  summarizePerson,
  summarizePersonCredits,
  summarizeReview,
  summarizeSeason,
  trimCombinedCredits,
  summarizeTv,
  summarizeVideos,
  summarizeWatchProviderMatches,
  summarizeWatchProviders,
  type KeywordsResponse,
  type Page,
  type ProviderEntry,
  type TmdbCompany,
  type VideosResponse,
  type TmdbCollectionMatch,
  type TmdbAggregateCredits,
  type TmdbCredits,
  type TmdbReview,
  type TmdbMovie,
  type TmdbMovieReleases,
  type TmdbMultiItem,
  type TmdbPage,
  type TmdbSeason,
  type TmdbTv,
  type WatchProvidersResponse,
} from "../format.ts";
import type { Logger } from "../lib/logger.ts";
import type { Config } from "../config.ts";
// Type-only: DiscoverParams is z.infer'd from the input schema in
// tools/tmdb/discover.ts (discoverParamsSchema). `import type` is erased at
// build, so there is no runtime cycle even though discover.ts imports
// TmdbClient from here.
import type {
  DiscoverParams,
  RELEASE_TYPES,
  TV_STATUSES,
  TV_TYPES,
} from "../tools/tmdb/discover.ts";

type Query = Record<string, string | number | boolean | undefined>;

// TMDB's hard cap on remote calls per append_to_response request.
const MAX_APPEND_TO_RESPONSE = 20;

// A show can have 30+ seasons, each under its own 50-episode cap (see
// summarizeSeason), but the sum across an expand_episodes bulk fetch can reach
// the hundreds. This is the cheap pre-fetch budget: getTvSeasonsBulk uses each
// season's known episode_count (from the show's season list) to skip seasons
// entirely beyond it, and capTotalEpisodes applies it again to the fetched data
// in case that count undercounts. Each season's episode_count still reports its
// true total after truncation.
export const MAX_EXPANDED_EPISODES = 250;

// Per-season cap applied by summarizeSeason. getTvSeasonsBulk's budget must
// charge a season what it will return (min(episode_count, this)), not its true
// episode_count: season 0 "Specials" often reports 80+ episodes but contributes
// at most 50, and charging 80+ would evict later seasons that fit.
export const MAX_SEASON_EPISODES = 50;

// The real constraint is serialized response size, which an episode count only
// approximates: 500 episodes of The Simpsons (802 in total) still came to
// ~75-80K characters. capTotalEpisodesBySize measures the serialized size and
// trims further when needed.
export const MAX_EXPANDED_EPISODES_CHARS = 40_000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
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

// Size backstop (see MAX_EXPANDED_EPISODES_CHARS): walks episodes in order and
// stops adding them (for this and every later season) once the serialized
// total would exceed maxChars. One pass, no repeated full-array JSON.stringify.
function capTotalEpisodesBySize(
  seasons: ReturnType<typeof summarizeSeason>[],
  maxChars: number,
): ReturnType<typeof summarizeSeason>[] {
  let used = JSON.stringify(seasons.map((s) => ({ ...s, episodes: [] }))).length;
  return seasons.map((s) => {
    const episodes: typeof s.episodes = [];
    for (const ep of s.episodes) {
      const epSize = JSON.stringify(ep).length + 1; // +1 for the array separator
      if (used + epSize > maxChars) break;
      used += epSize;
      episodes.push(ep);
    }
    return episodes.length === s.episodes.length ? s : { ...s, episodes };
  });
}

// "de-DE" + original "ja" → "de,en,ja,null": the configured language, English,
// the title's original language (its native trailers), and untagged videos.
function videoLanguages(language: string, originalLanguage?: string): string {
  const langs = [language.split("-")[0], "en", originalLanguage, "null"];
  return [...new Set(langs.filter(Boolean))].join(",");
}

interface SearchParams {
  query: string;
  year?: number;
  exact_year?: boolean;
  page?: number;
  include_adult?: boolean;
  language?: string;
}

type TrendingMediaType = "all" | "movie" | "tv" | "person";
type TrendingWindow = "day" | "week";

export type { DiscoverParams };

// TMDB's /find supports all three, but only "imdb_id" is wired to a tool
// (find_by_imdb_id).
type ExternalSource = "imdb_id" | "tvdb_id" | "wikidata_id";

// Return type of methods that dispatch on a runtime "movie" | "tv" media kind.
// Which branch you get depends on the `mediaType` argument.
type MovieOrTvPage = Page<ReturnType<typeof summarizeMovie>> | Page<ReturnType<typeof summarizeTv>>;

// getTv's return shape: detailTv plus the per-season episode expansion, which
// is only present when a caller passes expandEpisodes.
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

  /** For callers that report this client's failures (see tools/shared.ts). */
  readonly logger: Logger;

  constructor(config: Config, logger: Logger) {
    this.logger = logger;
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
      cacheMaxStaleMs: config.cacheMaxStaleMs,
      defaultHeaders: config.tmdbApiToken ? { Authorization: `Bearer ${config.tmdbApiToken}` } : {},
      // TMDB's null only means "no value" (no field reads it otherwise).
      reviver: nullAsAbsent,
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

  // The search/discover/similar methods are not cached (unlike the detail
  // getters below), so they take the caller's AbortSignal and can be cancelled
  // mid-flight when the MCP client cancels the tool call.

  async searchMovies(
    p: SearchParams,
    signal?: AbortSignal,
  ): Promise<Page<ReturnType<typeof summarizeMovie>>> {
    const res = await this.#get<TmdbPage<TmdbMovie>>(
      "search/movie",
      {
        query: p.query,
        // `year` matches any release date (re-releases included);
        // primary_release_year only the original one.
        ...(p.exact_year ? { primary_release_year: p.year } : { year: p.year }),
        page: p.page,
        include_adult: p.include_adult,
        // No `region`: on /search/movie it only swaps release_date (and so
        // `year`) for that country's date, without filtering or reordering
        // (verified live). Oldboy (2003) read as 2005 under US.
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
    return page(res, (item) => summarizeMultiItem(item, p.include_adult));
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
    // /search/person rows carry no media_type (unlike /search/multi), so
    // summarizeMultiItem would misclassify every one.
    return page(res, (item) => summarizePerson(item, p.include_adult));
  }

  // Keyword ids feed discover_*'s with_keywords; this resolves names to ids.
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

  // Company ids feed discover_*'s with_companies; this resolves names to ids.
  // Names aren't unique (TMDB has two unrelated "A24"s), so origin_country
  // stays in the shaped result to tell rows apart.
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

  // Collection ids feed get_collection. Only query/page/language are sent:
  // include_adult and region don't change /search/collection's results
  // (verified live).
  async searchCollections(
    query: string,
    pg?: number,
    language?: string,
    signal?: AbortSignal,
  ): Promise<Page<ReturnType<typeof summarizeCollectionMatch>>> {
    const res = await this.#get<TmdbPage<TmdbCollectionMatch>>(
      "search/collection",
      { query, page: pg },
      language,
      signal,
    );
    return page(res, summarizeCollectionMatch);
  }

  // ---- details (cached: stable, frequently re-requested) --------------------

  async getMovie(
    id: number,
    region = this.#region,
    language?: string,
  ): Promise<ReturnType<typeof detailMovie>> {
    return detailMovie(await this.#movieRaw(id, language), region);
  }

  // The raw detail is cached, not the shaped one: `region` only picks which
  // country's certification detailMovie/detailTv headline (release_dates and
  // content_ratings carry every country), so keying on region would refetch
  // the same response per region.
  #movieRaw(id: number, language?: string): Promise<TmdbMovie> {
    return this.#cached(
      cacheKey(`movie:${id}`, { language: this.#lang(language) }),
      `movie/${id}`,
      (res: TmdbMovie) => res,
      // release_dates for age/content certifications; keywords so the agent can
      // feed their ids into discover_*.
      { append_to_response: "release_dates,keywords" },
      language,
    );
  }

  #tvRaw(id: number, language?: string): Promise<TmdbTv> {
    return this.#cached(
      cacheKey(`tv:${id}`, { language: this.#lang(language) }),
      `tv/${id}`,
      (res: TmdbTv) => res,
      // external_ids because base /tv/{id}, unlike /movie/{id}, has no imdb_id;
      // content_ratings for age/content certifications; keywords as for movies.
      { append_to_response: "external_ids,content_ratings,keywords" },
      language,
    );
  }

  async getTv(
    id: number,
    region = this.#region,
    language?: string,
    expandEpisodes = false,
  ): Promise<TvDetail> {
    const shaped = detailTv(await this.#tvRaw(id, language), region);
    if (!expandEpisodes) return shaped;
    const seasons = shaped.seasons.filter(
      (s): s is typeof s & { season_number: number } => s.season_number !== null,
    );
    if (seasons.length === 0) return shaped;
    return {
      ...shaped,
      seasons_detail: await this.#getTvSeasonsBulk(id, seasons, language),
    };
  }

  // Fetch every season's episode list via append_to_response=season/1,season/2,...
  // instead of one request per season. TMDB caps append_to_response at 20
  // remote calls, so shows with more seasons are split into chunks of at most
  // that many. Cached separately from getTv (keyed by the season list), since
  // it's only fetched when a caller sets expandEpisodes.
  async #getTvSeasonsBulk(
    id: number,
    seasons: {
      season_number: number;
      name: string | null;
      episode_count: number | null;
      air_date: string | null;
    }[],
    language?: string,
  ): Promise<ReturnType<typeof summarizeSeason>[]> {
    const key = cacheKey(`tv-seasons-bulk:${id}`, {
      seasons: seasons.map((s) => s.season_number).join(","),
      language: this.#lang(language),
    });
    // A result with a failed chunk's seasons emptied is degraded(): not cached,
    // a complete stale copy within the stale window wins over it, otherwise
    // the caller gets it flagged partial.
    const bulk = await this.#cache.wrapStaleOnError(key, async () => {
      // Skip seasons whose known episode_count puts them entirely beyond the
      // budget; fetch only up through the season that crosses it (for its
      // partial truncation). An unknown count (null) is charged 0, so it is
      // fetched while budget remains and skipped once it's spent.
      let remaining = MAX_EXPANDED_EPISODES;
      const toFetch: number[] = []; // indices into `seasons`
      seasons.forEach((s, i) => {
        if (remaining <= 0) return;
        toFetch.push(i);
        // Charge what the season can contribute (summarizeSeason trims it to
        // MAX_SEASON_EPISODES), not its raw episode_count; see that constant.
        remaining -= Math.min(s.episode_count ?? 0, MAX_SEASON_EPISODES);
      });

      // A season that wasn't fetched (over budget, in a failed chunk, or
      // missing from its chunk's response) comes from the show's own season
      // metadata, with no episodes.
      const skippedEntry = (s: (typeof seasons)[number]): ReturnType<typeof summarizeSeason> => ({
        season_number: s.season_number,
        name: s.name,
        air_date: s.air_date,
        overview: null,
        poster_url: null,
        episode_count: s.episode_count ?? 0,
        episodes: [],
      });

      // Episodes are optional like any enrichment: a chunk lost to an outage
      // only empties its own seasons (a long-running show such as General
      // Hospital needs 2+ chunks), and the result is degraded.
      const chunks = chunk(toFetch, MAX_APPEND_TO_RESPONSE);
      const fetched = await Promise.all(
        chunks.map((indices) =>
          unlessOutage(
            this.#get<Record<string, TmdbSeason | undefined>>(
              `tv/${id}`,
              {
                append_to_response: indices
                  .map((i) => `season/${seasons[i]!.season_number}`)
                  .join(","),
              },
              language,
            ),
          ),
        ),
      );

      const out = seasons.map(skippedEntry);
      fetched.forEach((body, c) => {
        if (body === undefined) return;
        for (const i of chunks[c]!) {
          const raw = body[`season/${seasons[i]!.season_number}`];
          if (raw) out[i] = summarizeSeason(raw, MAX_SEASON_EPISODES, false);
        }
      });
      // parseSeasons validates the merged result through seasonSchema, which
      // also covers the hand-built skipped entries above.
      const result = {
        seasons: parseSeasons(
          capTotalEpisodesBySize(
            capTotalEpisodes(out, MAX_EXPANDED_EPISODES),
            MAX_EXPANDED_EPISODES_CHARS,
          ),
        ),
      };
      return fetched.includes(undefined) ? degraded(result) : result;
    });
    return bulk.seasons;
  }

  async getPerson(id: number, language?: string): Promise<ReturnType<typeof detailPerson>> {
    return this.#cached(
      cacheKey(`person:${id}`, { language: this.#lang(language) }),
      `person/${id}`,
      detailPerson,
      {},
      language,
    );
  }

  async getMovieCredits(
    id: number,
    language?: string,
  ): Promise<ReturnType<typeof summarizeCredits>> {
    return this.#cached(
      cacheKey(`movie-credits:${id}`, { language: this.#lang(language) }),
      `movie/${id}/credits`,
      (c: TmdbCredits) => summarizeCredits(c),
      {},
      language,
    );
  }

  async getTvCredits(
    id: number,
    language?: string,
  ): Promise<ReturnType<typeof summarizeTvCredits>> {
    return this.#cached(
      cacheKey(`tv-aggregate-credits:${id}`, { language: this.#lang(language) }),
      `tv/${id}/aggregate_credits`,
      (c: TmdbAggregateCredits) => summarizeTvCredits(c),
      {},
      language,
    );
  }

  // Paged movie/tv title list under a per-title sub-resource. `recommendations`
  // (co-viewing data) and `similar` (genre/keyword match) share this shape; only
  // the endpoint segment differs. Both keep TMDB's order and paging and drop
  // only explicit rows (withoutExplicit), so a page can be shorter than TMDB's
  // 20 while its totals stay TMDB's.
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
      return page(withoutExplicit(res), summarizeTv);
    }
    const res = await this.#get<TmdbPage<TmdbMovie>>(
      `movie/${id}/${kind}`,
      { page: pg },
      language,
      signal,
    );
    return page(withoutExplicit(res), summarizeMovie);
  }

  /** TMDB's co-viewing-based recommendations for a movie or TV show. */
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
  ): Promise<ReturnType<typeof summarizeCollection>> {
    return this.#cached(
      cacheKey(`collection:${id}`, { language: this.#lang(language) }),
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
    signal?: AbortSignal,
  ): Promise<Page<ReturnType<typeof summarizeMultiItem>>> {
    const res = await this.#get<TmdbPage<TmdbMultiItem>>(
      `trending/${mediaType}/${window}`,
      { page: pg },
      language,
      signal,
    );
    return page(withoutExplicit(res), (item) => summarizeMultiItem(item));
  }

  // Theatrical lists: what's in cinemas now / opening soon in `region`
  // (defaults to the configured TMDB_REGION). Not cached, like trending.
  async getMovieReleases(
    list: "now_playing" | "upcoming",
    p: { region?: string; language?: string; page?: number },
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof summarizeMovieReleases>> {
    const res = await this.#get<TmdbMovieReleases>(
      `movie/${list}`,
      { page: p.page, region: p.region ?? this.#region },
      p.language,
      signal,
    );
    return summarizeMovieReleases(withoutExplicit(res));
  }

  // Genre lists drive the readable names in search results; very static, so cached.
  // Cached per language so localized names are not mixed.
  async getGenres(
    mediaType: "movie" | "tv",
    language?: string,
  ): Promise<ReturnType<typeof summarizeGenres>> {
    return this.#cached(
      cacheKey(`genres:${mediaType}`, { language: this.#lang(language) }),
      `genre/${mediaType}/list`,
      (res: { genres: { id?: number; name?: string }[] }) => summarizeGenres(res.genres ?? []),
      {},
      language,
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
  ): Promise<ReturnType<typeof summarizeWatchProviders>> {
    // Cached raw: the response carries every region, and `region` only picks
    // which one summarizeWatchProviders headlines.
    const res = await this.#cache.wrapStaleOnError(cacheKey(`watch:${mediaType}:${id}`), () =>
      this.#http.getJson<WatchProvidersResponse>(`${mediaType}/${id}/watch/providers`),
    );
    return summarizeWatchProviders(res, region);
  }

  // Provider ids feed discover_*'s with_watch_providers; this resolves a
  // provider name (e.g. "Netflix") to an id. TMDB's endpoint has no query
  // parameter and always returns every provider for the media type (and
  // region, if given), so the full list is cached and matched against `query`
  // in the shaper. Each entry's lowercase name is precomputed here, once per
  // cache fill, not on every call.
  async searchWatchProviders(
    mediaType: "movie" | "tv",
    query: string,
    watchRegion?: string,
    page?: number,
  ): Promise<ReturnType<typeof summarizeWatchProviderMatches>> {
    const providers = await this.#cached(
      cacheKey(`watch-providers:${mediaType}`, { watchRegion }),
      `watch/providers/${mediaType}`,
      (res: { results?: ProviderEntry[] }) =>
        (res.results ?? []).map((p) => ({
          ...p,
          nameLower: (p.provider_name ?? "").toLowerCase(),
        })),
      watchRegion ? { watch_region: watchRegion } : {},
      undefined,
    );
    return summarizeWatchProviderMatches(providers, query, page);
  }

  // ---- person filmography ---------------------------------------------------

  async getPersonCredits(
    id: number,
    department?: string,
    limit?: number,
    language?: string,
  ): Promise<ReturnType<typeof summarizePersonCredits>> {
    // Cache the raw response: department/limit only change the shaping, so
    // keying on them would refetch the same combined_credits per combination.
    const raw = await this.#cached(
      cacheKey(`person-credits:${id}`, { language: this.#lang(language) }),
      `person/${id}/combined_credits`,
      trimCombinedCredits,
      {},
      language,
    );
    return summarizePersonCredits(raw, department, limit);
  }

  // ---- videos / trailers ----------------------------------------------------

  async getVideos(
    mediaType: "movie" | "tv",
    id: number,
    language?: string,
  ): Promise<ReturnType<typeof summarizeVideos>> {
    return this.#cache.wrapStaleOnError(
      cacheKey(`${mediaType}-videos:${id}`, { language: this.#lang(language) }),
      async () => {
        // The original language comes from the cached raw detail (shared with
        // get_movie/get_tv); without it a non-English film's native trailers
        // are dropped (Spirited Away: no ja trailer under en). It's optional:
        // an outage there degrades the list (not cached) instead of failing
        // the call.
        const detail = await unlessOutage(
          mediaType === "tv" ? this.#tvRaw(id, language) : this.#movieRaw(id, language),
        );
        // `language` alone keeps only that language's videos (29 → 2 for a
        // title under de-DE), so English and untagged ones are requested too.
        const res = await this.#get<VideosResponse>(
          `${mediaType}/${id}/videos`,
          {
            include_video_language: videoLanguages(this.#lang(language), detail?.original_language),
          },
          language,
        );
        const videos = summarizeVideos(res);
        return detail === undefined ? degraded(videos) : videos;
      },
    );
  }

  // ---- reverse lookup -------------------------------------------------------

  async findByExternalId(
    externalId: string,
    source: ExternalSource,
  ): Promise<ReturnType<typeof summarizeFind>> {
    return this.#cached(
      cacheKey(`find:${source}:${externalId}`),
      `find/${externalId}`,
      summarizeFind,
      { external_source: source },
      undefined,
    );
  }

  // ---- TV deep dive ---------------------------------------------------------

  async getTvSeason(
    id: number,
    season: number,
    language?: string,
  ): Promise<ReturnType<typeof summarizeSeason>> {
    return this.#cached(
      cacheKey(`tv-season:${id}:${season}`, { language: this.#lang(language) }),
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
  ): Promise<ReturnType<typeof summarizeEpisode>> {
    return this.#cached(
      cacheKey(`tv-episode:${id}:${season}:${episode}`, { language: this.#lang(language) }),
      `tv/${id}/season/${season}/episode/${episode}`,
      // Inject season_number in case the episode payload omits it.
      (res: Parameters<typeof summarizeEpisode>[0]) =>
        summarizeEpisode({ ...res, season_number: res.season_number ?? season }),
      // external_ids carries the episode's own imdb_id, the only route to a
      // per-episode IMDb rating (get_ratings; OMDb keys on that id and TMDB has
      // it nowhere else). It rides on this request at no extra cost. The
      // season/bulk paths can't do this: /tv/{id}/season/{n}'s external_ids is
      // season-level (tvdb/wikidata, no imdb_id) and its episode rows carry
      // none (verified live), so per-episode ids would take one request per
      // episode, up to 250 for expand_episodes.
      { append_to_response: "external_ids" },
      language,
    );
  }

  // Cache by `key`, GET `path` (with language injected), then shape the body.
  // R is inferred from `shape`'s return type, so each caller gets its real shape.
  async #cached<T, R>(
    key: string,
    path: string,
    shape: (data: T) => R,
    query: Query = {},
    language?: string,
  ): Promise<R> {
    return this.#cache.wrapStaleOnError(key, async () => {
      const res = await this.#get<T>(path, query, language);
      return shape(res);
    });
  }
}

// Maps each DiscoverParams field to the TMDB query key(s) it becomes for movie
// and/or tv. Some use a dotted range syntax like "vote_average.gte", some
// differ per kind, and some are exclusive to one (with_cast: movie only,
// with_networks: tv only). certification/certification_country work for both
// (verified live against /discover/tv, though TMDB's docs mention only movies).
// The Record type requires a row for every DiscoverParams field except
// `language` (applied separately), so a field added to the discover schemas in
// tools/tmdb/discover.ts without a mapping here is a compile error, not a
// filter that silently never reaches TMDB.
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
  any_release_date_gte: { movie: "release_date.gte" },
  any_release_date_lte: { movie: "release_date.lte" },
  with_release_type: { movie: "with_release_type" },
  air_date_gte: { tv: "air_date.gte" },
  air_date_lte: { tv: "air_date.lte" },
  with_origin_country: { movie: "with_origin_country", tv: "with_origin_country" },
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
  without_companies: { movie: "without_companies", tv: "without_companies" },
  with_keywords: { movie: "with_keywords", tv: "with_keywords" },
  without_keywords: { movie: "without_keywords", tv: "without_keywords" },
  with_watch_providers: { movie: "with_watch_providers", tv: "with_watch_providers" },
  without_watch_providers: { movie: "without_watch_providers", tv: "without_watch_providers" },
  watch_region: { movie: "watch_region", tv: "watch_region" },
  with_watch_monetization_types: {
    movie: "with_watch_monetization_types",
    tv: "with_watch_monetization_types",
  },
  with_networks: { tv: "with_networks" },
  with_type: { tv: "with_type" },
  with_status: { tv: "with_status" },
  certification: { movie: "certification", tv: "certification" },
  certification_country: { movie: "certification_country", tv: "certification_country" },
  include_adult: { movie: "include_adult", tv: "include_adult" },
  region: { movie: "region" },
  page: { movie: "page", tv: "page" },
};

// TMDB's with_type/with_status take numeric codes (verified live against
// /discover/tv), while the schema in tools/tmdb/discover.ts (TV_TYPES/
// TV_STATUSES) asks callers for names. Translated here, after
// DISCOVER_FIELD_MAP's generic pass-through copies the raw string in.
const TV_TYPE_IDS: Record<(typeof TV_TYPES)[number], number> = {
  Documentary: 0,
  News: 1,
  Miniseries: 2,
  Reality: 3,
  Scripted: 4,
  "Talk Show": 5,
  Video: 6,
};
const TV_STATUS_IDS: Record<(typeof TV_STATUSES)[number], number> = {
  "Returning Series": 0,
  Planned: 1,
  "In Production": 2,
  Ended: 3,
  Cancelled: 4,
  Pilot: 5,
};

// TMDB's with_release_type codes, same pattern as TV_TYPE_IDS above.
const RELEASE_TYPE_IDS: Record<(typeof RELEASE_TYPES)[number], number> = {
  premiere: 1,
  theatrical_limited: 2,
  theatrical: 3,
  digital: 4,
  physical: 5,
  tv: 6,
};

export function discoverQuery(p: DiscoverParams, kind: "movie" | "tv"): Query {
  const query: Query = {};
  for (const field of Object.keys(DISCOVER_FIELD_MAP) as (keyof typeof DISCOVER_FIELD_MAP)[]) {
    const tmdbKey = DISCOVER_FIELD_MAP[field][kind];
    const value = p[field];
    // Array fields (with_watch_monetization_types, with_origin_country,
    // with_release_type): TMDB reads "|" as OR. "," would AND them (verified
    // live), or for with_release_type do neither.
    if (tmdbKey) query[tmdbKey] = Array.isArray(value) ? value.join("|") : value;
  }
  if (kind === "movie" && p.with_release_type !== undefined) {
    query.with_release_type = p.with_release_type.map((t) => RELEASE_TYPE_IDS[t]).join("|");
  }
  if (kind === "tv") {
    if (p.with_type !== undefined) query.with_type = TV_TYPE_IDS[p.with_type];
    if (p.with_status !== undefined) query.with_status = TV_STATUS_IDS[p.with_status];
  }
  return query;
}
