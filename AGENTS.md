# AGENTS.md

Single source of truth for working on this repository, for **any** model or
agent. `CLAUDE.md` only references this file (`@AGENTS.md`); keep shared
guidance here. (End-user and runtime docs: [README.md](README.md).)

## Project shape

A TypeScript MCP server for movie/TV data with a hybrid backend. TMDB is the
backbone (search, metadata, people, trending), used through its v3 REST API with
a v4 Read Access Token. OMDb is optional enrichment that supplies
IMDb/Rotten Tomatoes/Metacritic ratings, keyed by the `imdb_id` TMDB returns.
Design rationale (why two clients, why not the IMDb API, TMDB endpoint quirks,
template reuse) is in [docs/architecture.md](docs/architecture.md).

```
src/
  index.ts        # bin entry — calls start()
  server.ts       # buildServer() + start(); registers everything
  config.ts       # env → validated Config (zod)
  version.ts      # VERSION constant kept in sync with package.json by npm version
  format.ts       # raw TMDB/OMDb payloads → trimmed, agent-facing shapes
  format.schemas.ts # Zod schemas mirroring format.ts's shapers 1:1; each tool's outputSchema
                    # AND the shaper itself parse the result through the matching schema
                    # before returning, so shaper/schema drift throws immediately
  prompts.ts      # MCP Prompts: multi-step plans that guide the model through the tools
  lib/            # GENERIC carcass: http, rateLimit, cache, upstream, errors, logger, result
  clients/        # tmdb.ts (backbone reads), omdb.ts (ratings enrichment)
  tools/          # tmdb/ (search.ts, details.ts incl. OMDb enrichment, discover.ts, lookups.ts,
                  # fields.ts shared builders, index.ts composes registerTmdbTools), omdb.ts
                  # (get_ratings), shared.ts (READ_ONLY, requireConfigured(Cached) — try/catch →
                  # ToolResult)
  __tests__/      # node:test (*.test.ts) + helpers.ts
scripts/          # run-tests.ts (generic), check-api.ts (domain),
                  # decode-stack.ts (maps a user's logged stack to source lines:
                  # rebuild the release tag with `npm ci && npx tsdown
                  # --sourcemap`, then pipe the log through it),
                  # sync-version.ts (npm version hook), sync-manifest.ts (manifest.json
                  # prompts from the server's own render; `npm run sync:manifest`),
                  # preversion-check.ts (npm version gate — see .agents/skills/release/SKILL.md)
.agents/skills/   # reusable agent workflows for this repo (e.g. live-audit/) — plain Markdown
                  # with a YAML frontmatter name/description, not tied to any one tool's
                  # orchestration features. Same skill name/layout as this project's sibling
                  # MCP servers (steam-games-mcp, mal-mcp, anilist-mcp-server) — sync
                  # improvements both ways rather than letting them drift. `.claude/skills` is
                  # a symlink here (Codex CLI/Gemini CLI read `.agents/skills` directly,
                  # Claude Code the symlink)
