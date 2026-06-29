// Server construction and stdio startup. Kept separate from the bin entry
// (index.ts) so tests can import buildServer without triggering startup.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type Config } from "./config.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { TmdbClient } from "./clients/tmdb.js";
import { OmdbClient } from "./clients/omdb.js";
import { registerTmdbTools } from "./tools/tmdb.js";
import { registerOmdbTools } from "./tools/omdb.js";
import { VERSION } from "./version.js";

const INSTRUCTIONS =
  "Query movies, TV shows and people from The Movie Database (TMDB). Typical flow: " +
  "use search_movies / search_tv / search_people (or search_multi when the type is unknown) to " +
  "find an entity and its TMDB id, then get_movie / get_tv / get_person for full details, or " +
  "get_movie_credits / get_tv_credits for cast & crew. get_trending surfaces what's popular now. " +
  "get_movie and get_tv include IMDb/Rotten Tomatoes/Metacritic ratings (via OMDb) by default; " +
  "use the standalone get_ratings only when you have just an IMDb id or a raw title. " +
  "TMDB needs TMDB_API_TOKEN; rating enrichment needs OMDB_API_KEY (tools report clearly when unset).";

/** Construct a fully-registered MCP server. Shared by start() and tests. */
export function buildServer(config: Config, logger: Logger): McpServer {
  const tmdb = new TmdbClient(config, logger);
  const omdb = new OmdbClient(config, logger);

  const server = new McpServer(
    { name: "tmdb-mcp", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerTmdbTools(server, tmdb, omdb);
  registerOmdbTools(server, omdb);
  return server;
}

/** Load config, build the server, and serve over stdio until terminated. */
export async function start(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const server = buildServer(config, logger);

  await server.connect(new StdioServerTransport());
  logger.info(`tmdb-mcp ${VERSION} ready`);

  const shutdown = (signal: string): void => {
    logger.info(`received ${signal}, shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", reason));
  process.on("uncaughtException", (err) => {
    logger.error("uncaught exception", err);
    process.exit(1);
  });
}
