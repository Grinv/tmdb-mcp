# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
