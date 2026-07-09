# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Three new tools: `get_similar`, `get_reviews`, `get_collection`.** `get_similar`
  returns TMDB's algorithmic "similar titles" for a movie or TV show (distinct from
  the editorial `get_movie_recommendations`); `get_reviews` returns user reviews
  (author, their rating, the review text) for a movie or TV show; `get_collection`
  returns a movie franchise/collection and all its parts in release order.
- **Richer detail lookups (no extra requests).** `get_movie` now surfaces
  `collection` (the franchise a film belongs to — feed its id to `get_collection`)
  and `origin_country`. `get_tv` now surfaces `next_episode_to_air` /
  `last_episode_to_air` (when the next / most-recent episode airs), a per-season
  `seasons` summary, `homepage` and `type` — all from the payload already fetched.

### Fixed

- **`get_watch_providers` could return another region's providers.** The result
  is region-specific but was cached under an id-only key, so a second call for
  the same title with a different `region` served the first region's data. The
  region is now part of the cache key.

### Internal

- DRY: collapsed the movie/tv client method pairs (recommendations, similar,
  genres, discover, watch providers, videos) into media-typed methods, and
  extracted a `tmdbCheck()` helper in `check:api`. Raised test coverage
  (`clients/tmdb` 76% → 87%, overall ~90%).

## [0.2.0] - 2026-07-09

### Added

- **MCP logging capability.** The server declares the `logging` capability and
  mirrors its stderr log lines to the connected client as `notifications/message`
  (best-effort, credential-redacted, gated by `LOG_LEVEL`, and only after the
  client's `initialized`).
- **MCP Registry publishing.** `package.json` gains an `mcpName` marker and
  `server.json` now lists the npm package plus a self-describing
  `environmentVariables` block on both packages; the release workflow publishes
  to the official MCP Registry via `mcp-publisher` (GitHub OIDC), injecting the
  packed `.mcpb`'s `fileSha256`.

### Fixed

- **The built bundle was not self-contained.** tsup left `@modelcontextprotocol/sdk`
  and `zod` external, so `dist/index.js` could crash standalone with
  `ERR_MODULE_NOT_FOUND` (`.mcpb`/npx). Added `noExternal` to inline runtime deps,
  now minified with no sourcemap; a new `bundle.test.ts` guards it.
- **Unfilled `.mcpb` optional fields leaked as literal `${user_config.x}`.**
  `loadConfig` now treats unsubstituted `${...}` placeholders as unset.

### Internal

- **e2e smoke test** driving the real built bundle over stdio (no `node_modules`),
  asserting handshake + all tools register. `TtlCache` shares one in-flight fetch
  across concurrent callers. Version-sync tooling (`scripts/sync-version.mjs` + npm
  `version` hook + `version.test.ts` guards). Local coverage gate in
  `test:coverage`. Release workflow pins `npm@11.18.0` (npm 12 breaks
  `--provenance`) and sources release notes from this CHANGELOG.

## [0.1.1]

### Added

- npm distribution: the package is on npm, so `npx -y tmdb-mcp` works. The
  release workflow now publishes to npm via Trusted Publishing (OIDC) with
  provenance on each tagged release.

### Documentation

- README: an **Install** section (npx / `.mcpb` / from source), npm/CI/license
  badges, and required-vs-optional annotations on the env config snippet.

## [0.1.0]

### Added

- Initial release. TMDB-backed MCP server with tools: `search_movies`,
  `search_tv`, `search_multi`, `search_people`, `get_movie`, `get_tv`,
  `get_person`, `get_movie_credits`, `get_tv_credits`,
  `get_movie_recommendations`, `get_tv_recommendations`, `get_trending`,
  `get_movie_genres`, `get_tv_genres`, and `get_ratings`.
- `discover_movies` / `discover_tv` — structured filtering: genres
  (include/exclude), year or release-date range, rating range, vote count,
  runtime range, original language, cast/crew/people, companies, keywords,
  watch providers (+ region), networks (TV), and certification (+ country).
- `get_watch_providers` — where to stream/rent/buy a movie or show, by region
  (JustWatch data via TMDB).
- `get_person_credits` — a person's filmography (cast roles and crew jobs),
  most popular first.
- `get_videos` — trailers/teasers/clips for a movie or show (YouTube watch URLs).
- `find_by_imdb_id` — resolve an IMDb id to TMDB movie/TV/person entities.
- `get_tv_season` / `get_tv_episode` — season overview + episode list, and
  single-episode details (guest stars, director/writer).
- `search_keywords` — resolve keyword names to ids for the `with_keywords` filter.
- Age/content certifications in `get_movie` / `get_tv`: a region-specific
  `certification` (e.g. "PG-13", "TV-MA") plus a `certifications` map of all
  countries, from TMDB `release_dates` / `content_ratings`.
- Localization: `TMDB_LANGUAGE` (default `en-US`) and `TMDB_REGION` (default
  `US`) applied to every request, with an optional per-call `language` override
  and a `region` on the detail/search tools.
- OMDb enrichment: `get_movie`/`get_tv` fold IMDb/Rotten Tomatoes/Metacritic
  ratings into their result via the `imdb_id` TMDB returns (toggle with
  `include_ratings`); `get_ratings` looks them up standalone by IMDb id or title.
- Built on the reusable MCP carcass (`lib/`: http, rateLimit, cache, errors,
  logger, result) with tsup/tsc build, `node:test` setup, `.mcpb` manifest,
  `server.json`, live `check:api` health checks, and GitHub Actions CI/release.
