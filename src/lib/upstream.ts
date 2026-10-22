// Wires the generic pieces every upstream API client needs (rate limiter,
// HTTP client, TTL cache) from Config-shaped values, so each client only
// declares its own endpoints and response shaping.
import { HttpClient } from "./http.ts";
import { RateLimiter } from "./rateLimit.ts";
import { TtlCache } from "./cache.ts";
import type { Logger } from "./logger.ts";

export interface UpstreamOptions {
  baseUrl: string;
  logger: Logger;
  timeoutMs: number;
  retries: number;
  minIntervalMs: number;
  cacheTtlMs: number;
  defaultHeaders?: Record<string, string>;
}

export interface Upstream {
  http: HttpClient;
  cache: TtlCache;
}

export function createUpstream(opts: UpstreamOptions): Upstream {
  const limiter = new RateLimiter(opts.minIntervalMs);
  const http = new HttpClient({
    baseUrl: opts.baseUrl,
    logger: opts.logger,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    defaultHeaders: opts.defaultHeaders,
    beforeRequest: () => limiter.acquire(),
  });
  const cache = new TtlCache(opts.cacheTtlMs, undefined, opts.logger);
  return { http, cache };
}
