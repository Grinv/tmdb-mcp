// Loads and validates configuration from environment variables. TMDB (search,
// metadata, people, trending) needs a v4 Read Access Token; OMDb (optional
// IMDb/Rotten Tomatoes/Metacritic ratings) needs a free API key. Both are
// optional so the server always starts and lists tools; each tool reports a
// clear error at call time when its credential is missing. Empty strings and
// unfilled .mcpb placeholders count as unset (see below).
import { z } from "zod";
import type { LogLevel } from "./lib/logger.ts";

// Shared with tools/tmdb/fields.ts's per-call `language` param: same
// ISO-639-1[-ISO-3166-1] shape, so the regex lives once, here.
export const LANGUAGE_REGEX = /^[a-z]{2}(-[A-Z]{2})?$/;

const EnvSchema = z.object({
  // --- TMDB: v4 "Read Access Token" (a long JWT), sent as
  //     `Authorization: Bearer <token>`. Get one at
  //     https://www.themoviedb.org/settings/api ---
  TMDB_API_TOKEN: z.string().min(1).optional(),
  TMDB_BASE_URL: z.url().default("https://api.themoviedb.org/3"),
  // Default response language (ISO-639-1, optional region: "ru-RU", "en-US",
  // "ja"), applied to every TMDB request. Tools can override it per call.
  TMDB_LANGUAGE: z
    .string()
    .regex(
      LANGUAGE_REGEX,
      "TMDB_LANGUAGE must be an ISO-639-1 code, optionally with a region, e.g. en or en-US",
    )
    .default("en-US"),
  // Default ISO-3166-1 country for region-specific results (release dates,
  // watch providers). Tools that need a region also accept one.
  TMDB_REGION: z
    .string()
    .regex(/^[A-Z]{2}$/, "TMDB_REGION must be a two-letter ISO-3166-1 code, e.g. US")
    .default("US"),

  // --- OMDb: optional IMDb/RT/Metacritic ratings, keyed by the imdb_id TMDB
  //     returns. Free key at https://www.omdbapi.com/apikey.aspx ---
  OMDB_API_KEY: z.string().min(1).optional(),
  OMDB_BASE_URL: z.url().default("https://www.omdbapi.com"),

  // --- Generic tunables. ---
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  HTTP_RETRIES: z.coerce.number().int().nonnegative().default(2),
  // Minimum spacing between calls to each upstream. TMDB tolerates ~50 req/s;
  // OMDb's free tier has a daily quota and no tight burst limit. 0 disables
  // client-side throttling (used in tests).
  TMDB_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(60),
  OMDB_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(0),
  CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(300_000),
  // How long past expiry an entry may still stand in for an unreachable
  // upstream (RFC 5861 stale-if-error). Default one day.
  CACHE_MAX_STALE_MS: z.coerce.number().int().nonnegative().default(86_400_000),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export interface Config {
  tmdbBaseUrl: string;
  tmdbApiToken: string | undefined;
  tmdbLanguage: string;
  tmdbRegion: string;
  omdbBaseUrl: string;
  omdbApiKey: string | undefined;
  httpTimeoutMs: number;
  httpRetries: number;
  tmdbMinIntervalMs: number;
  omdbMinIntervalMs: number;
  cacheTtlMs: number;
  cacheMaxStaleMs: number;
  logLevel: LogLevel;
}

// .mcpb leaves an unfilled optional user_config field as the literal
// placeholder (e.g. "${user_config.tmdb_api_token}"), not "". It is non-empty,
// so without this a client would count as configured and send garbage
// upstream (401).
const UNSUBSTITUTED_PLACEHOLDER = /^\$\{[^}]*\}$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Drop empty strings and placeholders so defaults apply and optional secrets
  // stay unset.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(
      ([, v]) => v !== undefined && v !== "" && !UNSUBSTITUTED_PLACEHOLDER.test(v),
    ),
  );
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(unknown field)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration — ${issues}`);
  }
  const parsed = result.data;

  return {
    tmdbBaseUrl: parsed.TMDB_BASE_URL,
    tmdbApiToken: parsed.TMDB_API_TOKEN,
    tmdbLanguage: parsed.TMDB_LANGUAGE,
    tmdbRegion: parsed.TMDB_REGION,
    omdbBaseUrl: parsed.OMDB_BASE_URL,
    omdbApiKey: parsed.OMDB_API_KEY,
    httpTimeoutMs: parsed.HTTP_TIMEOUT_MS,
    httpRetries: parsed.HTTP_RETRIES,
    tmdbMinIntervalMs: parsed.TMDB_MIN_INTERVAL_MS,
    omdbMinIntervalMs: parsed.OMDB_MIN_INTERVAL_MS,
    cacheTtlMs: parsed.CACHE_TTL_MS,
    cacheMaxStaleMs: parsed.CACHE_MAX_STALE_MS,
    logLevel: parsed.LOG_LEVEL,
  };
}
