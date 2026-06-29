# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `discover_movies` / `discover_tv` — structured filtering (genres, year, rating
  range, vote count, runtime, language, sort) instead of a title query.
- `get_watch_providers` — where to stream/rent/buy a movie or show, by region
  (JustWatch data via TMDB).
- `get_person_credits` — a person's filmography (cast roles and crew jobs),
  most popular first.
- `get_videos` — trailers/teasers/clips for a movie or show (YouTube watch URLs).
- `find_by_imdb_id` — resolve an IMDb id to TMDB movie/TV/person entities.
- `get_tv_season` / `get_tv_episode` — season overview + episode list, and
  single-episode details (guest stars, director/writer).

## [0.1.0]

### Added

- Initial release. TMDB-backed MCP server with tools: `search_movies`,
  `search_tv`, `search_multi`, `search_people`, `get_movie`, `get_tv`,
  `get_person`, `get_movie_credits`, `get_tv_credits`,
  `get_movie_recommendations`, `get_tv_recommendations`, `get_trending`,
  `get_movie_genres`, `get_tv_genres`, and `get_ratings`.
- OMDb enrichment: `get_movie`/`get_tv` fold IMDb/Rotten Tomatoes/Metacritic
  ratings into their result via the `imdb_id` TMDB returns (toggle with
  `include_ratings`); `get_ratings` looks them up standalone by IMDb id or title.
- Built on the reusable MCP carcass (`lib/`: http, rateLimit, cache, errors,
  logger, result) with tsup/tsc build, `node:test` setup, `.mcpb` manifest,
  `server.json`, live `check:api` health checks, and GitHub Actions CI/release.
