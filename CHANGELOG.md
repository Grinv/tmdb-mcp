# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-09

### Added

- Add `get_similar` — TMDB's algorithmic "similar titles" for a movie or TV
  show (distinct from the editorial `get_movie_recommendations`).
- Add `get_reviews` — user reviews (author, their rating, review text) for a
  movie or TV show.
- Add `get_collection` — a movie franchise/collection and all its parts in
  release order.
- Add `collection` (the franchise a film belongs to — feed its id to
  `get_collection`) and `origin_country` to `get_movie`.
- Add `next_episode_to_air` / `last_episode_to_air`, a per-season `seasons`
  summary, `homepage` and `type` to `get_tv`.

### Fixed

- Fix `get_watch_providers` returning another region's cached result for the
  same title by including `region` in the cache key.

### Internal

- Collapse the movie/tv client method pairs (recommendations, similar, genres,
  discover, watch providers, videos) into media-typed methods.
- Extract a `tmdbCheck()` helper in `check:api`.
- Raise test coverage (`clients/tmdb` 76% → 87%, overall ~90%).

## [0.2.0] - 2026-07-09

### Added

- Add the MCP logging capability: mirrors stderr log lines to the client as
  `notifications/message`, credential-redacted and gated by `LOG_LEVEL`.
- Add MCP Registry publishing: `package.json` gains an `mcpName` marker,
  `server.json` lists the npm package with an `environmentVariables` block,
  and the release workflow publishes to the registry via `mcp-publisher`.

### Fixed

- Fix `dist/index.js` crashing standalone (`ERR_MODULE_NOT_FOUND`) under
  `.mcpb`/npx by inlining `@modelcontextprotocol/sdk` and `zod` instead of
  leaving them external.
- Fix unfilled `.mcpb` optional fields leaking as literal `${user_config.x}` —
  `loadConfig` now treats unsubstituted `${...}` placeholders as unset.

### Internal

- Add an e2e smoke test that drives the built bundle over stdio (no
  `node_modules`) and asserts handshake + tool registration.
- Share one in-flight fetch across concurrent callers in `TtlCache`.
- Add version-sync tooling (`scripts/sync-version.mjs` + npm `version` hook +
  `version.test.ts` guards) and a local coverage gate in `test:coverage`.
- Pin `npm@11.18.0` in the release workflow (npm 12 breaks `--provenance`) and
  source release notes from this CHANGELOG.

## [0.1.1]

### Added

- Add npm distribution: `npx -y tmdb-mcp` works; the release workflow
  publishes to npm via Trusted Publishing (OIDC) with provenance on each
  tagged release.

### Documentation

- Add a README **Install** section (npx / `.mcpb` / from source), npm/CI/
  license badges, and required-vs-optional annotations on the env config
  snippet.

## [0.1.0]

### Added

- Ship the initial release: a TMDB-backed MCP server with tools:
  `search_movies`, `search_tv`, `search_multi`, `search_people`, `get_movie`,
  `get_tv`, `get_person`, `get_movie_credits`, `get_tv_credits`,
  `get_movie_recommendations`, `get_tv_recommendations`, `get_trending`,
  `get_movie_genres`, `get_tv_genres`, and `get_ratings`.
- Add `discover_movies` / `discover_tv` — structured filtering: genres
  (include/exclude), year or release-date range, rating range, vote count,
  runtime range, original language, cast/crew/people, companies, keywords,
  watch providers (+ region), networks (TV), and certification (+ country).
- Add `get_watch_providers` — where to stream/rent/buy a movie or show, by
  region (JustWatch data via TMDB).
- Add `get_person_credits` — a person's filmography (cast roles and crew
  jobs), most popular first.
- Add `get_videos` — trailers/teasers/clips for a movie or show (YouTube
  watch URLs).
- Add `find_by_imdb_id` — resolve an IMDb id to TMDB movie/TV/person entities.
- Add `get_tv_season` / `get_tv_episode` — season overview + episode list,
  and single-episode details (guest stars, director/writer).
- Add `search_keywords` — resolve keyword names to ids for the
  `with_keywords` filter.
- Add age/content certifications to `get_movie` / `get_tv`: a region-specific
  `certification` (e.g. "PG-13", "TV-MA") plus a `certifications` map of all
  countries.
- Add localization: `TMDB_LANGUAGE` (default `en-US`) and `TMDB_REGION`
  (default `US`) apply to every request, with an optional per-call `language`
  override and a `region` on the detail/search tools.
- Add OMDb enrichment: `get_movie`/`get_tv` fold IMDb/Rotten Tomatoes/
  Metacritic ratings into their result (toggle with `include_ratings`);
  `get_ratings` looks them up standalone by IMDb id or title.
- Build on the reusable MCP carcass (`lib/`: http, rateLimit, cache, errors,
  logger, result) with a tsup/tsc build, `node:test` setup, `.mcpb` manifest,
  `server.json`, live `check:api` health checks, and GitHub Actions CI/release.
