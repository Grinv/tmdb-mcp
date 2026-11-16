# Architecture notes

Background and rationale behind the hybrid TMDB + OMDb design. Read this when
touching `clients/`, `format.ts`, or deciding whether a new upstream deserves
its own client.

## Why two clients in one server (and not two servers)

The value is the cross-link: `get_movie`/`get_tv` take the `imdb_id` from a
TMDB detail response and call OMDb, so ratings come back in a single tool call
and the agent never passes ids between tools. OMDb alone is too thin
(ratings by id) to justify its own server, and its title search is weak, so TMDB
does the navigating. Enrichment stays optional (`include_ratings`), so a caller
never pays for the extra OMDb request when it doesn't need ratings.

## Why not the official IMDb API

IMDb has no free public API (the official route is paid/enterprise). OMDb is
the free source for IMDb-style ratings, so the server never calls IMDb
directly.

## TMDB endpoint verification

TMDB endpoints and fields were checked against the official reference
(<https://developer.themoviedb.org/reference>). `/movie/{id}` carries
`imdb_id` directly. `/tv/{id}` does **not**: request
`append_to_response=external_ids` to get `external_ids.imdb_id`. The same
append works on `/tv/{id}/season/{n}/episode/{m}`, so an episode reports its own
`imdb_id` (and can get a per-episode IMDb rating through `get_ratings`) at no
extra request. This does **not** scale to a whole season. Checked live,
`/tv/{id}/season/{n}`'s appended `external_ids` is season-level and has no
`imdb_id` key at all, and its episode rows carry only `id`/`show_id`.
Per-episode ids there would cost one request per episode, so
`get_tv_season`/`expand_episodes` omit them. OMDb returns
`200` with `{ Response: "False", Error }` for misses, and the client maps that
to a soft `{ found: false }` instead of throwing.

## Stale-cache visibility

`TtlCache.wrapStaleOnError` degrades gracefully when an upstream is briefly
down. During an outage (`isOutage()` in `lib/errors.ts`: a rate limit, 5xx,
network failure, timeout or a proxy's page instead of the API) it serves a
previously cached (possibly expired) value instead of failing the call. A
404, a rejected key or a bug still fails it. That default is right, but a caller
can't tell "fresh" from "the upstream was down 20 minutes ago and this is what
we had": the two look identical in `structuredContent`. A `stale` field in the
domain shape (`format.ts`) would touch every cached endpoint's schema for a rare
edge case and mix a caching concern into the "shape of a movie". So the signal
travels out-of-band through the call's async context. `requireConfigured` runs
each tool call inside a Node `AsyncLocalStorage` record, `wrapStaleOnError`
writes the served value's age into it (see the AGENTS.md convention), and the
result carries `_meta: {"io.github.Grinv.tmdb-mcp/stale": {"age_seconds": N}}`.
That is a sibling of `structuredContent`, per the MCP spec's `_meta` mechanism,
not a field inside it. A stale value is only served for `CACHE_MAX_STALE_MS` past
expiry. A result missing an optional part lost to an outage (a chunk of
`expand_episodes`, the detail behind native-language trailers) is flagged
the same way, as `"io.github.Grinv.tmdb-mcp/partial": true`, unless a
complete stale copy is served instead. Every other `search_*`/
`discover_*`/`get_similar`/`get_*_recommendations`/`get_reviews`/`get_trending`/
`get_movie_releases` is never cached (see `clients/tmdb.ts`), so it can't go
stale. `search_watch_providers` is the one exception: it caches TMDB's provider
list and can surface `_meta` like any other cached tool.

## Reuse / shared architecture

This server was generated from the **`mcp-server-template`** repository: a
generic carcass (`src/lib/` + build tooling, tests infra, CI) plus a thin
domain layer (`config.ts`, `format.ts`, `clients/`, domain `tools/`,
`check-api.ts`). When fixing carcass bugs, consider whether the fix belongs
upstream in the template.
