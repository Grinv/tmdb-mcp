# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add `get_movies`/`get_tv_shows`: a compact card (title/name, year, genres, vote average, opt-in ratings) for 1-20 ids in one call, instead of one `get_movie`/`get_tv` call per title.
- Add `search_companies`, resolving a production company name (e.g. "A24") to the id `with_companies` needs.
- Add `department` and `limit` params to `get_person_credits`, so a prolific multi-hyphenate's filmography in one role isn't crowded out by their other credits or the default 25-credit cap.
- Add `with_type`/`with_status` to `discover_tv` (e.g. `with_type: "Miniseries"`), and `number_of_seasons`/`number_of_episodes` to `get_tv_shows`' card.
- Add `certification`/`certification_country` to `discover_tv` (e.g. `certification: "TV-Y7"`) — verified live against the real API, though TMDB's own docs only list this for movies.

### Changed

- Sharpen several tool/prompt descriptions per a TDQS audit (`get_movie`/`get_tv` now name `get_movies`/`get_tv_shows`; `get_trending` discloses per-row `media_type`; genre tools point at `discover_*`). `recommend_similar` now fetches its shortlist's ratings via `get_movies`/`get_tv_shows` instead of one call per title.
- Cross-reference `get_person_credits` (no genre filter) with `discover_movies`'s `with_crew`/`with_cast`/`with_people` + `with_genres` — the right combination for "this person's work in one genre".
- Disclose `get_movie`/`get_tv`/`get_ratings`' previously-undocumented `awards` and `ratings.rated` fields (both from OMDb), and clarify `awards` isn't Oscar-specific.
- Document `certification`'s real edge cases (case-sensitive for movies, silently disabled by an unrecognized country, no fallback to another country unlike `get_movie`/`get_tv`) and that `discover_tv` ignores cast/crew/person filters entirely — all verified live.

### Fixed

- Filter `get_similar` results down to titles sharing at least half the source's genres, since a broad genre (e.g. "Drama") could surface unrelated titles from across TMDB's catalog.
- Fix `get_person_credits` capping crew by row count instead of distinct title — a multi-hyphenate's own films (2+ rows each) could get pushed out of the cap entirely.

## [0.7.1] - 2026-07-22

### Fixed

