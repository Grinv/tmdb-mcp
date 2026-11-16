# Client configuration

This is a standard stdio MCP server, published on npm as `tmdb-mcp`. Point any
MCP client at it via `npx -y tmdb-mcp`; no clone or local build is needed.

Credentials:

- `TMDB_API_TOKEN` (required): TMDB v4 "Read Access Token"
  (<https://www.themoviedb.org/settings/api>).
- `OMDB_API_KEY` (optional): free OMDb key
  (<https://www.omdbapi.com/apikey.aspx>); enables IMDb/RT/Metacritic ratings.

## Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "tmdb": {
      "command": "npx",
      "args": ["-y", "tmdb-mcp"],
      "env": {
        "TMDB_API_TOKEN": "your-tmdb-v4-read-access-token",
        "OMDB_API_KEY": "your-omdb-key",
        "TMDB_LANGUAGE": "en-US",
        "TMDB_REGION": "US"
      }
    }
  }
}
```

## Cursor / VS Code / Cline / others

Use the same stdio pattern:

- command: `npx`
- args: `["-y", "tmdb-mcp"]`
- env: `TMDB_API_TOKEN` (required), `OMDB_API_KEY` (optional).

## From source

To work against a local clone (e.g. to test an unreleased change):
`git clone`, then `npm ci && npm run build`, and point the client at
`"command": "node"`, `"args": ["/ABS/PATH/tmdb-mcp/dist/index.js"]` (replace
`/ABS/PATH/tmdb-mcp` with your clone's absolute path) with the same `env` as
above.

## Stale-data signal

If TMDB/OMDb is briefly unreachable and a cached (possibly expired) response
is served instead of failing the call, the tool result carries
`_meta: {"io.github.Grinv.tmdb-mcp/stale": {"age_seconds": N}}` (how old the data is) alongside the normal `structuredContent`.
`"io.github.Grinv.tmdb-mcp/partial": true` likewise flags a result with a part missing.
The data itself is unchanged; only `_meta` marks it as possibly outdated. A
client that cares can check for this key, and one that doesn't sees the same
result as always.

## Tunables (optional env)

| Var                    | Default                        | Meaning                                                                     |
| ---------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `TMDB_LANGUAGE`        | `en-US`                        | Default response language, e.g. `ru-RU` (localizes titles/overviews/genres) |
| `TMDB_REGION`          | `US`                           | Default ISO-3166-1 country for region-specific results (certifications)     |
| `TMDB_BASE_URL`        | `https://api.themoviedb.org/3` | TMDB API base URL                                                           |
| `OMDB_BASE_URL`        | `https://www.omdbapi.com`      | OMDb API base URL                                                           |
| `TMDB_MIN_INTERVAL_MS` | `60`                           | Min spacing between TMDB calls (0 disables)                                 |
| `OMDB_MIN_INTERVAL_MS` | `0`                            | Min spacing between OMDb calls                                              |
| `CACHE_TTL_MS`         | `300000`                       | TTL for cached detail/reference responses                                   |
| `CACHE_MAX_STALE_MS`   | `86400000`                     | Max age past the TTL at which a cached response is served during an outage  |
| `HTTP_TIMEOUT_MS`      | `15000`                        | Per-request timeout                                                         |
| `HTTP_RETRIES`         | `2`                            | Retries for transient failures                                              |
| `LOG_LEVEL`            | `info`                         | `debug` \| `info` \| `warn` \| `error` \| `silent`                          |
