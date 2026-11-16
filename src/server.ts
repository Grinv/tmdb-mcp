// Server construction and stdio startup. Kept separate from the bin entry
// (index.ts) so tests can import buildServer without triggering startup.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { McpServer, type CacheHint } from "@modelcontextprotocol/server";
import { loadConfig, type Config } from "./config.ts";
import { createLogger, type Logger } from "./lib/logger.ts";
import { TmdbClient } from "./clients/tmdb.ts";
import { OmdbClient } from "./clients/omdb.ts";
import { registerTmdbTools } from "./tools/tmdb/index.ts";
import { registerOmdbTools } from "./tools/omdb.ts";
import { registerPrompts } from "./prompts.ts";
import { VERSION } from "./version.ts";

const INSTRUCTIONS =
  "Query movies, TV shows and people from The Movie Database (TMDB). Typical flow: " +
  "use search_movies / search_tv / search_people (or search_multi when the type is unknown) to " +
  "find an entity and its TMDB id, then get_movie / get_tv / get_person for full details, or " +
  "get_movie_credits / get_tv_credits for cast & crew. get_trending surfaces what's popular now. " +
  "get_movie and get_tv include IMDb/Rotten Tomatoes/Metacritic ratings (via OMDb) by default; " +
  "use the standalone get_ratings only when you have just an IMDb id or a raw title. " +
  "TMDB needs TMDB_API_TOKEN; rating enrichment needs OMDB_API_KEY (tools report clearly when unset).";

// Tool/prompt lists and server identity are fixed at build time (nothing
// registers or unregisters at runtime), so a client on protocol revision
// 2026-07-28 can cache tools/list, prompts/list and server/discover, even in
// a shared proxy ('public'): nothing varies by caller. Only three of the six
// cacheable operations apply; there are no MCP Resources. 2025-era connections
// are unaffected.
const STATIC_CACHE_HINT: CacheHint = { ttlMs: 3_600_000, cacheScope: "public" };

// Cap on array elements plus object members in one tools/call `arguments`
// payload, checked by the SDK before Zod runs. The largest real call
// (discover_movies with every filter, or get_movies' 20 ids) stays under ~30;
// 100 leaves headroom and cheaply rejects a pathological payload as an isError
// result.
export const MAX_TOOL_INPUT_ELEMENTS = 100;

/** Construct a fully-registered MCP server. Shared by start() and tests. */
export function buildServer(config: Config, logger: Logger): McpServer {
  const tmdb = new TmdbClient(config, logger);
  const omdb = new OmdbClient(config, logger);

  const server = new McpServer(
    { name: "tmdb-mcp", title: "TMDB MCP Server", version: VERSION },
    {
      instructions: INSTRUCTIONS,
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      cacheHints: {
        "tools/list": STATIC_CACHE_HINT,
        "prompts/list": STATIC_CACHE_HINT,
        "server/discover": STATIC_CACHE_HINT,
      },
    },
  );

  registerTmdbTools(server, tmdb, omdb, config);
  registerOmdbTools(server, omdb);
  registerPrompts(server);
  return server;
}

/** Load config, build the server, and serve over stdio until terminated.
 *  Protocol revision 2026-07-28 deprecated server→client log notifications
 *  in favor of stderr (SEP-2577): the host reads a spawned stdio server's
 *  stderr, so the logger's stderr output is the only channel. */
export async function start(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const handle = serveStdio(() => buildServer(config, logger));
  logger.info(`tmdb-mcp ${VERSION} ready`);

  const shutdown = (signal: string): void => {
    logger.info(`received ${signal}, shutting down`);
    void handle.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", reason));
  process.on("uncaughtException", (err) => {
    logger.error("uncaught exception", err);
    process.exit(1);
  });
}
