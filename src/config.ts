// Loads and validates configuration from environment variables. Two upstreams:
// TMDB (the backbone — search, metadata, people, trending) needs a v4 Read
// Access Token; OMDb (optional enrichment — IMDb/Rotten Tomatoes/Metacritic
// ratings) needs a free API key. Both credentials are optional so the server
// always starts and can list tools; each tool reports a clear error at call
// time when its credential is missing. Empty strings are treated as unset so
// .mcpb (which passes "" for unconfigured user_config fields) does not crash
// startup.
import { z } from "zod";
import type { LogLevel } from "./lib/logger.js";

const EnvSchema = z.object({
  // --- TMDB: the primary read backbone. v4 "Read Access Token" (a long JWT),
  //     sent as `Authorization: Bearer <token>`. Get one at
  //     https://www.themoviedb.org/settings/api ---
  TMDB_API_TOKEN: z.string().min(1).optional(),
  TMDB_BASE_URL: z.string().url().default("https://api.themoviedb.org/3"),
  // Default response language (ISO-639-1, optionally with a region: "ru-RU",
  // "en-US", "ja"). Applied to every TMDB request so titles/overviews/genre
  // names come back localized; tools can override it per call.
  TMDB_LANGUAGE: z.string().min(2).default("en-US"),
  // Default ISO-3166-1 country for region-specific results (release dates,
  // watch providers). Optional; tools that need a region also accept one.
  TMDB_REGION: z
    .string()
    .regex(/^[A-Z]{2}$/, "TMDB_REGION must be a two-letter ISO-3166-1 code, e.g. US")
    .default("US"),

  // --- OMDb: optional enrichment for IMDb/RT/Metacritic ratings, keyed by the
  //     imdb_id TMDB returns. Free key at https://www.omdbapi.com/apikey.aspx ---
  OMDB_API_KEY: z.string().min(1).optional(),
  OMDB_BASE_URL: z.string().url().default("https://www.omdbapi.com"),

  // --- Generic tunables. ---
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  HTTP_RETRIES: z.coerce.number().int().nonnegative().default(2),
  // Minimum spacing between calls to each upstream. TMDB tolerates ~50 req/s;
  // OMDb's free tier is a daily quota with no tight burst limit. Set to 0 to
  // disable client-side throttling (used in tests).
  TMDB_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(60),
  OMDB_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(0),
  CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(300_000),

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
  logLevel: LogLevel;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Drop empty-string values so defaults apply and optional secrets stay unset.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const parsed = EnvSchema.parse(cleaned);

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
    logLevel: parsed.LOG_LEVEL,
  };
}
