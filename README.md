# tmdb-mcp

[![npm version](https://img.shields.io/npm/v/tmdb-mcp.svg)](https://www.npmjs.com/package/tmdb-mcp)
[![CI](https://github.com/Grinv/tmdb-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Grinv/tmdb-mcp/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/tmdb-mcp.svg)](LICENSE)

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
| `get_person`                                           | Biography, department, links                                                               |
| `get_movie_credits` / `get_tv_credits`                 | Top-billed cast and headline crew                                                          |
| `get_movie_recommendations` / `get_tv_recommendations` | Similar titles                                                                             |
| `get_trending`                                         | What's popular now (movies / TV / people, day or week)                                     |
| `get_movie_genres` / `get_tv_genres`                   | Genre id ↔ name reference                                                                  |
| `discover_movies` / `discover_tv`                      | Filter by genre, year/date range, rating, cast/crew, keywords, providers, certification, … |
| `get_watch_providers`                                  | Where to stream/rent/buy, by region (JustWatch via TMDB)                                   |
| `get_person_credits`                                   | A person's filmography (cast & crew)                                                       |
| `get_videos`                                           | Trailers/teasers/clips (YouTube links)                                                     |
| `find_by_imdb_id`                                      | Resolve an IMDb id → TMDB movie/TV/person                                                  |
| `get_tv_season` / `get_tv_episode`                     | Season episode list / single-episode details                                               |
| `search_keywords`                                      | Resolve keyword names → ids for `discover_*`                                               |
| `get_ratings`                                          | IMDb/RT/Metacritic ratings by IMDb id or title (standalone)                                |

**Backbone vs. enrichment.** TMDB is the primary source (search, metadata,
people, trending). OMDb is optional enrichment: `get_movie`/`get_tv` chain the
`imdb_id` TMDB returns into an OMDb lookup so ratings come back in one call.
Without an OMDb key the TMDB data still works; the `ratings` field just reports
that it is unconfigured.

**Localization.** Set `TMDB_LANGUAGE` (e.g. `ru-RU`) and `TMDB_REGION` (e.g.
`RU`) to get localized titles/overviews/genre names and region-specific
certifications. Most tools also accept a per-call `language` override.

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

Runtime requires Node ≥ 18. Contributor/agent guidance lives in
[AGENTS.md](AGENTS.md).

## Updating

- **`.mcpb` bundle:** download the new bundle from the releases page and reinstall.
- **From source:** `git pull && npm ci && npm run build`.
- **npx:** unpinned `npx -y tmdb-mcp` fetches the latest on the next run.

This product uses the TMDB API but is not endorsed or certified by TMDB.

## License

[MIT](LICENSE) © Grinv
