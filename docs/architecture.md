# Architecture notes

Background and rationale behind the hybrid TMDB + OMDb design. Read this when
touching `clients/`, `format.ts`, or deciding whether a new upstream deserves
its own client.

## Why two clients in one server (and not two servers)

The value is the cross-link: `get_movie`/`get_tv` take the `imdb_id` from a
TMDB detail response and call OMDb so ratings come back in a single tool call
— no id-threading by the agent. OMDb alone is too thin (ratings-by-id) to
justify its own server, and its title search is weak; TMDB is the navigator.
Keep enrichment optional and controllable (`include_ratings`) so a caller
never pays the extra OMDb hop when ratings aren't needed.

## Why not the official IMDb API

IMDb has no free public API (the official route is paid/enterprise). OMDb is
the pragmatic free source for IMDb-style ratings. We deliberately do **not**
call IMDb directly.

## TMDB endpoint verification

TMDB endpoints/fields were verified against the official reference
(<https://developer.themoviedb.org/reference>): `/movie/{id}` carries
`imdb_id` directly; `/tv/{id}` does **not** — request
`append_to_response=external_ids` to get `external_ids.imdb_id`. OMDb returns
`200` with `{ Response: "False", Error }` for misses, so the client maps that
to a soft `{ found: false }` instead of throwing.

## Stale-cache visibility

`TtlCache.wrapStaleOnError` degrades gracefully when an upstream is briefly
down: it serves a previously-cached (possibly expired) value instead of
failing the call. That's the right default, but a caller has no way to tell
"fresh" from "the upstream was down 20 minutes ago and this is what we had" —
the two look identical in `structuredContent`. Putting a `stale` field inside
the domain shape (`format.ts`) would mean touching every cached endpoint's
schema for a rare edge case, and would conflate a caching concern with the
"shape of a movie". Instead, the signal travels out-of-band: an `onStale`
callback threaded from `wrapStaleOnError` up through the client method up to
the tool handler (see the AGENTS.md convention), which attaches
`_meta: {"tmdb-mcp/stale": true}` — a sibling of `structuredContent`, per the
MCP spec's `_meta` mechanism, not a field inside it. `search_*`/`discover_*`/
`get_similar`/`get_recommendations`/`get_reviews` are never cached in the
first place (see `clients/tmdb.ts`), so they can never go stale.

## Reuse / shared architecture

This server was generated from the **`mcp-server-template`** repository: a
generic carcass (`src/lib/` + build tooling, tests infra, CI) plus a thin
domain layer (`config.ts`, `format.ts`, `clients/`, domain `tools/`,
`check-api.mjs`). When fixing carcass bugs, consider whether the fix belongs
upstream in the template.
