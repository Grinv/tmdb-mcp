# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add the `recommend_similar` MCP prompt, which plans a search for titles similar to one the user liked via `get_similar`/recommendations/discover instead of the model's own knowledge ([2d85f67](https://github.com/Grinv/tmdb-mcp/commit/2d85f67)).

### Fixed

- Tool parameter descriptions naming a region default now reflect the server's actual `TMDB_REGION` instead of always saying `'US'` ([daec76a](https://github.com/Grinv/tmdb-mcp/commit/daec76a)).

## [0.3.2] - 2026-07-18

### Fixed

- `get_watch_providers` now honors the configured `TMDB_REGION` default instead of always falling back to `"US"`, matching `search_movies`/`get_movie`/`get_tv` ([d0ee332](https://github.com/Grinv/tmdb-mcp/commit/d0ee332)).

### Changed

- Sharpen several tool descriptions — disambiguate `get_movie_recommendations`/`get_tv_recommendations` from `get_similar`, and note when to prefer `search_movies`/`search_tv`/`search_people` over `search_multi` ([d0ee332](https://github.com/Grinv/tmdb-mcp/commit/d0ee332)).

## [0.3.1] - 2026-07-18

### Changed

- Raise runtime floor to Node ≥ 20 (was ≥ 18) ([98499fd](https://github.com/Grinv/tmdb-mcp/commit/98499fd)).

### Fixed

- Prevent `RateLimiter` from assuming `Date.now()` is always far from the `0` epoch, which could misfire near epoch ([98499fd](https://github.com/Grinv/tmdb-mcp/commit/98499fd)).

## [0.3.0] - 2026-07-09

### Added

- Add `get_similar` — TMDB's algorithmic "similar titles" for a movie or TV show ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).
- Add `get_reviews` — user reviews for a movie or TV show ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).
- Add `get_collection` — a movie franchise/collection and all its parts in release order ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).
- Add `collection` and `origin_country` to `get_movie` ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).
- Add `next_episode_to_air`/`last_episode_to_air`, a `seasons` summary, `homepage` and `type` to `get_tv` ([875ebbf](https://github.com/Grinv/tmdb-mcp/commit/875ebbf)).

### Fixed

- Scope `get_watch_providers`' cache key by region — it previously returned another region's cached result ([cb32e76](https://github.com/Grinv/tmdb-mcp/commit/cb32e76)).

## [0.2.0] - 2026-07-09

### Added

- Support the MCP logging capability, mirroring stderr log lines to the client as `notifications/message` ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).
- Publish to the MCP Registry (npm package, `environmentVariables`) via `mcp-publisher` ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).

### Changed

- Share one in-flight fetch across concurrent callers in `TtlCache` ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).

### Fixed

- Prevent `dist/index.js` from crashing standalone (`ERR_MODULE_NOT_FOUND`) by inlining the SDK/`zod` instead of leaving them external ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).
- Treat unfilled `.mcpb` optional fields as unset instead of the literal `${user_config.x}` string ([e7333f5](https://github.com/Grinv/tmdb-mcp/commit/e7333f5)).

## [0.1.1] - 2026-06-30

### Added

- Publish to npm (`npx -y tmdb-mcp` now works) via Trusted Publishing (OIDC) on each release ([427f4a6](https://github.com/Grinv/tmdb-mcp/commit/427f4a6)).

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
