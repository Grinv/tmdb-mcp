# Client configuration

This is a standard stdio MCP server. After `npm ci && npm run build`, point any
MCP client at `node /ABS/PATH/tmdb-mcp/dist/index.js`. Replace `/ABS/PATH/tmdb-mcp`
with the absolute path to your clone.

Credentials:

- `TMDB_API_TOKEN` (required) — TMDB v4 "Read Access Token"
  (<https://www.themoviedb.org/settings/api>).
- `OMDB_API_KEY` (optional) — free OMDb key
  (<https://www.omdbapi.com/apikey.aspx>); enables IMDb/RT/Metacritic ratings.

> Once published to npm, the command becomes `npx -y tmdb-mcp` with no path.

## Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "tmdb": {
      "command": "node",
      "args": ["/ABS/PATH/tmdb-mcp/dist/index.js"],
      "env": {
        "TMDB_API_TOKEN": "your-tmdb-v4-read-access-token",
        "OMDB_API_KEY": "your-omdb-key"
      }
    }
  }
}
```

## Cursor / VS Code / Cline / others

Use the same stdio pattern:

- command: `node`
- args: `["/ABS/PATH/tmdb-mcp/dist/index.js"]`
- env: `TMDB_API_TOKEN` (required), `OMDB_API_KEY` (optional).

## Tunables (optional env)

| Var                    | Default                        | Meaning                                            |
| ---------------------- | ------------------------------ | -------------------------------------------------- |
| `TMDB_BASE_URL`        | `https://api.themoviedb.org/3` | TMDB API base URL                                  |
| `OMDB_BASE_URL`        | `https://www.omdbapi.com`      | OMDb API base URL                                  |
| `TMDB_MIN_INTERVAL_MS` | `60`                           | Min spacing between TMDB calls (0 disables)        |
| `OMDB_MIN_INTERVAL_MS` | `0`                            | Min spacing between OMDb calls                     |
| `CACHE_TTL_MS`         | `300000`                       | TTL for cached detail/reference responses          |
| `HTTP_TIMEOUT_MS`      | `15000`                        | Per-request timeout                                |
| `HTTP_RETRIES`         | `2`                            | Retries for transient failures                     |
| `LOG_LEVEL`            | `info`                         | `debug` \| `info` \| `warn` \| `error` \| `silent` |
