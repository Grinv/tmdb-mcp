# TMDB MCP Server

[![npm version](https://img.shields.io/npm/v/tmdb-mcp.svg)](https://www.npmjs.com/package/tmdb-mcp)
[![CI](https://github.com/Grinv/tmdb-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Grinv/tmdb-mcp/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/tmdb-mcp.svg)](LICENSE)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.Grinv%2Ftmdb--mcp-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Grinv/tmdb-mcp&version=latest)
[![tmdb-mcp MCP server](https://glama.ai/mcp/servers/Grinv/tmdb-mcp/badges/score.svg)](https://glama.ai/mcp/servers/Grinv/tmdb-mcp)

An [MCP](https://modelcontextprotocol.io) server for **The Movie Database
(TMDB)**: search and look up movies, TV shows and people, and read
**IMDb / Rotten Tomatoes / Metacritic** ratings (via [OMDb](https://www.omdbapi.com/))
in the same call.

The server speaks standard MCP over stdio, so it works with any MCP client
(Claude Desktop/Code, Cursor, VS Code, Cline, …).

Once it's connected, just ask your agent in natural language (needs a free TMDB
token — see [Getting your credentials](#getting-your-credentials)):

```
"Search for the movie Dune: Part Two and show its overview, genres and runtime."
"What movies are trending this week?"
"Find TV shows similar to Breaking Bad."
"Who directed Oppenheimer? Show the main cast."
"What's Greta Gerwig's filmography?"
"Discover highly-rated sci-fi movies from the 2010s, sorted by rating."
"Where can I stream The Bear in the US?"
"Show me the trailer for Deadpool & Wolverine."
"List the episodes of Severance season 1."
"Which movie has IMDb id tt0111161?"
"Search for people named Zendaya."
```

With an optional (free) **OMDb** key, ratings are added too:

```
"What are the IMDb, Rotten Tomatoes and Metacritic scores for The Godfather?"
"Compare the critics' scores for Barbie and Oppenheimer."
```

## Install

Add it to your MCP client's config. The only required credential is a TMDB v4
**Read Access Token**; `OMDB_API_KEY` (ratings) and `TMDB_LANGUAGE` / `TMDB_REGION`
(localization) are optional.

**Via npx (no install):**

```json
{
  "mcpServers": {
    "tmdb": {
      "command": "npx",
      "args": ["-y", "tmdb-mcp"],
      "env": {
        "TMDB_API_TOKEN": "your-tmdb-v4-read-access-token (required)",
        "OMDB_API_KEY": "your-omdb-key (optional — IMDb/RT/Metacritic ratings)",
        "TMDB_LANGUAGE": "en-US (optional — localize, e.g. ru-RU)",
        "TMDB_REGION": "US (optional — region for certifications, e.g. RU)"
      }
    }
  }
}
```

> Replace each value with your own. Only `TMDB_API_TOKEN` is required — delete the
> lines marked optional if you don't need them.

**As a `.mcpb` bundle (easiest for Claude Desktop):** download `tmdb-mcp.mcpb`
from the [latest release](https://github.com/Grinv/tmdb-mcp/releases/latest),
then open it / drag it into Claude Desktop's Extensions. It's a self-contained
bundle (no Node or npm needed); enter the token and the optional fields in the
install dialog. Re-download and reinstall to update.

**From source:** `git clone`, then `npm ci && npm run build`, and point the client
at it with `"command": "node"`, `"args": ["/ABS/PATH/tmdb-mcp/dist/index.js"]` and
the same `env` as above.

See [docs/clients.md](docs/clients.md) for per-client details and all tunables.

## What it does

| Tool                                                   | Purpose                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `search_movies` / `search_tv` / `search_people`        | Find titles/people by name → TMDB id                                                       |
| `search_multi`                                         | Search movies, TV and people at once (each row has a `media_type`)                         |
| `get_movie` / `get_tv`                                 | Full details **+ IMDb/RT/Metacritic ratings** (toggle with `include_ratings`)              |
| `get_movies` / `get_tv_shows`                          | Compact card(s) (title/year/genres/vote average, ratings opt-in) for 1-20 ids in one call  |
| `get_person`                                           | Biography, department, links                                                               |
| `get_movie_credits` / `get_tv_credits`                 | Top-billed cast and headline crew                                                          |
| `get_movie_recommendations` / `get_tv_recommendations` | TMDB's editorial recommendations                                                           |
| `get_similar`                                          | Algorithmically similar titles (`media_type` + id)                                         |
| `get_trending`                                         | What's popular now (movies / TV / people, day or week)                                     |
| `get_movie_genres` / `get_tv_genres`                   | Genre id ↔ name reference                                                                  |
| `discover_movies` / `discover_tv`                      | Filter by genre, year/date range, rating, cast/crew, keywords, providers, certification, … |
| `get_watch_providers`                                  | Where to stream/rent/buy, by region (JustWatch via TMDB)                                   |
| `get_person_credits`                                   | A person's filmography (cast & crew)                                                       |
| `get_videos`                                           | Trailers/teasers/clips (YouTube links)                                                     |
| `get_reviews`                                          | User reviews (author, rating, text) for a movie/TV                                         |
| `get_collection`                                       | A movie franchise/collection and its parts, in release order                               |
| `find_by_imdb_id`                                      | Resolve an IMDb id → TMDB movie/TV/person                                                  |
| `get_tv_season` / `get_tv_episode`                     | Season episode list / single-episode details                                               |
| `search_keywords`                                      | Resolve keyword names → ids for `discover_*`                                               |
| `search_companies`                                     | Resolve a production company name → id for `discover_*`'s `with_companies`                 |
| `get_ratings`                                          | IMDb/RT/Metacritic ratings by IMDb id or title (standalone)                                |

**Prompts.** Alongside the tools above, the server exposes two MCP prompts:
`recommend_similar` (`title`, optional `media_type`, optional `count`) plans a
search for titles similar to one the user liked, driving `get_similar` /
`get_movie_recommendations` / `get_tv_recommendations` / `discover_movies` /
`discover_tv` instead of relying on the model's own knowledge. `top_by_entity`
(`name`, optional `entity_type`, `genre`, `media_type`, `count`) finds the
best-regarded titles from a person or a production company/studio — e.g. "A24's
top movies" or "Tarantino's best crime films" — via `discover_movies`/
`discover_tv`, and for a person's TV work specifically falls back to
`get_person_credits` (TMDB's own `/discover/tv` can't filter by person at all).

**Backbone vs. enrichment.** TMDB is the primary source (search, metadata,
people, trending). OMDb is optional enrichment: `get_movie`/`get_tv` chain the
`imdb_id` TMDB returns into an OMDb lookup so ratings — plus a free-text
awards summary (major-award wins/nominations, e.g. Oscars for a film or Emmys
for a show, for the title as a whole, not attributed to any one person) and
OMDb's own age rating (`ratings.rated`, separate from this server's own
`certification`) — come back in one call. Without an OMDb key the TMDB data
still works; the `ratings` field just
reports that it is unconfigured.

**Localization.** Set `TMDB_LANGUAGE` (e.g. `ru-RU`) and `TMDB_REGION` (e.g.
`RU`) to get localized titles/overviews/genre names and region-specific
certifications. The search tools, `get_movie`/`get_tv`/`get_person`,
`get_collection` and `discover_movies`/`discover_tv` also accept a per-call
`language` override.

## Getting your credentials

One token is required (TMDB); the OMDb key is optional. Both are free.

1. **TMDB token (required).** Create a free account at
   [themoviedb.org](https://www.themoviedb.org/signup), then open
   **[Settings → API](https://www.themoviedb.org/settings/api)** and request an API
   key (personal use). Copy the **"API Read Access Token"** (the long v4 token, _not_
   the short v3 key) into **`TMDB_API_TOKEN`**. It's sent as `Authorization: Bearer …`.
2. **OMDb key (optional).** Grab a free key at
   **[omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx)** (the free tier
   is fine), click the activation link in the email, and set **`OMDB_API_KEY`**. This
   unlocks `get_ratings` and the IMDb / Rotten Tomatoes / Metacritic scores in movie
   and TV details. Without it, everything else still works.

Put these in your MCP client config's `env` block (see
[docs/clients.md](docs/clients.md) for per-client snippets) — never commit them.
`TMDB_LANGUAGE` / `TMDB_REGION` optionally set default locale/region (e.g. `ru-RU`, `RU`).

### Advanced tuning (env-only, no install-UI equivalent)

Sensible defaults; only set these if you know you need to. Env var only — not
exposed in Claude Desktop's install form, so CLI/Docker users set them directly.

| Variable               | Default                        | Purpose                                            |
| ---------------------- | ------------------------------ | -------------------------------------------------- |
| `TMDB_BASE_URL`        | `https://api.themoviedb.org/3` | Override TMDB's API base (e.g. a proxy)            |
| `OMDB_BASE_URL`        | `https://www.omdbapi.com`      | Override OMDb's API base                           |
| `HTTP_TIMEOUT_MS`      | `15000`                        | Per-request timeout before aborting                |
| `HTTP_RETRIES`         | `2`                            | Retries on a transient upstream failure            |
| `TMDB_MIN_INTERVAL_MS` | `60`                           | Minimum spacing between TMDB requests              |
| `OMDB_MIN_INTERVAL_MS` | `0`                            | Minimum spacing between OMDb requests              |
| `CACHE_TTL_MS`         | `300000`                       | How long cached responses stay fresh               |
| `LOG_LEVEL`            | `info`                         | `debug` \| `info` \| `warn` \| `error` \| `silent` |

If TMDB/OMDb is briefly down and a tool falls back to a cached-but-expired
response rather than failing, the result carries
`_meta: {"tmdb-mcp/stale": true}` alongside the normal data, so a client can
tell a degraded answer from a fresh one.

## Develop

```sh
npm install
npm run build        # type-check + bundle to dist/index.js
npm test             # node:test (mocked, offline)
npm run lint
npm run format
npm run check:api    # live upstream health-check (needs the env credentials)
npm run inspector    # run under the MCP Inspector
```

Runtime requires Node ≥ 20. Contributor/agent guidance lives in
[AGENTS.md](AGENTS.md).

## Updating

- **`.mcpb` bundle:** download the new bundle from the releases page and reinstall.
- **From source:** `git pull && npm ci && npm run build`.
- **npx:** unpinned `npx -y tmdb-mcp` fetches the latest on the next run.

This product uses the TMDB API but is not endorsed or certified by TMDB.

## License

[MIT](LICENSE) © Grinv