```

## Commands

```sh
npm run build          # tsc --noEmit + tsdown → dist/index.js (single ESM bundle)
npm test               # run src/**/*.test.ts with node:test (native type stripping)
npm run test:coverage  # same, with coverage (gate: ~80%)
npm run lint           # eslint
npm run format         # prettier --write
npm run check:api      # live upstream health-check (needs TMDB_API_TOKEN; OMDb check skipped without OMDB_API_KEY)
npm run inspector      # run under the MCP Inspector
```

## Conventions

- **Docs and in-code text are English** (README, docs, comments, tool
  descriptions, error messages).
- Runtime floor is **Node ≥ 22.18**. `engines`, `manifest.json`'s
  `compatibility.runtimes.node` and the CI floor job must agree; tsdown derives
  its target from `engines` (node22.18.0), and `tsconfig` targets ES2024. Node 22.18
  enables built-in TS type stripping by default, and the tests rely on it: they
  run as `.ts` with no transpile step. So relative imports name the real `.ts`
  file (`./x.ts`, never `./x.js`), and only erasable TS syntax is allowed: no
  `enum`, `namespace` or constructor parameter properties (`tsc` enforces this
  via `erasableSyntaxOnly`).
- Log to **stderr only**; stdout is the MCP protocol channel. Use the logger,
  which redacts credentials.
- Tool failures return `{ isError: true }` results (via `requireConfigured()` /
  `result.ts`) and are never thrown, so the agent gets an actionable message.
  `requireConfigured(client, fn, validate?)`'s optional `validate` callback runs
  after the configured-check and before `fn`. Use it, not a manual duplicate
  configured-check, when a tool needs both checks in that order, e.g.
  `get_ratings` in `tools/omdb.ts`.
- Errors have three layers, each with one job.
  **Classify:** every known failure gets its own `ApiErrorCode`
  (`lib/errors.ts`). Whether it is transient comes from that code's `KIND`
  entry; pass `retryable` only to override one occurrence whose nature differs
  (OMDb's daily quota). `ApiError.message` is diagnostics for logs and may hold
  a raw body.
  **Translate:** `toProblem()` (`lib/result.ts`) is the only place a failure
  becomes tool-facing text: an RFC 9457 problem built from `code`/`status`/`detail`
  only. Anything that isn't an `ApiError` is an internal bug, logged in full
  and shown as a stable "internal error".
  **Output:** the model reads the problem's `detail` as the `isError` text, and
  the problem itself goes in `_meta["io.github.Grinv.tmdb-mcp/problem"]` (never
  `structuredContent`).
  A new code needs a `PROBLEMS` entry (the compiler enforces it) and a
  `docs/errors.md` section (a test enforces it). Never show `err.message` to the
  agent. Rules around it, each with what enforces it:
  - Only the classification layer creates failures, and only as `ApiError`.
    An upstream's own rule goes in `HttpClient`'s `refusedBody` (for a success
    body that is really a refusal) or `refineError`; both run before the retry
    decision, so the failure gets retries and logging like any other. ESLint
    bans `new Error`/`extends Error` outside `lib/errors.ts` and `config.ts`.
  - Clients fetch and cache only; they never catch. ESLint bans `try` and
    `.catch()` in `src/clients/`. Optional data uses `unlessOutage()`
    (tolerates an outage, lets anything else through). A usable but partial
    result is returned as `degraded(value)`, which the cache never stores.
  - Only the logger writes to stdio and turns an error into log text (stack,
    cause chain, redaction). Pass it the error object, never `err.message`.
    ESLint bans `console` and `process.stdout`/`stderr` outside
    `lib/logger.ts`.
  - Substituting data for a failure (a stale copy, a partial result) is
    allowed only for an outage, and the code asks `isOutage()` instead of
    keeping its own list of codes. Reporting an absence with its reason
    (OMDb enrichment's `found: false` + the problem's detail) may cover any
    failure, since it hides nothing.
  - Tolerating a failure is never silent. An upstream outage degrades with a
    signal the caller sees (`found: false` + reason, the stale `_meta`, a
    degraded value), and `toProblem()` logs a bug. Review-enforced.
- Mocked-`fetch` test fixtures must mirror the real upstream response shape
  for that exact endpoint, including fields the current code doesn't read. See
  [.agents/skills/fixture-accuracy-check/SKILL.md](.agents/skills/fixture-accuracy-check/SKILL.md).
- Raw upstream types in `format.ts` never include `null`: each client's
  `HttpClient` parses with the `nullAsAbsent` reviver (`lib/http.ts`), which
  drops null properties, so `field?: T` means "a T or absent". Type a new raw
  field `?: T` (not `?: T | null`) and test null handling at that boundary, not
  by feeding `null` to a shaper. The reviver is opt-in per upstream; don't use
  it where null carries meaning (e.g. GraphQL).
- Keep clients fetch+cache only; all raw→agent-facing shaping lives in
  `src/format.ts`. Trim responses for token efficiency.
- Stale and partial data report themselves through Node's
  `AsyncLocalStorage`, not through parameters. `requireConfigured`
  (`tools/shared.ts`) runs each tool call inside a fresh `callNotes` record
  (`lib/cache.ts`), and `TtlCache` notes in it the age of any stale value it
  served and whether a result was partial (`degraded()` with no complete
  stale copy). The tool result then carries
  `_meta: {"io.github.Grinv.tmdb-mcp/stale": {"age_seconds": N}}` and/or
  `"io.github.Grinv.tmdb-mcp/partial": true` (never inside
  `structuredContent`). Nothing in a client method or handler passes a
  callback, so a new cached method can't forget to. A shared (deduplicated)
  compute runs in its own record, so every caller it serves gets its notes,
  and a result built from stale or partial input is not cached. Stale data
  only stands in for an outage, decided by `isOutage()` (`lib/errors.ts`'s
  `KIND` table, a column next to `transient`), because "retrying now helps"
  and "the upstream is down" differ (OMDb's daily quota). It is served for at
  most `CACHE_MAX_STALE_MS` past expiry (RFC 5861's stale-if-error window).
  An entry's age is the larger of its wall-clock and monotonic deltas
  (`#ageMs`): the wall clock counts sleep but steps, the monotonic one doesn't
  step but stops during sleep (a step forward still looks like sleep; see the
  comment there). Tests drive both through `fakeClock()` (`helpers.ts`).
  An outage is logged once, where every request's failure leaves
  `HttpClient.getJson` (its URL without the query, which holds user
  searches). The cache logs only its own decisions (a stale copy served,
  with its age; a partial refresh), made once per refresh in `#refresh` for
  every caller waiting on it: one sequence (computed → stale copy →
  partial). Add a case there, not another branch elsewhere.
