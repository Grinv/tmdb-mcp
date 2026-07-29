// TMDB-backed tools, split by domain: search.ts (name → id resolvers),
// details.ts (full/compact detail lookups, incl. OMDb ratings enrichment),
// discover.ts (trending/genres/filtered discovery), lookups.ts (supplementary
// per-title facts: watch providers, videos, external-id/season/episode
// lookups). Descriptions and per-field .describe() text are written for the
// calling model: when to use a tool and the meaning of every parameter.
import type { McpServer } from "@modelcontextprotocol/server";
import type { TmdbClient } from "../../clients/tmdb.js";
import type { OmdbClient } from "../../clients/omdb.js";
import type { Config } from "../../config.js";
import { requireConfigured, requireConfiguredCached } from "../shared.js";
import { regionSchema } from "./fields.js";
import { registerSearchTools } from "./search.js";
import { registerDetailsTools } from "./details.js";
import { registerDiscoverTools } from "./discover.js";
import { registerLookupTools } from "./lookups.js";

export function registerTmdbTools(
  server: McpServer,
  tmdb: TmdbClient,
  omdb: OmdbClient,
  config: Pick<Config, "tmdbRegion">,
): void {
  // Every TMDB tool needs the token; short-circuit with one clear message
  // instead of letting each call round-trip to a 401.
  const requireTmdb = <T extends Record<string, unknown>>(
    fn: () => Promise<T>,
    getMeta?: () => Record<string, unknown> | undefined,
  ) => requireConfigured(tmdb, fn, undefined, getMeta);
  // For a cached client method: wires up staleness tracking automatically
  // instead of the caller hand-assembling trackStale()/onStale/meta — see
  // requireConfiguredCached's own doc comment for why.
  const requireTmdbCached = <T extends Record<string, unknown>>(
    fn: (onStale: () => void) => Promise<T>,
  ) => requireConfiguredCached(tmdb, fn);
  const region = regionSchema(config.tmdbRegion);

  registerSearchTools(server, tmdb, requireTmdb, requireTmdbCached, region);
  registerDetailsTools(server, tmdb, omdb, requireTmdb, requireTmdbCached, region);
  registerDiscoverTools(server, tmdb, requireTmdb, requireTmdbCached);
  registerLookupTools(server, tmdb, requireTmdbCached, region);
}
