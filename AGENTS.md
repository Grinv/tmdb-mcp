# AGENTS.md

Single source of truth for working on this repository — for **any** model or
agent. `CLAUDE.md` only references this file (`@AGENTS.md`); keep all shared
guidance here, not in CLAUDE.md. (For end-user/runtime docs, see [README.md](README.md).)

## Project shape

A TypeScript MCP server for movie/TV data. Hybrid backend: TMDB is the backbone
(search, metadata, people, trending) via its v3 REST API with a v4 Read Access
Token; OMDb is optional enrichment supplying IMDb/Rotten Tomatoes/Metacritic
ratings, keyed by the `imdb_id` TMDB returns. Design rationale (why two
clients, why not the IMDb API, TMDB endpoint quirks, template reuse) lives in
[docs/architecture.md](docs/architecture.md).

```
src/
  index.ts        # bin entry — calls start()
  server.ts       # buildServer() + start(); registers everything
  config.ts       # env → validated Config (zod)
  version.ts      # VERSION constant kept in sync with package.json by npm version
  format.ts       # raw TMDB/OMDb payloads → trimmed, agent-facing shapes
  format.schemas.ts # Zod schemas mirroring format.ts's shapers 1:1; each tool's outputSchema
                    # AND the shaper itself parses its result through the matching schema
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
                  # sync-version.ts (npm version hook), preversion-check.ts (npm version
                  # gate — see .agents/skills/release/SKILL.md)
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
npm run build          # tsc --noEmit + tsup → dist/index.js (single ESM bundle)
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
- Runtime floor is **Node ≥ 22.18** (`engines`, `manifest.json`'s
  `compatibility.runtimes.node` and the CI floor job must agree); tsup targets
  `node22`, `tsconfig` targets ES2024. 22.18 is where Node's built-in TS type
  stripping is on by default, which the tests rely on: they run as `.ts`
  directly, with no transpile step. So relative imports name the real `.ts`
  file (`./x.ts`, never `./x.js`) and only erasable TS syntax is allowed — no
  `enum`, `namespace` or constructor parameter properties (`tsc` enforces this
  via `erasableSyntaxOnly`).
- Log to **stderr only** — stdout is the MCP protocol channel. Use the logger;
  it redacts credentials.
- Tool failures return `{ isError: true }` results (via `requireConfigured()` /
  `result.ts`), never thrown — the agent should get an actionable message.
  `requireConfigured(client, fn, validate?)`'s optional `validate` callback is
  checked after the configured-check but before `fn` — use it (instead of a
  manual duplicate configured-check) when a tool needs both checks in that
  specific order, e.g. `get_ratings` in `tools/omdb.ts`.
- Mocked-`fetch` test fixtures must mirror the real upstream response shape
  for that exact endpoint, not just whatever fields make the current code
  pass — see
  [.agents/skills/fixture-accuracy-check/SKILL.md](.agents/skills/fixture-accuracy-check/SKILL.md).
- Keep clients fetch+cache only; all raw→agent-facing shaping lives in
  `src/format.ts`. Trim responses for token efficiency.
- Every cached `TmdbClient`/`OmdbClient` method takes a trailing optional
  `onStale?: () => void`, forwarded down to `TtlCache.wrapStaleOnError`
  (`lib/cache.ts`) — it fires right before a stale (upstream-down) fallback
  value is returned. A tool handler that calls a cached method creates one via
  `tools/shared.ts`'s `trackStale()` and passes `.onStale` into the client
  call plus `.meta` as `requireConfigured`'s `getMeta`, so a stale response
  surfaces as `_meta: {"tmdb-mcp/stale": true}` on the tool result (never
  inside `structuredContent` — that stays pure domain shape, validated by
  `outputSchema`). A new cached method that skips wiring this through will
  silently serve stale data with no way for the caller to detect it.
- Every shaper in `format.ts` returns `z.infer<typeof <name>Schema>` (the
  matching schema from `format.schemas.ts`), built via that schema's
  `.parse()` — not `Record<string, unknown>`. Client methods in `clients/*.ts`
  mirror this precision (`ReturnType<typeof shaperFn>` / `Page<...>`) instead
  of widening back to `Record<string, unknown>`; that widening is only correct
  at the actual wire-serialization boundary (`tools/shared.ts`'s
  `requireConfigured()` / `lib/result.ts`'s `jsonResult()`).
- `Page<S>` (`format.ts`) must stay a `type` alias, never an `interface`: TS
  only synthesizes an index signature — required for assignability to
  `Record<string, unknown>`, which the `jsonResult()` boundary above needs —
  on anonymous/aliased object types, never on named interfaces. Changing it to
  an `interface` compiles fine in isolation but breaks every call site that
  passes a `Page<...>` through that boundary.
- Every schema in `format.schemas.ts` must reject unknown keys, via
  `z.strictObject(...)`. A non-strict schema silently drops unknown keys instead
  of failing, which defeats the shaper/schema drift check above. Note (verified
  on Zod 4.4.3 and 4.6.5): `.pick()`/`.extend()` on a `strictObject`
  **preserve** its unknown-key rejection, so the derived `movieCardSchema`/`tvCardSchema` are
  already strict; their trailing `.strict()` is defensive, not load-bearing —
  don't "reconcile" it away on the assumption pick/extend produce a loose shape.
- Never use `z.date()`/`z.bigint()`/`z.nan()`/`.transform()`/`z.map()`/`z.set()`/
  `z.symbol()` in a tool's `inputSchema` or `outputSchema` (or anything they're
  built from, e.g. `format.schemas.ts`). `@modelcontextprotocol/server` converts
  every tool schema to JSON Schema via `z.toJSONSchema()` with the default
  `unrepresentable: "throw"` — one of these types anywhere in the schema throws.
  Since SDK 2.3 that conversion is lazy, so `registerTool()` itself succeeds
  and the throw moves to the first `tools/list`; `connectServer()` in
  `__tests__/helpers.ts` calls `listTools()` up front, so the test suite still
  catches it. `z.coerce.*` is fine in `config.ts` (env-var parsing only; never
  reaches a tool schema).
- `clients/tmdb.ts` `import type`s `DiscoverParams` from `tools/tmdb/discover.ts`
  (its `z.infer` source of truth, alongside the hand-authored discover input
  schemas) — a lower-layer file type-importing from a higher-layer one. This
  is intentional and fully erased at build (no runtime circular import,
  verified via `tsc`/`tsup`); don't invert the import direction to "fix" it.
- Write tool `description`s and per-field `.describe()` text for the calling
  model: explain when to use a tool and what each parameter means. Check new
  or edited descriptions against the `tool-description-check` skill (Glama's
  TDQS rubric) before committing.
- **Name a field for what it actually accepts, not a generic ID suffix** —
  this project's `id`/`ids` fields are always a numeric TMDB id (resolve a
  title/name to one via `search_movies`/`search_tv`/`search_people` first),
  and a field that takes an external identifier in a different format says
  so in its own name (`imdb_id`, not `id`). Keep the same field name and
  Zod builder for the same concept across every tool that takes it (e.g.
  `tmdbId`, `page`, `language`, `region` in `tools/tmdb/fields.ts`) — grep sibling
  tools before naming a new field for an existing concept instead of
  defining an ad hoc one-off.
- Keep dependencies minimal. New deps need a clear justification (supply-chain).
  In particular, do **not** pull in a third-party TMDB SDK — the `lib/` carcass
  already covers retries/cache/rate-limiting, and we shape responses ourselves.
- **Never commit secrets.** Tokens come from env vars / OS keychain only.
- Cross-platform: macOS, Linux and Windows. Avoid POSIX-only shell in npm
  scripts (use the Node helper scripts).
- **Commits:** author/committer `Grinv <4070730+Grinv@users.noreply.github.com>`;
  do **not** add a `Co-Authored-By` trailer.

## Testing the live/published server

For a full audit of the currently published package — build/test/lint plus
hammering the live MCP tools with edge cases, cross-checked against source —
follow [.agents/skills/live-audit/SKILL.md](.agents/skills/live-audit/SKILL.md).

## Before opening a PR

Run `npm run build && npm test && npm run lint && npm run format:check`.
Update `CHANGELOG.md` (Unreleased section) — see
[.agents/skills/changelog-style/SKILL.md](.agents/skills/changelog-style/SKILL.md)
for entry style.

## Releasing

`package.json` is the single source of truth for the version; `npm version`
bumps + syncs every derived file + tags the release. See
[.agents/skills/release/SKILL.md](.agents/skills/release/SKILL.md) for the
full steps and MCP Registry details.
