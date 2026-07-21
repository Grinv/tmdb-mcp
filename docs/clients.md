# Client configuration

This is a standard stdio MCP server, published on npm as `tmdb-mcp`. Point any
MCP client at it via `npx -y tmdb-mcp` — no clone or local build needed.

Credentials:

- `TMDB_API_TOKEN` (required) — TMDB v4 "Read Access Token"
  (<https://www.themoviedb.org/settings/api>).
- `OMDB_API_KEY` (optional) — free OMDb key
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

Prefer working against a local clone (e.g. to test an unreleased change):
`git clone`, then `npm ci && npm run build`, and point the client at
`"command": "node"`, `"args": ["/ABS/PATH/tmdb-mcp/dist/index.js"]` (replace
`/ABS/PATH/tmdb-mcp` with your clone's absolute path) with the same `env` as
above.

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
| `HTTP_TIMEOUT_MS`      | `15000`                        | Per-request timeout                                                         |
| `HTTP_RETRIES`         | `2`                            | Retries for transient failures                                              |
| `LOG_LEVEL`            | `info`                         | `debug` \| `info` \| `warn` \| `error` \| `silent`                          |
