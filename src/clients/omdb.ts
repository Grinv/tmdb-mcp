// Read-only client for the OMDb API (omdbapi.com). OMDb is *enrichment only*:
// it supplies IMDb/Rotten Tomatoes/Metacritic ratings keyed by the imdb_id that
// TMDB already returns. It is intentionally thin — TMDB is the navigator. Needs
// a free API key (https://www.omdbapi.com/apikey.aspx) passed as `?apikey=`.
//
// OMDb quirk: it answers 200 OK even for "not found", with a JSON body of
// { Response: "False", Error: "..." }. summarizeRatings() turns that into a
// soft { found: false } object so enrichment never hard-fails a TMDB lookup.
import { HttpClient } from "../lib/http.js";
import { TtlCache, cacheKey } from "../lib/cache.js";
import { createUpstream } from "../lib/upstream.js";
import { summarizeRatings, type OmdbResponse } from "../format.js";
import type { Logger } from "../lib/logger.js";
import type { Config } from "../config.js";

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
  async ratingsByImdbId(imdbId: string): Promise<ReturnType<typeof summarizeRatings>> {
    return this.#cache.wrapStaleOnError(cacheKey(`omdb:i:${imdbId}`), async () => {
      const res = await this.#http.getJson<OmdbResponse>("", {
        query: { apikey: this.#apiKey, i: imdbId },
      });
      return summarizeRatings(res);
    });
  }

  /** Ratings looked up by title (+ optional year to disambiguate). */
  async ratingsByTitle(title: string, year?: number): Promise<ReturnType<typeof summarizeRatings>> {
    return this.#cache.wrapStaleOnError(cacheKey(`omdb:t:${title}`, { year }), async () => {
      const res = await this.#http.getJson<OmdbResponse>("", {
        query: { apikey: this.#apiKey, t: title, y: year },
      });
      return summarizeRatings(res);
    });
  }
}
