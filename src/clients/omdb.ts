// Read-only client for the OMDb API (omdbapi.com). OMDb is *enrichment only*:
// it supplies IMDb/Rotten Tomatoes/Metacritic ratings keyed by the imdb_id that
// TMDB already returns. It is intentionally thin — TMDB is the navigator. Needs
// a free API key (https://www.omdbapi.com/apikey.aspx) passed as `?apikey=`.
//
// OMDb quirk: it reports failures in the body as { Response: "False", Error }
// — "not found" with a 200 OK, a bad key with a 401. #get() keeps only a miss
// as data (summarizeRatings turns it into a soft { found: false }); any other
// body error is the service refusing, so it throws like an HTTP failure would
// and is never cached as "no ratings".
import { HttpClient } from "../lib/http.ts";
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

  constructor(config: Config, logger: Logger) {
    this.#apiKey = config.omdbApiKey;
    this.configured = Boolean(config.omdbApiKey);
    const { http, cache } = createUpstream({
      baseUrl: config.omdbBaseUrl,
      logger,
      timeoutMs: config.httpTimeoutMs,
      retries: config.httpRetries,
      minIntervalMs: config.omdbMinIntervalMs,
      cacheTtlMs: config.cacheTtlMs,
    });
    this.#http = http;
    this.#cache = cache;
  }

  /** Ratings for an IMDb title id (e.g. "tt0133093"). */
  async ratingsByImdbId(
    imdbId: string,
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizeRatings>> {
    return this.#cache.wrapStaleOnError(
      cacheKey(`omdb:i:${imdbId}`),
      async () => {
        return summarizeRatings(await this.#get({ i: imdbId }));
      },
      onStale,
    );
  }

  /** Ratings looked up by title (+ optional year/type to disambiguate). */
  async ratingsByTitle(
    title: string,
    year?: number,
    type?: "movie" | "series" | "episode",
    onStale?: () => void,
  ): Promise<ReturnType<typeof summarizeRatings>> {
    return this.#cache.wrapStaleOnError(
      cacheKey(`omdb:t:${title}`, { year, type }),
      async () => {
        return summarizeRatings(await this.#get({ t: title, y: year, type }));
      },
      onStale,
    );
  }

  async #get(query: Record<string, string | number | undefined>): Promise<OmdbResponse> {
    const res = await this.#http.getJson<OmdbResponse>("", {
      query: { apikey: this.#apiKey, ...query },
    });
    if (res.Response === "False" && res.Error && !OMDB_MISS.test(res.Error)) {
      throw new ApiError({
        code: /limit/i.test(res.Error)
          ? "rate_limited"
          : /api key/i.test(res.Error)
            ? "unauthorized"
            : "unknown",
        message: `OMDb refused the request: ${redact(res.Error)}`,
        detail: redact(res.Error),
      });
    }
    return res;
  }
}

// OMDb's "no such title" answers, verified live ("Incorrect IMDb ID.") or
// documented; anything else in `Error` (an exhausted quota, a bad key) is a
// refusal, not an empty result.
const OMDB_MISS = /not found|incorrect imdb id|error getting data|too many results/i;
