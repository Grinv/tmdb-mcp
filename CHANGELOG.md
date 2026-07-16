# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Raise runtime floor to Node ≥ 20 (was ≥ 18)
  ([98499fd](https://github.com/Grinv/tmdb-mcp/commit/98499fd)).

### Fixed

- Fix `RateLimiter` assuming `Date.now()` is always far from the `0` epoch,
  which could misfire under a clock near epoch
  ([98499fd](https://github.com/Grinv/tmdb-mcp/commit/98499fd)).

## [0.3.0] - 2026-07-09

### Added

- Add `get_similar` — TMDB's algorithmic "similar titles" for a movie or TV
  show (distinct from the editorial `get_movie_recommendations`)
  ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).
- Add `get_reviews` — user reviews (author, their rating, review text) for a
  movie or TV show ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).
- Add `get_collection` — a movie franchise/collection and all its parts in
  release order ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).
- Add `collection` (the franchise a film belongs to — feed its id to
  `get_collection`) and `origin_country` to `get_movie`
  ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).
- Add `next_episode_to_air` / `last_episode_to_air`, a per-season `seasons`
  summary, `homepage` and `type` to `get_tv`
  ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).

### Fixed

- Fix `get_watch_providers` returning another region's cached result for the
  same title by including `region` in the cache key
  ([cb32e76](https://github.com/Grinv/tmdb-mcp/commit/cb32e76)).

## [0.2.0] - 2026-07-09

### Added

- Add the MCP logging capability: mirrors stderr log lines to the client as
  `notifications/message`, credential-redacted and gated by `LOG_LEVEL`
  ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).
- Add MCP Registry publishing: `package.json` gains an `mcpName` marker,
  `server.json` lists the npm package with an `environmentVariables` block,
  and the release workflow publishes to the registry via `mcp-publisher`
  ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).

### Changed

- Share one in-flight fetch across concurrent callers in `TtlCache`, instead
  of each caller triggering its own upstream request
  ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).

### Fixed

- Fix `dist/index.js` crashing standalone (`ERR_MODULE_NOT_FOUND`) under
  `.mcpb`/npx by inlining `@modelcontextprotocol/sdk` and `zod` instead of
  leaving them external
  ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).
- Fix unfilled `.mcpb` optional fields leaking as literal `${user_config.x}` —
  `loadConfig` now treats unsubstituted `${...}` placeholders as unset
  ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).

## [0.1.1] - 2026-06-30

### Added

- Add npm distribution: `npx -y tmdb-mcp` works; the release workflow
  publishes to npm via Trusted Publishing (OIDC) with provenance on each
  tagged release ([427f4a6](https://github.com/Grinv/tmdb-mcp/commit/427f4a6)).

## [0.1.0] - 2026-06-30

### Added

- Ship the initial release: a TMDB-backed MCP server with tools:
  `search_movies`, `search_tv`, `search_multi`, `search_people`, `get_movie`,
  `get_tv`, `get_person`, `get_movie_credits`, `get_tv_credits`,
  `get_movie_recommendations`, `get_tv_recommendations`, `get_trending`,
  `get_movie_genres`, `get_tv_genres`, and `get_ratings`
  ([98b952f](https://github.com/Grinv/tmdb-mcp/commit/98b952f)).
- Add `discover_movies` / `discover_tv` — structured filtering: genres
  (include/exclude), year or release-date range, rating range, vote count,
  runtime range, original language, cast/crew/people, companies, keywords,
  watch providers (+ region), networks (TV), and certification (+ country)
  ([e936cf8](https://github.com/Grinv/tmdb-mcp/commit/e936cf8),
  [31f74da](https://github.com/Grinv/tmdb-mcp/commit/31f74da)).
- Add `get_watch_providers` — where to stream/rent/buy a movie or show, by
  region (JustWatch data via TMDB)
  ([e936cf8](https://github.com/Grinv/tmdb-mcp/commit/e936cf8)).
- Add `get_person_credits` — a person's filmography (cast roles and crew
  jobs), most popular first
  ([e936cf8](https://github.com/Grinv/tmdb-mcp/commit/e936cf8)).
- Add `get_videos` — trailers/teasers/clips for a movie or show (YouTube
  watch URLs) ([e936cf8](https://github.com/Grinv/tmdb-mcp/commit/e936cf8)).
- Add `find_by_imdb_id` — resolve an IMDb id to TMDB movie/TV/person entities
  ([e936cf8](https://github.com/Grinv/tmdb-mcp/commit/e936cf8)).
- Add `get_tv_season` / `get_tv_episode` — season overview + episode list,
  and single-episode details (guest stars, director/writer)
  ([e936cf8](https://github.com/Grinv/tmdb-mcp/commit/e936cf8)).
- Add `search_keywords` — resolve keyword names to ids for the
  `with_keywords` filter
  ([31f74da](https://github.com/Grinv/tmdb-mcp/commit/31f74da)).
- Add age/content certifications to `get_movie` / `get_tv`: a region-specific
  `certification` (e.g. "PG-13", "TV-MA") plus a `certifications` map of all
  countries ([51304b2](https://github.com/Grinv/tmdb-mcp/commit/51304b2)).
- Add localization: `TMDB_LANGUAGE` (default `en-US`) and `TMDB_REGION`
  (default `US`) apply to every request, with an optional per-call `language`
  override and a `region` on the detail/search tools
  ([31f74da](https://github.com/Grinv/tmdb-mcp/commit/31f74da)).
- Add OMDb enrichment: `get_movie`/`get_tv` fold IMDb/Rotten Tomatoes/
  Metacritic ratings into their result (toggle with `include_ratings`);
  `get_ratings` looks them up standalone by IMDb id or title
  ([98b952f](https://github.com/Grinv/tmdb-mcp/commit/98b952f)).
- Build on the reusable MCP carcass (`lib/`: http, rateLimit, cache, errors,
  logger, result) with a tsup/tsc build, `node:test` setup, `.mcpb` manifest,
  `server.json`, live `check:api` health checks, and GitHub Actions CI/release
  ([98b952f](https://github.com/Grinv/tmdb-mcp/commit/98b952f)).
