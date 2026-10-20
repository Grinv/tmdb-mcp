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
  summarizePerson,
  summarizePersonCredits,
  summarizeReview,
  summarizeSeason,
  summarizeTv,
  summarizeVideos,
  summarizeWatchProviderMatches,
  summarizeWatchProviders,
  type CombinedCredits,
  type KeywordsResponse,
  type Page,
  type ProviderEntry,
  type TmdbCompany,
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
} from "../format.js";
import type { Logger } from "../lib/logger.js";
import type { Config } from "../config.js";
// Type-only: DiscoverParams' source of truth is the input zod schema in
// tools/tmdb/discover.ts (per-field descriptions/validation belong there),
// z.infer'd and re-exported for client code — see discoverParamsSchema there.
// `import type` is fully erased at build, so this doesn't create a runtime
// circular import even though tools/tmdb/discover.ts also imports TmdbClient
// from here.
import type {
  DiscoverParams,
  RELEASE_TYPES,
  TV_STATUSES,
  TV_TYPES,
} from "../tools/tmdb/discover.js";

type Query = Record<string, string | number | boolean | undefined>;

// TMDB's hard cap on remote calls per append_to_response request.
const MAX_APPEND_TO_RESPONSE = 20;

// A show can have 30+ seasons, each already under its own 50-episode cap
// (see summarizeSeason) — but the SUM across every season in an
// expand_episodes bulk fetch can still reach into the hundreds and blow past
// a usable response size. This is the cheap, pre-fetch budget: getTvSeasonsBulk
// uses each season's already-known episode_count (from the show's own season
// list — no extra request needed) to skip fetching seasons that fall entirely
// beyond it, and capTotalEpisodes applies it again to the fetched data as a
// fallback in case that metadata undercounts a season's real episodes.
// episode_count on each season still reports that season's true total even
// once its episodes are truncated to fit.
export const MAX_EXPANDED_EPISODES = 250;

// Per-season cap applied by summarizeSeason to each season's episode list.
// Named here because getTvSeasonsBulk's pre-fetch budget must charge a season
// what it will actually RETURN (min(episode_count, this)), not its true
// episode_count: season 0 "Specials" routinely reports 80+ episodes but can
// only ever contribute 50, and charging the full 80+ used to evict later
// seasons that would have fit.
export const MAX_SEASON_EPISODES = 50;

// The actual constraint MAX_EXPANDED_EPISODES approximates is serialized
// response SIZE, not episode count — an episode count alone doesn't bound
// size if `name` runs unusually long. 500 (then 250) episodes were tried as a
// count-only cap, but a real 500-episode seasons_detail (The Simpsons, 802
// episodes) still ran ~75-80K characters. This is the authoritative backstop:
// capTotalEpisodesBySize measures the actual serialized bytes and trims
// further if needed, regardless of how verbose episode names turn out to be.
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

// Authoritative backstop on serialized size (see MAX_EXPANDED_EPISODES_CHARS)
// — walks episodes in order, measuring each one's actual serialized bytes,
// and stops adding episodes (for this and every later season) once the
// running total would exceed maxChars. A single pass, no repeated
// full-array JSON.stringify.
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

// Carries a partially-fetched expand_episodes result out of the cache's
// compute() without caching it — see #getTvSeasonsBulk.
class PartialSeasons extends Error {
  constructor(readonly result: { seasons: ReturnType<typeof summarizeSeason>[] }) {
    super("some expand_episodes chunks failed");
  }
}

// "de-DE" → "de,en,null": the configured language, English, and videos with
// no language tag.
function videoLanguages(language: string): string {
  return [...new Set([language.split("-")[0], "en", "null"])].join(",");
}

interface SearchParams {
  query: string;
  year?: number;
  exact_year?: boolean;
  page?: number;
  include_adult?: boolean;
  language?: string;
  /** search/movie only: bias release-date relevance to a country. */
  region?: string;
}

type TrendingMediaType = "all" | "movie" | "tv" | "person";
type TrendingWindow = "day" | "week";

