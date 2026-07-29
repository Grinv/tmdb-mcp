# Security

`tmdb-mcp` is **read-only** and talks to **TMDB and OMDb's own APIs only**.

## What it does and doesn't do

- **Never writes anything.** Every tool is annotated `readOnlyHint: true`
  (`READ_ONLY` in `src/tools/shared.ts`); there is no code path that sends
  anything to TMDB or OMDb beyond a GET request.
- **Only two hosts, both fixed at startup.** Requests go to the configured
  `TMDB_BASE_URL` (default `api.themoviedb.org`) or `OMDB_BASE_URL` (default
  `www.omdbapi.com`) — there is no tool parameter that lets a caller redirect
  a request to an arbitrary host.
- **Your credentials stay yours.** `TMDB_API_TOKEN` is sent only as an
  `Authorization: Bearer` header; `OMDB_API_KEY` is sent only as an `apikey`
  query parameter. Both are read once from the environment at startup, never
  written to disk, cached, or included in a tool result. Logging redacts
  `Bearer` tokens and any `apikey`/`access_token`/`refresh_token`/
  `client_secret`/`client_id` value before a line reaches stderr (see
  `src/lib/errors.ts`'s `redact`, applied to every log line in
  `src/lib/logger.ts`) — including the full request URL an HTTP retry logs at
  debug level, which is exactly where an unredacted OMDb `apikey` would
  otherwise leak under `LOG_LEVEL=debug`.
- **No data kept between requests beyond a small TTL cache**
  (`CACHE_TTL_MS`, default 5 minutes) of upstream responses, held in memory
  only — nothing is written to disk, and the cache is gone when the process
  exits.
- **Typed, validated inputs.** Every tool's parameters are a `.strict()` Zod
  schema; malformed or unrecognized input is rejected before any request is
  made.

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/Grinv/tmdb-mcp/issues) or, for
anything sensitive, email the address on the maintainer's GitHub profile
(<https://github.com/Grinv>). Please don't file public issues for
vulnerabilities that could affect other users before there's a fix available.

Not affiliated with TMDB or OMDb. "TMDB" and "The Movie Database" are
trademarks of TMDB.
