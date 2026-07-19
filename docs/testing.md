# Testing conventions

`src/__tests__/*.test.ts` mocks `fetch` and feeds it canned JSON fixtures (see
`tmdb.test.ts`'s `router()` + fixture constants, and `helpers.ts`). These
fixtures are hand-written, which makes it easy to accidentally encode what the
_code_ expects instead of what the _upstream API_ actually returns — a test
built that way stays green even when it's exercising a bug.

## The rule

A fixture must mirror the real response shape for that exact endpoint: only
the fields TMDB/OMDb actually send there, in the shape they actually send
them. Don't add a field because `format.ts` reads it, and don't reuse a
fixture from a similar-looking endpoint — check the endpoint you're mocking.

Two endpoints can look interchangeable and not be. `/search/multi` and
`/trending/*` tag every row with `media_type`; `/search/person` never does —
TMDB only returns person fields there, full stop. `searchPeople()` used to
reuse the `media_type`-dispatching summarizer, and the test fixture for
`/search/person` had `media_type: "person"` hand-added to it. The fixture made
the dispatch land on the right branch; the real API never would have, so
every real `search_people` call was mis-shaped as a TV result. The test was
green throughout.

## How to verify a fixture

Before writing or changing a fixture for an endpoint:

- If you have `TMDB_API_TOKEN` / `OMDB_API_KEY` available, hit the real
  endpoint once (curl, or the MCP tools themselves via an agent) and check
  which fields are actually present — don't assume from memory or from the
  TMDB docs page, which sometimes lag the real payload.
- If two routes share a summarizer, write a fixture per route rather than one
  shared constant, even if they look identical today — that's what keeps a
  future divergence (like the one above) from going unnoticed.
- `scripts/check-api.mjs` (`npm run check:api`) hits the live APIs and is a
  reasonable place to add a minimal shape assertion for a field a unit test
  fixture depends on, if you want drift caught in CI too.
