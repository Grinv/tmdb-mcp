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
  format.ts       # raw TMDB/OMDb payloads → trimmed, agent-facing shapes
  prompts.ts      # MCP Prompts: multi-step plans that guide the model through the tools
  lib/            # GENERIC carcass: http, rateLimit, cache, upstream, errors, logger, result
  clients/        # tmdb.ts (backbone reads), omdb.ts (ratings enrichment)
  tools/          # tmdb.ts (search/details/credits/…, OMDb enrichment), omdb.ts (get_ratings),
                  # shared.ts (READ_ONLY, requireConfigured — try/catch → ToolResult)
  __tests__/      # node:test (*.test.ts) + helpers.ts
scripts/          # build-tests.mjs, run-tests.mjs (generic), check-api.mjs (domain)
```

## Commands

```sh
npm run build          # tsc --noEmit + tsup → dist/index.js (single ESM bundle)
npm test               # build tests with esbuild, run with node:test
npm run test:coverage  # same, with coverage (gate: ~80%)
npm run lint           # eslint
npm run format         # prettier --write
npm run check:api      # live upstream health-check (needs TMDB_API_TOKEN; OMDb check skipped without OMDB_API_KEY)
npm run inspector      # run under the MCP Inspector
```

## Conventions

- **Docs and in-code text are English** (README, docs, comments, tool
  descriptions, error messages).
- Runtime floor is **Node ≥ 20** (global `fetch`, stable `node:test`); tsup
  targets `node20`. (Contributors running `npm version` need Node ≥ 20.11 —
  see [docs/releasing.md](docs/releasing.md).)
- Log to **stderr only** — stdout is the MCP protocol channel. Use the logger;
  it redacts credentials.
- Tool failures return `{ isError: true }` results (via `requireConfigured()` /
  `result.ts`), never thrown — the agent should get an actionable message.
- Mocked-`fetch` test fixtures must mirror the real upstream response shape
  for that exact endpoint, not just whatever fields make the current code
  pass — see [docs/testing.md](docs/testing.md).
- Keep clients fetch+cache only; all raw→agent-facing shaping lives in
  `src/format.ts`. Trim responses for token efficiency.
- Write tool `description`s and per-field `.describe()` text for the calling
  model: explain when to use a tool and what each parameter means. Check new
  or edited descriptions against [docs/tool-descriptions.md](docs/tool-descriptions.md)
  (Glama's TDQS rubric) before committing.
- Keep dependencies minimal. New deps need a clear justification (supply-chain).
  In particular, do **not** pull in a third-party TMDB SDK — the `lib/` carcass
  already covers retries/cache/rate-limiting, and we shape responses ourselves.
- **Never commit secrets.** Tokens come from env vars / OS keychain only.
- Cross-platform: macOS, Linux and Windows. Avoid POSIX-only shell in npm
  scripts (use the Node helper scripts).
- **Commits:** author/committer `Grinv <4070730+Grinv@users.noreply.github.com>`;
  do **not** add a `Co-Authored-By` trailer.

## Before opening a PR

Run `npm run build && npm test && npm run lint && npm run format:check`.
Update `CHANGELOG.md` (Unreleased section) — see
[docs/changelog-style.md](docs/changelog-style.md) for entry style.

## Releasing

`package.json` is the single source of truth for the version; `npm version`
bumps + syncs every derived file + tags the release. See
[docs/releasing.md](docs/releasing.md) for the full steps and MCP Registry details.
