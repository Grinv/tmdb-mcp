// TMDB tools by domain: search.ts (name → id resolvers), details.ts (detail
// lookups, incl. OMDb ratings), discover.ts (trending/genres/filtered
// discovery), lookups.ts (per-title extras).
import type { McpServer } from "@modelcontextprotocol/server";
import type { TmdbClient } from "../../clients/tmdb.ts";
import type { OmdbClient } from "../../clients/omdb.ts";
import type { Config } from "../../config.ts";
import { requireConfigured } from "../shared.ts";
import { languageSchema, regionSchema, type TmdbToolDeps } from "./fields.ts";
import { registerSearchTools } from "./search.ts";
import { registerDetailsTools } from "./details.ts";
import { registerDiscoverTools } from "./discover.ts";
import { registerLookupTools } from "./lookups.ts";

export function registerTmdbTools(
  server: McpServer,
  tmdb: TmdbClient,
  omdb: OmdbClient,
  config: Pick<Config, "tmdbRegion" | "tmdbLanguage">,
): void {
  // Every TMDB tool needs the token; fail with one clear message instead of a
  // round-trip to a 401.
  const requireTmdb: TmdbToolDeps["requireTmdb"] = (fn, signal) =>
    requireConfigured(tmdb, fn, undefined, signal);
  const region = regionSchema(config.tmdbRegion);
  const language = languageSchema(config.tmdbLanguage);

  const deps: TmdbToolDeps = { tmdb, omdb, requireTmdb, region, language };
  registerSearchTools(server, deps);
  registerDetailsTools(server, deps);
  registerDiscoverTools(server, deps);
  registerLookupTools(server, deps);
}
