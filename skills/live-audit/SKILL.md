# live-audit — tmdb-mcp health check + edge-case hunt

Repo-specific playbook, for any agent/model working on this repo (not tied to
a particular harness — see `AGENTS.md`'s own framing). Use it when asked to
test/audit/smoke-test the published tmdb-mcp package, hunt for bugs or edge
cases, or repeat "the same kind of testing as before."

Goal: find real bugs/inaccuracies in the **currently published** tmdb-mcp
package (not just "does it build") by actually calling its live MCP tools the
way a downstream agent would, then fixing what's found. Read `AGENTS.md` first
if it's not already in context — every fix and every CHANGELOG entry must
follow its conventions (`.strict()` schemas, shaper/schema 1:1, description
style, commit author/no-Co-Authored-By, etc.).

This assumes the server is already reachable as an MCP connection in your
current session (however your harness exposes that — e.g. as `mcp__tmdb__*`
tools in Claude Code). If it isn't connected, connect it first (see
`README.md`'s client-setup section) rather than skipping straight to step 1.

## 0. Confirm "published" actually means HEAD

```sh
node -p "require('./package.json').version"; npm view tmdb-mcp version; git log --oneline -5
```

If they match, live-testing the running tools _is_ testing the published
package. If they don't, say so before proceeding — findings would apply to
unreleased code, not what users actually have.

## 1. Static pass first (cheap, catches regressions before you burn API calls)

```sh
npm run build && npm test && npm run lint && npm run format:check
```

All green is a **baseline, not proof of correctness** — it only confirms
nothing already-covered regressed. It says nothing about whether the
interesting logic (error/exception branches especially) is covered at all —
a line can execute inside a test without the test actually asserting on the
specific thing that matters (e.g. a test that triggers a validation error
but only checks "isError: true", never the actual message text). When
reviewing or writing tests as part of this audit, ask: does a test exist
that deliberately triggers this error path, and does it assert on the
_specific_ resulting message/shape?

Anything red here is the actual finding — stop and report it before moving
to live testing.

## 2. Live edge-case sweep

Batch independent tool calls together where your harness supports it — this
is slow one-at-a-time. Needs `TMDB_API_TOKEN` and ideally `OMDB_API_KEY` set
(`env | grep -iE 'tmdb|omdb'`) so ratings-enrichment paths are actually
exercised, not just the "not configured" branch.

Work through this checklist — adapt ids/tools to whatever's currently
registered (`grep -n 'registerTool(' src/tools/*.ts`), don't just replay last
run's exact calls verbatim:

- **Input validation boundaries**: empty string where `.min(1)` is expected,
  negative/zero/decimal ids where a positive int is expected, `page` at 0/501,
  arrays at their `.min()`/`.max()` boundary and one past it (batch `ids`),
  unknown/misspelled param name (should hard-reject — every `inputSchema` is
  `.strict()` per AGENTS.md, so a typo must error, not silently no-op).
- **Format-validated strings**: malformed `region`/`language`/`imdb_id`/date
  params — not just wrong length, but wrong _shape_ (e.g. `en_US` instead of
  `en-US`, `usa` instead of `US`). Check every such param against its sibling
  params for a validation asymmetry (one has a `.regex()`, another
  conceptually-identical one doesn't) — that asymmetry is exactly how the
  `language`/`TMDB_LANGUAGE` bug was found.
- **Cross-field pairing rules**: filters that TMDB silently no-ops on when a
  required partner field is missing (`certification`+`certification_country`,
  `with_watch_providers`+`watch_region`, `min_rating`>`max_rating`) — these
  must error via the tool's own validation, not reach TMDB and look like "the
  filter was applied" when it wasn't.
- **Not-found / empty-result paths**: nonexistent-but-well-formed ids (movie,
  TV, person, collection, keyword), a batch call mixing valid + invalid +
  duplicate ids, a search query returning zero results, a title genuinely
  missing an `imdb_id`/ratings/overview.
- **Payload-size risk**: any tool that aggregates across a variable-size
  collection (multi-season episode dumps, long person filmographies, wide
  discover pages) — pick the largest real-world instance you can think of
  (most-seasons TV show, most-credited person) and check the actual response
  size/token count, not just that it returns _something_. A stated cap
  (`MAX_EXPANDED_EPISODES` etc.) bounding _count_ doesn't mean the _payload_ is
  actually small — a heavy per-item field (e.g. `overview`) can still blow it
  up, exactly like the `expand_episodes` bug.
- **Documented vs. actual shape**: for anything that looked surprising live,
  grep the field back to its `.describe()` text — does the tool's own
  description promise what you just saw (or promise something you didn't)?
  Mismatches here are bugs even when the data itself is "correct."
- **Unicode / adult / locale weirdness**: emoji-only queries, non-Latin
  scripts, `include_adult` toggling, a fake 2-letter region/language that's
  shaped correctly but doesn't exist.
- **Live prompt testing** (`src/prompts.ts`) — a static read comparing prompt
  text against tool names/params misses argument-handling bugs (found this
  way in a sibling repo: a prompt silently dropped one of two independent
  optional filters whenever it was given without the other, because its
  branching logic wrongly required both together). Actually render every
  prompt through the real MCP protocol: `npx @modelcontextprotocol/inspector
--cli node dist/index.js --method prompts/list`, then `--method
prompts/get --prompt-name <name> --prompt-args key=value key2=value2`
  (space-separated `key=value` pairs, NOT a JSON blob — the CLI rejects JSON
  with "Invalid parameter format"). For each prompt: no args, only one
  optional arg at a time, and all of them together — an arg that's
  individually optional can still break when given alone.

For anything that looks like a bug, **don't stop at the symptom** — grep the
source for the actual mechanism (the const/regex/cap that produced it) before
calling it a finding. A live response that merely _looks_ odd but ties back to
correct, intentional code isn't a finding.

## 3. Docs/metadata consistency

Check every one of these, not just a sample:

- `README.md`'s tool table matches `src/tools/*.ts`'s registrations (names,
  and any auth/token-requirement column against what each tool actually
  needs).
- `manifest.json`'s and `server.json`'s `tools` arrays list the same tool
  **names** as what's actually registered — treat a test failure here as
  authoritative if one exists. Their `description` fields are deliberately
  short, independent marketing-style summaries, NOT a copy of the tool's
  full `.describe()`/`description` text in `src/tools/*.ts` — don't "fix"
  them to match verbatim, that's not a bug. Do re-read them for accuracy if
  a tool's _behavior_ changed in a way the short summary now misrepresents.
- Tool `description`/field `.describe()` text in `src/tools/*.ts` itself:
  does it still match the actual `inputSchema`/`outputSchema` and the
  client function's real behavior?
- `CHANGELOG.md`'s `[Unreleased]` section (see `docs/changelog-style.md` for
  entry style) has one line per real behavior change made in this pass — add
  missing entries, don't just flag them as missing.
- Any `docs/*.md` documenting upstream API quirks (`docs/architecture.md`,
  etc.) still matches the current client code, especially any claim this
  pass's own fixes just invalidated.
- `AGENTS.md`'s project-shape/file-tree description still matches the
  filesystem.
- `docs/clients.md` and any other `docs/*.md` for stale phrasing (e.g.
  describing something as "once published"/"upcoming" that already
  shipped).

## 4. Report, then fix only what's confirmed

Rank findings by severity. For each: what's wrong, concrete repro (exact tool
call + params), the file/line causing it, and the fix shape. Silence on a
category you didn't get to (rather than implying full coverage) beats a false
"all clear."

If asked to fix: implement the smallest correct change, add/extend a test in
the matching `src/__tests__/*.test.ts` (mirror the existing test's style in
that file — don't invent a new assertion pattern), then re-run the full
`build && test && lint && format:check` gate before calling it done.

**Note:** the running MCP server is a separate process from your edit — it
won't pick up source changes until restarted. Verify a fix via the unit test
suite, not by re-calling the live tool against unrestarted code.

## 5. Commit + changelog, if asked

Follow the pattern already in `git log`: one `fix:`/`feat:` commit per
logically distinct change (don't bundle two unrelated fixes into one commit),
then a separate `docs:` commit adding an `## [Unreleased]` section to
`CHANGELOG.md` (style: `docs/changelog-style.md`) with one bullet per fix,
each linking that fix commit's short sha
(`https://github.com/Grinv/tmdb-mcp/commit/<7-char-sha>`). Author/committer
`Grinv <4070730+Grinv@users.noreply.github.com>`, **no** `Co-Authored-By`
trailer (project override of the usual default). Don't push unless explicitly
asked.