- Cap the combined episode count across all seasons at 500 in `get_tv`'s `expand_episodes`, since a 30+ season show (e.g. long-running sitcoms) could still blow past a usable response size even with each season's own 50-episode cap ([c74a261](https://github.com/Grinv/tmdb-mcp/commit/c74a261)).
- Widen `get_person_credits`' self-appearance filter to also exclude `Himself`/`Herself`-credited cast entries, not just `Self`-prefixed ones ([c74a261](https://github.com/Grinv/tmdb-mcp/commit/c74a261)).

## [0.7.0] - 2026-07-22

### Added

- Surface `_meta: {"tmdb-mcp/stale": true}` on a tool result when the upstream (TMDB/OMDb) was down and the response was served from a stale cache entry, so a caller can tell degraded data from a fresh answer instead of it looking identical.

### Fixed

- Fix every tool silently dropping unknown/misspelled parameters (e.g. a typo'd filter name in `discover_movies`/`discover_tv`) instead of raising a validation error — all `inputSchema`s are now `.strict()`.
- Fix `get_tv`'s `expand_episodes` failing outright on shows with more than 20 seasons (e.g. long-running sitcoms) by chunking the bulk season request under TMDB's 20-remote-call `append_to_response` limit.
- Cap a season's episode list (`get_tv_season`, `get_tv`'s `seasons_detail`) at 50 so a "Specials" season with hundreds of bonus clips can't blow past a usable response size; `episode_count` still reports the true total.
- Fix `get_person_credits` burying an actor's actual film/TV roles under talk-show guest spots and repeat same-show appearances — "Self"-credited cast entries are now excluded and same-title duplicates deduped before ranking.
- Reject `discover_movies`/`discover_tv` calls where `certification`/`with_watch_providers` are set without their required `certification_country`/`watch_region` pair, and where `min_rating` exceeds `max_rating` — TMDB previously ignored these incomplete filters without any error.
- Reject a `page` above TMDB's hard cap of 500 up front instead of surfacing TMDB's raw error.

## [0.6.0] - 2026-07-21

### Added

- Add `outputSchema`/`structuredContent` (MCP SEP-2106) to every tool, describing its exact return shape so clients can validate and consume it as typed data instead of parsing the text-JSON mirror.

### Changed

- Fix `get_movie_recommendations`/`get_tv_recommendations`/`get_similar` descriptions implying `get_similar` gives thematically tighter results than recommendations — in practice TMDB's `/similar` (genre/keyword overlap) is the blunter, noisier heuristic, while `/recommendations` (co-viewing data) is usually more thematically relevant. Descriptions now point the calling model at recommendations first.
- The `recommend_similar` prompt now tells the model to weigh `get_movie_recommendations` as the stronger signal and use `get_similar` only to fill gaps, matching the description fix above.
- Migrate to MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) and adopt protocol revision 2026-07-28.

### Fixed

- Fix several `string | null` fields (`imdb_id`, `status`, `known_for_department`, season/episode `name`/`air_date`, and others across movie/TV/person/OMDb results) leaking an empty string instead of `null` when TMDB/OMDb sent `""` rather than omitting the field or sending `null`.
- An invalid environment variable (e.g. a typo'd `LOG_LEVEL`, a malformed `TMDB_REGION`) now fails startup with a readable message naming the field and constraint, instead of a raw ZodError stack.

### Removed

- Drop MCP log mirroring (`notifications/message`, `logging/setLevel`) — deprecated for stdio servers as of protocol revision 2026-07-28 (SEP-2577) in favor of stderr, which any MCP host spawning this server as a child process already reads. Logs are stderr-only now.

## [0.5.1] - 2026-07-20

### Fixed

- Fix `search_people` mis-shaping every result as a TV show (`media_type: "tv"`, wrong fields) instead of a person — TMDB's `/search/person` endpoint, unlike `/search/multi`, never sends `media_type`.

### Changed

- Sharpen `get_person_credits`, `get_watch_providers`, `search_multi`, `get_person` and the shared pagination parameter's descriptions: disclose that crew credits lack `vote_average` (unlike cast credits), the `available:false`/`available_regions` fallback for an unlisted region, cross-references between the search tools, and TMDB's 20-result page size.

## [0.5.0] - 2026-07-20

### Added

- Add `expand_episodes` to `get_tv`, fetching every season's full episode list (`seasons_detail`) in one extra request instead of calling `get_tv_season` once per season.

## [0.4.1] - 2026-07-18

### Changed

- `get_movie`/`get_tv` no longer return a null certification just because the requested region lacks one — they fall back to the US rating, then any available country, and report which region the value actually came from via `certification_region`.

## [0.4.0] - 2026-07-18

### Added

- Add the `recommend_similar` MCP prompt, which plans a search for titles similar to one the user liked via `get_similar`/recommendations/discover instead of the model's own knowledge ([2d85f67](https://github.com/Grinv/tmdb-mcp/commit/2d85f67)); the `.mcpb` install preview now lists it too ([be487dc](https://github.com/Grinv/tmdb-mcp/commit/be487dc)).
- The search/discover/recommendations/similar/reviews tools now honor MCP client cancellation, aborting the in-flight TMDB request instead of running it to completion in the background ([8109dc9](https://github.com/Grinv/tmdb-mcp/commit/8109dc9), [55fe55f](https://github.com/Grinv/tmdb-mcp/commit/55fe55f)).

### Changed

- Sharpen `get_movie`/`get_tv`/`get_ratings` descriptions to disclose the ratings degrade-to-`{found:false}` shape, and `get_trending`'s `media_type` default ([e0d520d](https://github.com/Grinv/tmdb-mcp/commit/e0d520d)).

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
