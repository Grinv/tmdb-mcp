// Builds the rate limiter, HTTP client and TTL cache every upstream client
// needs, so a client only declares its endpoints and response shaping.
import { HttpClient, type HttpClientOptions } from "./http.ts";
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
  cacheMaxStaleMs: number;
  defaultHeaders?: Record<string, string>;
  reviver?: HttpClientOptions["reviver"];
  refusedBody?: HttpClientOptions["refusedBody"];
  refineError?: HttpClientOptions["refineError"];
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
    reviver: opts.reviver,
    refusedBody: opts.refusedBody,
    refineError: opts.refineError,
    beforeRequest: () => limiter.acquire(),
  });
  const cache = new TtlCache({
    ttlMs: opts.cacheTtlMs,
    maxStaleMs: opts.cacheMaxStaleMs,
    logger: opts.logger,
  });
  return { http, cache };
}
