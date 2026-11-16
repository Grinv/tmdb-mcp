// Read-only client for the OMDb API (omdbapi.com), used only to enrich TMDB
// results with IMDb/Rotten Tomatoes/Metacritic ratings, keyed by the imdb_id
// TMDB returns. Needs a free API key (https://www.omdbapi.com/apikey.aspx),
// sent as `?apikey=`.
//
// OMDb reports failures in the body as { Response: "False", Error }: "not
// found" comes with a 200, a bad key with a 401. Only a miss is data
// (summarizeRatings turns it into { found: false }). Any other body error is
// a refusal: the transport fails it (refusedBody below) like an HTTP failure,
// through the same retry decision and outage log, and it is never cached as
// "no ratings".
import { HttpClient, nullAsAbsent } from "../lib/http.ts";
import { ApiError, redact } from "../lib/errors.ts";
import { TtlCache, cacheKey } from "../lib/cache.ts";
import { createUpstream } from "../lib/upstream.ts";
import { summarizeRatings, type OmdbResponse } from "../format.ts";
import type { Logger } from "../lib/logger.ts";
import type { Config } from "../config.ts";

export class OmdbClient {
  readonly #http: HttpClient;
  readonly #cache: TtlCache;
  readonly #apiKey: string | undefined;
  /** True when an OMDb key is configured; enrichment/tools skip otherwise. */
  readonly configured: boolean;
  /** Actionable error shown by tools when `configured` is false. */
  readonly notConfiguredMessage =
    "OMDb is not configured. Set OMDB_API_KEY to a free key from https://www.omdbapi.com/apikey.aspx.";

  /** For callers that report this client's failures (see tools/shared.ts). */
  readonly logger: Logger;

  constructor(config: Config, logger: Logger) {
    this.logger = logger;
    this.#apiKey = config.omdbApiKey;
    this.configured = Boolean(config.omdbApiKey);
    const { http, cache } = createUpstream({
      baseUrl: config.omdbBaseUrl,
      logger,
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
      minIntervalMs: config.omdbMinIntervalMs,
      cacheTtlMs: config.cacheTtlMs,
      cacheMaxStaleMs: config.cacheMaxStaleMs,
      reviver: nullAsAbsent,
      // OMDb refuses with `Response: "False"` in a 200 too; a miss ("Movie
      // not found!") is an answer, not a refusal.
      refusedBody: (body: OmdbResponse) =>
        body.Response === "False" && body.Error && !OMDB_MISS.test(body.Error)
          ? refusal(body.Error)
          : undefined,
      // On an error status, OMDb still names an exhausted quota in the body
      // (even with a 401); classify it before HttpClient decides to retry.
      refineError: (err) =>
        err.detail && OMDB_LIMIT.test(err.detail) ? refusal(err.detail, err.status, err) : err,
    });
    this.#http = http;
    this.#cache = cache;
  }

  /** Ratings for an IMDb title id (e.g. "tt0133093"). */
  async ratingsByImdbId(imdbId: string): Promise<ReturnType<typeof summarizeRatings>> {
    return this.#cache.wrapStaleOnError(cacheKey(`omdb:i:${imdbId}`), async () => {
      return summarizeRatings(await this.#get({ i: imdbId }));
    });
  }

  /** Ratings looked up by title (+ optional year/type to disambiguate). */
  async ratingsByTitle(
    title: string,
    year?: number,
    type?: "movie" | "series" | "episode",
  ): Promise<ReturnType<typeof summarizeRatings>> {
    return this.#cache.wrapStaleOnError(cacheKey(`omdb:t:${title}`, { year, type }), async () => {
      return summarizeRatings(await this.#get({ t: title, y: year, type }));
    });
  }

  #get(query: Record<string, string | number | undefined>): Promise<OmdbResponse> {
    return this.#http.getJson<OmdbResponse>("", { query: { apikey: this.#apiKey, ...query } });
  }
}

const OMDB_LIMIT = /limit/i;

function refusal(error: string, status?: number, cause?: ApiError): ApiError {
  return new ApiError({
    code: OMDB_LIMIT.test(error)
      ? "rate_limited"
      : /api key/i.test(error)
        ? "unauthorized"
        : "unknown",
    status,
    // The quota is daily, so unlike a 429 it won't clear in this session;
    // retrying would only burn calls.
    ...(OMDB_LIMIT.test(error) ? { retryable: false } : {}),
    message: `OMDb refused the request: ${redact(error)}`,
    detail: redact(error),
    cause,
  });
}

// OMDb's "no such title" answers (verified live, e.g. "Incorrect IMDb ID.", or
// documented). Any other `Error` (exhausted quota, bad key) is a refusal.
const OMDB_MISS = /not found|incorrect imdb id|error getting data|too many results/i;