- Every shaper in `format.ts` returns `z.infer<typeof <name>Schema>` (the
  matching schema from `format.schemas.ts`), built via that schema's
  `.parse()`, not `Record<string, unknown>`. Client methods in `clients/*.ts`
  keep that precision (`ReturnType<typeof shaperFn>` / `Page<...>`) instead
  of widening to `Record<string, unknown>`. Widen only at the
  wire-serialization boundary (`tools/shared.ts`'s `requireConfigured()` /
  `lib/result.ts`'s `jsonResult()`).
- `Page<S>` (`format.ts`) must stay a `type` alias, never an `interface`. TS
  synthesizes an index signature (needed for assignability to
  `Record<string, unknown>`, which the `jsonResult()` boundary above requires)
  only on anonymous/aliased object types, not on named interfaces. An
  `interface` compiles in isolation but breaks every call site that passes a
  `Page<...>` through that boundary.
- Every schema in `format.schemas.ts` must reject unknown keys, via
  `z.strictObject(...)`. A non-strict schema silently drops unknown keys instead
  of failing, which defeats the shaper/schema drift check above. Verified on
  Zod 4.4.3 and 4.6.5: `.pick()`/`.extend()` on a `strictObject`
  **preserve** its unknown-key rejection, so the derived `movieCardSchema`/`tvCardSchema` are
  already strict. Their trailing `.strict()` is defensive; don't remove it on
  the assumption that pick/extend produce a loose shape.
- Never use `z.date()`/`z.bigint()`/`z.nan()`/`.transform()`/`z.map()`/`z.set()`/
  `z.symbol()` in a tool's `inputSchema` or `outputSchema` (or anything they're
  built from, e.g. `format.schemas.ts`). `@modelcontextprotocol/server` converts
  every tool schema to JSON Schema via `z.toJSONSchema()` with the default
  `unrepresentable: "throw"`, so one of these types anywhere in a schema throws.
  Since SDK 2.3 the conversion is lazy: `registerTool()` succeeds and the throw
  comes at the first `tools/list`. `connectServer()` in `__tests__/helpers.ts`
  calls `listTools()` up front, so the test suite still catches it. `z.coerce.*`
  is fine in `config.ts` (env-var parsing only; it never reaches a tool schema).
- `clients/tmdb.ts` `import type`s `DiscoverParams` from `tools/tmdb/discover.ts`
  (its `z.infer` source of truth, alongside the hand-authored discover input
  schemas), so a lower-layer file type-imports from a higher-layer one. This
  is intentional and fully erased at build (no runtime circular import,
  verified via `tsc`/`tsdown`). Don't invert the import direction.
- A fixed default for a tool field goes in its schema as `.default(x)`. The
  SDK publishes it as JSON Schema `default` (still optional for the caller)
  and the handler receives the resolved value. Don't restate it in the
  `.describe()` text or as `?? x` in the handler; two sources of truth drift.
  Defaults that TMDB itself applies when a param is omitted (e.g. `sort_by`)
  stay as omission, not `.default()`.
- Write tool `description`s and per-field `.describe()` text for the calling
  model: explain when to use a tool and what each parameter means. Check new
  or edited descriptions against the `tool-description-check` skill (Glama's
  TDQS rubric) before committing.
- **Name a field for what it accepts, not a generic ID suffix.** This
  project's `id`/`ids` fields are always a numeric TMDB id (resolve a
  title/name to one via `search_movies`/`search_tv`/`search_people` first).
  A field that takes an external identifier in another format says so in its
  name (`imdb_id`, not `id`). Use the same field name and Zod builder for the
  same concept in every tool that takes it (e.g. `tmdbId`, `page`, `language`,
  `region` in `tools/tmdb/fields.ts`); grep sibling tools before naming a new
  field for an existing concept.
- Keep dependencies minimal; a new one needs a clear justification (supply
  chain). In particular, do **not** pull in a third-party TMDB SDK: the `lib/`
  carcass already covers retries/cache/rate-limiting, and `format.ts` shapes
  responses.
- **Never commit secrets.** Tokens come from env vars / OS keychain only.
- Cross-platform: macOS, Linux and Windows. Avoid POSIX-only shell in npm
  scripts; use the Node helper scripts.
- **Commits:** author/committer `Grinv <4070730+Grinv@users.noreply.github.com>`;
  do **not** add a `Co-Authored-By` trailer.

## Testing the live/published server

For a full audit of the published package (build/test/lint, then edge cases
against the live MCP tools, cross-checked against source), follow [.agents/skills/live-audit/SKILL.md](.agents/skills/live-audit/SKILL.md).

## Before opening a PR

Run `npm run build && npm test && npm run lint && npm run format:check`.
Update `CHANGELOG.md` (Unreleased section) — see
[.agents/skills/changelog-style/SKILL.md](.agents/skills/changelog-style/SKILL.md)
for entry style.

## Releasing

`package.json` is the single source of truth for the version; `npm version`
bumps it, syncs every derived file and tags the release. See
[.agents/skills/release/SKILL.md](.agents/skills/release/SKILL.md) for the
full steps and MCP Registry details.
