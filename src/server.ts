// Server construction and stdio startup. Kept separate from the bin entry
// (index.ts) so tests can import buildServer without triggering startup.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type Config } from "./config.js";
import { createLogger, type Logger, type LogLevel, type LogSink } from "./lib/logger.js";
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
    // Declare the logging capability so the SDK registers `logging/setLevel`
    // and lets us push `notifications/message` to the client (see start()).
    { capabilities: { logging: {} }, instructions: INSTRUCTIONS },
  );

  registerTmdbTools(server, tmdb, omdb, config);
  registerOmdbTools(server, omdb);
  return server;
}

// Internal levels → MCP (syslog-style) levels for notifications/message.
const MCP_LOG_LEVELS = {
  debug: "debug",
  info: "info",
  warn: "warning",
  error: "error",
} as const satisfies Record<Exclude<LogLevel, "silent">, string>;

/** A {@link LogSink} that mirrors each log line onto the MCP client as a
 *  `notifications/message`. Best-effort: sends are dropped silently when there
 *  is no transport yet, when the client filtered the level via `logging/setLevel`,
 *  or after disconnect — logging must never break the server. */
export function mcpLoggingSink(server: McpServer): LogSink {
  return (level, message) => {
    void server.server
      .sendLoggingMessage({
        level: MCP_LOG_LEVELS[level],
        logger: "tmdb-mcp",
        data: message,
      })
      .catch(() => {});
  };
}

/** Mirror logs to the client, but ONLY after the initialize handshake completes.
 *  Sending a `notifications/message` before `initialized` violates the MCP
 *  lifecycle, and strict clients (e.g. Claude Desktop) drop the connection — so
 *  `ref.sink` stays unset (stderr-only) until then. Pass the same holder the
 *  logger reads from. */
export function activateClientLoggingOnInitialize(
  server: McpServer,
  ref: { sink?: LogSink },
): void {
  const priorOnInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    priorOnInitialized?.();
    ref.sink = mcpLoggingSink(server);
  };
}

/** Load config, build the server, and serve over stdio until terminated. */
export async function start(): Promise<void> {
  const config = loadConfig();

  // Forward-ref via a holder: the logger is needed to build the server, but the
  // sink needs the server, so we fill it in once the server exists — and only
  // once the client has initialized (see activateClientLoggingOnInitialize).
  const ref: { sink?: LogSink } = {};
  const logger = createLogger(config.logLevel, (level, message) => ref.sink?.(level, message));
  const server = buildServer(config, logger);
  activateClientLoggingOnInitialize(server, ref);

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
