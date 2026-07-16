# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Raise runtime floor to Node ≥ 20 (was ≥ 18) ([98499fd](https://github.com/Grinv/tmdb-mcp/commit/98499fd)).

### Fixed

- Fix `RateLimiter` assuming `Date.now()` is always far from the `0` epoch, which could misfire near epoch ([98499fd](https://github.com/Grinv/tmdb-mcp/commit/98499fd)).

## [0.3.0] - 2026-07-09

### Added

- Add `get_similar` — TMDB's algorithmic "similar titles" for a movie or TV show ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).
- Add `get_reviews` — user reviews for a movie or TV show ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).
- Add `get_collection` — a movie franchise/collection and all its parts in release order ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).
- Add `collection` and `origin_country` to `get_movie` ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).
- Add `next_episode_to_air`/`last_episode_to_air`, a `seasons` summary, `homepage` and `type` to `get_tv` ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).

### Fixed

- Fix `get_watch_providers` returning another region's cached result by including `region` in the cache key ([cb32e76](https://github.com/Grinv/tmdb-mcp/commit/cb32e76)).

## [0.2.0] - 2026-07-09

### Added

- Add the MCP logging capability — mirrors stderr log lines to the client as `notifications/message` ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).
- Add MCP Registry publishing (npm package, `environmentVariables`) via `mcp-publisher` ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).

### Changed

- Share one in-flight fetch across concurrent callers in `TtlCache` ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).

### Fixed

- Fix `dist/index.js` crashing standalone (`ERR_MODULE_NOT_FOUND`) by inlining the SDK/`zod` instead of leaving them external ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).
- Fix unfilled `.mcpb` optional fields leaking as literal `${user_config.x}` — now treated as unset ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).

## [0.1.1] - 2026-06-30

### Added

- Add npm distribution: `npx -y tmdb-mcp` works, published via Trusted Publishing (OIDC) on each release ([427f4a6](https://github.com/Grinv/tmdb-mcp/commit/427f4a6)).

## [0.1.0] - 2026-06-30

### Added

- Ship the initial release: a TMDB-backed MCP server (search, details, credits, recommendations, trending, genres, ratings) ([98b952f](https://github.com/Grinv/tmdb-mcp/commit/98b952f)).
- Add `discover_movies`/`discover_tv` — structured filtering by genre, date/rating/runtime range, people, companies, keywords, watch providers and certification ([e936cf8](https://github.com/Grinv/tmdb-mcp/commit/e936cf8), [31f74da](https://github.com/Grinv/tmdb-mcp/commit/31f74da)).
- Add `get_watch_providers` — where to stream/rent/buy a movie or show, by region ([e936cf8](https://github.com/Grinv/tmdb-mcp/commit/e936cf8)).
- Add `get_person_credits` — a person's filmography, most popular first ([e936cf8](https://github.com/Grinv/tmdb-mcp/commit/e936cf8)).
- Add `get_videos` — trailers/teasers/clips for a movie or show ([e936cf8](https://github.com/Grinv/tmdb-mcp/commit/e936cf8)).
- Add `find_by_imdb_id` — resolve an IMDb id to TMDB movie/TV/person entities ([e936cf8](https://github.com/Grinv/tmdb-mcp/commit/e936cf8)).
- Add `get_tv_season`/`get_tv_episode` — season overview and single-episode details ([e936cf8](https://github.com/Grinv/tmdb-mcp/commit/e936cf8)).
- Add `search_keywords` — resolve keyword names to ids for the `with_keywords` filter ([31f74da](https://github.com/Grinv/tmdb-mcp/commit/31f74da)).
- Add age/content certifications to `get_movie`/`get_tv` ([51304b2](https://github.com/Grinv/tmdb-mcp/commit/51304b2)).
- Add localization via `TMDB_LANGUAGE`/`TMDB_REGION`, with per-call overrides ([31f74da](https://github.com/Grinv/tmdb-mcp/commit/31f74da)).
- Add OMDb enrichment: IMDb/Rotten Tomatoes/Metacritic ratings folded into `get_movie`/`get_tv`, or standalone via `get_ratings` ([98b952f](https://github.com/Grinv/tmdb-mcp/commit/98b952f)).
- Build on the reusable MCP carcass (`lib/`), with a `.mcpb` manifest and GitHub Actions CI/release ([98b952f](https://github.com/Grinv/tmdb-mcp/commit/98b952f)).