export type { DiscoverParams };

// TMDB's /find endpoint supports all three, but only "imdb_id" is currently
// plumbed to a tool (find_by_imdb_id); "tvdb_id"/"wikidata_id" are latent
// capability for a future find-by-tvdb/wikidata tool.
type ExternalSource = "imdb_id" | "tvdb_id" | "wikidata_id";

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
        // `year` matches any release date (re-releases included);
        // primary_release_year only the original one.
        ...(p.exact_year ? { primary_release_year: p.year } : { year: p.year }),
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

  // Collection ids feed get_collection. Only query/page/language are sent:
  // verified live, include_adult and region don't change /search/collection's
  // results ("bond" and "collection" return the same rows either way).
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
    onStale?: () => void,
  ): Promise<ReturnType<typeof detailMovie>> {
    return detailMovie(await this.#movieRaw(id, language, onStale), region);
  }

  // The raw detail is cached, not the shaped one: `region` only picks which
  // country's certification detailMovie/detailTv headline — release_dates /
  // content_ratings carry every country — so a region-keyed cache would
  // refetch the same response once per region.
  #movieRaw(id: number, language?: string, onStale?: () => void): Promise<TmdbMovie> {
    return this.#cached(
      cacheKey(`movie:${id}`, { language: this.#lang(language) }),
      `movie/${id}`,
      (res: TmdbMovie) => res,
      // release_dates appended so the detail carries age/content certifications.
      { append_to_response: "release_dates" },
      language,
      onStale,
    );
  }

  #tvRaw(id: number, language?: string, onStale?: () => void): Promise<TmdbTv> {
    return this.#cached(
      cacheKey(`tv:${id}`, { language: this.#lang(language) }),
      `tv/${id}`,
      (res: TmdbTv) => res,
      // external_ids appended so the TV detail carries an imdb_id (the base
      // /tv/{id} response, unlike /movie/{id}, does not include one);
      // content_ratings appended for age/content certifications.
      { append_to_response: "external_ids,content_ratings" },
      language,
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
    const shaped = detailTv(await this.#tvRaw(id, language, onStale), region);
    if (!expandEpisodes) return shaped;
    const seasons = shaped.seasons.filter(
      (s): s is typeof s & { season_number: number } => s.season_number !== null,
    );
    if (seasons.length === 0) return shaped;
    return {
      ...shaped,
      seasons_detail: await this.#getTvSeasonsBulk(id, seasons, language, onStale),
    };
  }

  // Fetch every season's full episode list via append_to_response=season/1,
  // season/2,..., instead of one getTvSeason call per season. TMDB caps
  // append_to_response at 20 remote calls per request, so shows with more
  // seasons (e.g. long-running sitcoms/soaps) are split into multiple
  // append_to_response requests of at most that many seasons each. Cached
  // separately from getTv (and keyed by the season list) since it's only
  // fetched when a caller opts in via expandEpisodes.
  async #getTvSeasonsBulk(
    id: number,
    seasons: {
      season_number: number;
      name: string | null;
      episode_count: number | null;
      air_date: string | null;
    }[],
    language?: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizeSeason>[]> {
    const key = cacheKey(`tv-seasons-bulk:${id}`, {
      seasons: seasons.map((s) => s.season_number).join(","),
      language: this.#lang(language),
    });
    // A result with a failed chunk's seasons emptied is returned to this one
    // caller but never cached: it travels out of compute as a thrown
    // PartialSeasons, so wrapStaleOnError prefers a complete stale copy when it
    // has one (flagging it stale) and otherwise rethrows it to the catch below.
    let bulk: { seasons: ReturnType<typeof summarizeSeason>[] };
    try {
      bulk = await this.#cache.wrapStaleOnError(
        key,
        async () => {
          // A season whose true episode_count (already known from getTv's own
          // season list — no extra request needed) is guaranteed to fall
          // entirely beyond the aggregate budget doesn't need fetching at all:
          // pulling its full episode list over the wire just to discard it in
          // capTotalEpisodes is wasted work. Only fetch up through the season
          // that actually crosses the budget boundary (to get its partial
          // truncation). An unknown count (null) is fetched while budget
          // remains (charged 0, since there's nothing to charge) and skipped
          // once it's spent, like any other season.
          let remaining = MAX_EXPANDED_EPISODES;
          const toFetch: number[] = []; // indices into `seasons`
          seasons.forEach((s, i) => {
            if (remaining <= 0) return;
            toFetch.push(i);
            // Charge what this season can actually contribute, not its raw
            // episode_count — summarizeSeason below trims it to
            // MAX_SEASON_EPISODES, so charging more evicts later seasons that
            // would have fit (season 0's 80+ specials being the usual culprit).
            remaining -= Math.min(s.episode_count ?? 0, MAX_SEASON_EPISODES);
          });

          // A season that wasn't fetched (beyond the budget, in a failed chunk,
          // or missing from its chunk's response) is reported from the show's
          // own season metadata, with no episodes.
          const skippedEntry = (
            s: (typeof seasons)[number],
          ): ReturnType<typeof summarizeSeason> => ({
            season_number: s.season_number,
            name: s.name,
            air_date: s.air_date,
            overview: null,
            poster_url: null,
            episode_count: s.episode_count ?? 0,
            episodes: [],
          });

          // allSettled, not all: a long-running show needs 2+ chunked requests
          // (e.g. General Hospital, Top Gear), and one failed chunk shouldn't
          // sink the seasons the other chunks did return. Only when every chunk
          // fails is it a real upstream failure — rethrow so wrapStaleOnError
          // can still fall back to a stale cached value.
          const chunks = chunk(toFetch, MAX_APPEND_TO_RESPONSE);
          const settled = await Promise.allSettled(
            chunks.map((indices) =>
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
          );
          const firstFailure = settled.find((r) => r.status === "rejected");
          if (firstFailure && settled.every((r) => r.status === "rejected")) {
            throw firstFailure.reason;
          }

          const out = seasons.map(skippedEntry);
          settled.forEach((result, c) => {
            if (result.status !== "fulfilled") return;
            for (const i of chunks[c]!) {
              const raw = result.value[`season/${seasons[i]!.season_number}`];
              if (raw) out[i] = summarizeSeason(raw, MAX_SEASON_EPISODES, false);
            }
          });
          // parseSeasons re-validates the fetched/capped/skipped merge through
          // seasonSchema, so this aggregate path gets the same drift/degrade
          // guarantee the direct shapers have (the skipped entries above are
          // hand-built and would otherwise skip validation entirely).
          const result = {
            seasons: parseSeasons(
              capTotalEpisodesBySize(
                capTotalEpisodes(out, MAX_EXPANDED_EPISODES),
                MAX_EXPANDED_EPISODES_CHARS,
              ),
            ),
          };
          if (firstFailure) throw new PartialSeasons(result);
          return result;
        },
        onStale,
      );
    } catch (err) {
      if (err instanceof PartialSeasons) return err.result.seasons;
      throw err;
    }
    return bulk.seasons;
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
  ): Promise<ReturnType<typeof summarizeTvCredits>> {
    return this.#cached(
      cacheKey(`tv-aggregate-credits:${id}`, { language: this.#lang(language) }),
      `tv/${id}/aggregate_credits`,
      (c: TmdbAggregateCredits) => summarizeTvCredits(c),
      {},
      language,
      onStale,
    );
  }

  // Paged movie/tv title list under a per-title sub-resource. `recommendations`
  // (co-viewing data) and `similar` (genre/keyword match) share this shape; the endpoint
  // segment differs and the summarizer follows the media type. Both are
  // returned as TMDB ranks them, unfiltered, so paging stays TMDB's own.
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
      return page(res, summarizeTv);
    }
    const res = await this.#get<TmdbPage<TmdbMovie>>(
      `movie/${id}/${kind}`,
      { page: pg },
      language,
      signal,
    );
    return page(res, summarizeMovie);
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
    signal?: AbortSignal,
  ): Promise<Page<ReturnType<typeof summarizeMultiItem>>> {
    const res = await this.#get<TmdbPage<TmdbMultiItem>>(
      `trending/${mediaType}/${window}`,
      { page: pg },
      language,
      signal,
    );
    return page(res, summarizeMultiItem);
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
    return summarizeMovieReleases(res);
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
    // Cached raw: the response carries every region, and `region` only picks
    // which one summarizeWatchProviders headlines.
    const res = await this.#cache.wrapStaleOnError(
      cacheKey(`watch:${mediaType}:${id}`),
      () => this.#http.getJson<WatchProvidersResponse>(`${mediaType}/${id}/watch/providers`),
      onStale,
    );
    return summarizeWatchProviders(res, region);
  }

  // Provider ids feed discover_*'s with_watch_providers; this resolves a
  // provider name (e.g. "Netflix") → id. TMDB's own endpoint has no query
  // parameter — it always returns every provider for the given media type
  // (+ region, if given), so the full list is cached (like getGenres caches
  // its own reference list) and matched against `query` in the shaper.
  // Precomputes each entry's lowercase name once here, at cache-population
  // time, rather than in the shaper on every call against a warm cache entry.
  async searchWatchProviders(
    mediaType: "movie" | "tv",
    query: string,
    watchRegion?: string,
    page?: number,
    onStale?: () => void,
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
      onStale,
    );
    return summarizeWatchProviderMatches(providers, query, page);
  }

  // ---- person filmography ---------------------------------------------------

  async getPersonCredits(
    id: number,
    department?: string,
    limit?: number,
    language?: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizePersonCredits>> {
    // Cache the raw response, not the shaped one: department/limit only
    // change the shaping, never the upstream request, so keying the cache on
    // them would refetch the same combined_credits once per combination.
    const raw = await this.#cached(
      cacheKey(`person-credits:${id}`, { language: this.#lang(language) }),
      `person/${id}/combined_credits`,
      (c: CombinedCredits) => c,
      {},
      language,
      onStale,
    );
    return summarizePersonCredits(raw, department, limit);
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
      // `language` alone filters videos down to that one language (29 → 2 for
      // a title under de-DE); also include English and language-neutral ones.
      { include_video_language: videoLanguages(this.#lang(language)) },
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
      // external_ids carries the episode's own imdb_id — the only route to a
      // per-episode IMDb rating (via get_ratings), since OMDb keys on that id
      // and TMDB puts it nowhere else. Appended to this same request, so it
      // costs no extra round trip. Deliberately NOT done for the season/bulk
      // paths: verified live, /tv/{id}/season/{n}'s own external_ids is
      // season-level (tvdb/wikidata, no imdb_id at all) and its episode rows
      // carry none, so per-episode ids there would mean one request per
      // episode — up to 250 for expand_episodes.
      { append_to_response: "external_ids" },
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
// some differ per kind; some — with_cast = movie-only, with_networks =
// tv-only — are exclusive to one). certification/certification_country work
// for both (verified live against /discover/tv, not just /discover/movie,
// despite TMDB's own docs only mentioning it for movies). The Record type
// requires every DiscoverParams field
// (other than `language`, applied separately) to have a row here, so adding a
// field to either tool-facing discover schema in tools/tmdb/discover.ts without
// adding its mapping here is a compile error instead of a filter that silently
// never reaches TMDB — DiscoverParams itself is z.infer'd from that schema
// (see discoverParamsSchema in tools/tmdb/discover.ts), so there's no third
// hand-kept copy left to drift.
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

// TMDB's actual with_type/with_status query values are numeric codes, not the
// human-readable names tools/tmdb/discover.ts's schema asks callers for
// (TV_TYPES/TV_STATUSES there) — verified live against /discover/tv.
// Translated here, after DISCOVER_FIELD_MAP's generic pass-through copies the
// raw string in.
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
    // with_release_type): TMDB reads "|" as OR (verified live; "," would AND
    // them, or for with_release_type do neither).
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
