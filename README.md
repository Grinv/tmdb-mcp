# tmdb-mcp

An [MCP](https://modelcontextprotocol.io) server for **The Movie Database
(TMDB)**: search and look up movies, TV shows and people, and read
**IMDb / Rotten Tomatoes / Metacritic** ratings (via [OMDb](https://www.omdbapi.com/))
in the same call.

The server speaks standard MCP over stdio, so it works with any MCP client
(Claude Desktop/Code, Cursor, VS Code, Cline, …).

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

## Credentials

- **`TMDB_API_TOKEN`** (required): a TMDB v4 **"Read Access Token"** from
  <https://www.themoviedb.org/settings/api>. Sent as `Authorization: Bearer …`.
- **`OMDB_API_KEY`** (optional): a free key from
  <https://www.omdbapi.com/apikey.aspx> — enables ratings enrichment.

See [docs/clients.md](docs/clients.md) for per-client config snippets.

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
- **npx (if published):** unpinned `npx -y tmdb-mcp` fetches the latest next run.

This product uses the TMDB API but is not endorsed or certified by TMDB.

## License

[MIT](LICENSE) © Grinv
