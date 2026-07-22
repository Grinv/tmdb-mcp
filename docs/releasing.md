# Releasing

`package.json` is the **single source of truth** for the version. The npm
`version` lifecycle hook runs `scripts/sync-version.mjs`, which propagates it to
`src/version.ts`, `manifest.json` and `server.json` (incl. the `.mcpb` release-asset
URL); `version.test.ts` guards that they never drift. `sync-version.mjs` uses
`import.meta.dirname`, so running `npm version` yourself needs Node ≥ 20.11 —
the package's own `engines.node` floor (≥ 20) is unaffected, since the shipped
server never touches this script. So a release is:

```sh
# 1. land your changes; move CHANGELOG.md's [Unreleased] notes under a new
#    [X.Y.Z] - YYYY-MM-DD heading and commit.
npm version <patch|minor|major>   # bumps + syncs every file + commits "release: vX.Y.Z" + tags vX.Y.Z
git push --follow-tags            # pushing the tag triggers .github/workflows/release.yml
```

## Pre-release audit

Before tagging (step 1 above), audit these against the current source — none
of it is version-bump mechanics, so `sync-version.mjs`/`version.test.ts` don't
catch drift here, and it tends to accumulate silently across several PRs:

- **Tool/prompt descriptions** (`src/tools/*.ts`, `src/prompts.ts`) — self-check
  against [docs/tool-descriptions.md](tool-descriptions.md)'s TDQS rubric.
- **`manifest.json`** — its `tools`/`prompts` arrays are a hand-maintained copy
  of the source; check the tool list and every registered prompt's
  (`recommend_similar`, `top_by_entity`, …) `description`/`text` haven't
  drifted from `src/tools/*.ts`/`src/prompts.ts`. `top_by_entity`'s `text`
  branches on `media_type`/`genre`, so re-check it whenever that branching
  logic changes, not just when its wording does.
- **`server.json`** — `packages[].environmentVariables` vs `config.ts` (see
  "Keep config in three places in sync" below) and the top-level `description`
  (≤ 100 chars).
- **`README.md`** — the tool table (any added/renamed/removed tool) and any
  claim about cross-cutting behavior (e.g. which tools accept `language`/
  `region`) against what the schemas actually declare.
- **`AGENTS.md`** — the `src/` tree diagram and any convention that's since
  changed.

The tag push (`v*`) runs the **Release** workflow: `check:api` gate → build → test
→ pack `.mcpb` → GitHub Release → `npm publish` (OIDC trusted publishing, with
provenance — no token) → **publish to the official MCP Registry** (`mcp-publisher`,
GitHub OIDC). Never hand-edit the version in the derived files; bump `package.json`
via `npm version` and let the hook sync the rest.

## MCP Registry

The server is listed at `registry.modelcontextprotocol.io` as
`io.github.Grinv/tmdb-mcp` (`server.json`), exposing **both** packages: the npm
package (`tmdb-mcp`, run via `npx`) and the `.mcpb` GitHub-release bundle.
Ownership is verified per package type:

- **npm** → the `mcpName` field in `package.json` must equal `server.json`'s `name`
  (guarded by `version.test.ts`). It ships in the published package, so it is
  set once and every release just works.
- **mcpb** → `server.json` needs the artifact's `fileSha256`. Because `.mcpb`
  (a zip) isn't byte-reproducible, the release workflow recomputes it from the
  just-packed bundle and injects it before `mcp-publisher publish` — no committed
  value is kept. The asset URL must contain "mcp" (it does).

The namespace `io.github.Grinv/*` is authorized by GitHub OIDC from this repo, so
no registry token/secret is needed. To publish manually instead:
`mcp-publisher login github && mcp-publisher publish`.

**Keep config in three places in sync.** A user-facing env var is declared in
`config.ts` (the source of truth), `manifest.json` `user_config` (the `.mcpb`
install form), and `server.json` `packages[].environmentVariables` (the registry
entry). When you add/rename/remove one in `config.ts`, update the other two —
`version.test.ts` guards that `manifest.json` and `server.json` agree, but it
can't see `config.ts`, so the `config.ts` → descriptors step is on you. Keep
`server.json` descriptions ≤ 100 chars (registry schema cap). Purely internal
tunables (timeouts, cache, rate limits, `LOG_LEVEL`) stay env-only — they don't
belong in the install form or registry entry.
