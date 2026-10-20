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

**Hard rule — do not skip ahead:** if your harness has a task/todo tool, create
one task per numbered step below (0-5) plus one per bullet under step 2's
checklist and step 3's list, before doing anything else, and mark each
complete only when actually done. The failure mode this guards against is
real: finding a bug mid-step-2 and immediately jumping to fix it, leaving
step 3 (docs/metadata consistency) half-done and unreported. Step 3 is not
optional polish — a real fix from step 2 routinely has stale echoes
elsewhere (a tool's own `.describe()` text repeating an old constant,
`manifest.json`'s hand-maintained `tools`/`prompts` copy per
`.agents/skills/release/SKILL.md`, a comment in `docs/*.md`) that step 2 alone will never
surface. A fix isn't done until every one of its echoes is updated too —
finish step 3 in full before step 4's report, every single time.

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

This server supports two MCP protocol eras (legacy 2025-era and 2026-07-28).
The in-memory unit-test transport (`connectServer` in `helpers.ts`) can only
ever bind the legacy era — only `serveStdio`, i.e. the real spawned bundle
in `e2e.test.ts`, can prove modern-era behavior (protocol negotiation, real
tool-call round-tripping, `cacheHints`/`ttlMs`/`cacheScope` on `tools/list`/
`prompts/list`/`server/discover`, `_meta['io.modelcontextprotocol/serverInfo']`).
Any era-specific server-construction change (`ServerOptions` fields,
capability wiring, anything touching `buildServer()`) needs a matching
`e2e.test.ts` assertion under `versionNegotiation: { mode: "auto" }` — not
just "the negotiation itself still succeeds," but the actual field/behavior
that changed, verified via a passthrough `z.record()` schema on
`client.request()` where the typed result hides it (`StripWireOnly` fields
like `ttlMs`/`cacheScope`).

## 2. Live edge-case sweep

Batch independent tool calls together where your harness supports it — this
is slow one-at-a-time. Needs `TMDB_API_TOKEN` and ideally `OMDB_API_KEY` set
(`env | grep -iE 'tmdb|omdb'`) so ratings-enrichment paths are actually
exercised, not just the "not configured" branch.

Work through this checklist — adapt ids/tools to whatever's currently
registered (`grep -n 'registerTool(' src/tools/*.ts`), don't just replay last
run's exact calls verbatim:

- **Input validation boundaries**: empty string where `.min(1)` is expected,
  negative/zero/decimal ids where a positive int is expected, `page` at 0/501
  (and on output, no `total_pages` above 500 — TMDB itself reports 1001),
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
  filter was applied" when it wasn't. List separators too: TMDB reads `,` as
  AND and `|` as OR in `with_*` (`with_watch_providers` `8,9` → 0, `8|9` → 73).
- **The same fact from two tools must agree.** Ratings reach the caller by more
  than one path and a per-tool sweep passes while the paths disagree, because
  each answer looks reasonable alone. `get_movie`/`get_tv` fold OMDb in **by
  `imdb_id`**, while `get_ratings` resolves by **title (+year)** when given no id
  (`src/tools/omdb.ts`) — and a title lookup can land a different film of the
  same name. Call both for one film (one by id, one by title alone) and diff the
  numbers; pick a remake or a same-title pair where the title path is most likely
  to pick wrong. Second pairing, in a single response: `vote_average` is TMDB's
  own 0–10 while `ratings.*` are IMDb/RT/Metacritic on other scales entirely, and
  `search_*`/`discover_*`/`get_trending` carry only the former. Check that no
  `.describe()` invites comparing across the two, and grep for either family
  named as the other — in `src/format.ts`'s shapers _and_ in every tool
  `description`/`.describe()`, where the miss is likelier (found live:
  `get_tv_season`/`get_tv_episode`/`expand_episodes` all promised episode
  "ratings" while returning only TMDB `vote_average`). Third: an aggregate
  endpoint vs. its per-part one (`/tv/{id}/credits` was exactly the final
  season's cast — The Office without Steve Carell).
- **Not-found / empty-result paths**: nonexistent-but-well-formed ids (movie,
  TV, person, collection, keyword), a batch call mixing valid + invalid +
  duplicate ids, a search query returning zero results, a title genuinely
  missing an `imdb_id`/ratings/overview, an unreleased one (TMDB sends unknown
  as `0`: `vote_average`/`vote_count`/`runtime`), a collection with an undated
  announced part (`release_date: ""`), and a bad `OMDB_API_KEY` (the reason must
  name the 401, not a generic failure).
- **Payload-size risk**: any tool that aggregates across a variable-size
  collection (multi-season episode dumps, long person filmographies, wide
  discover pages) — pick the largest real-world instance you can think of
  (most-seasons TV show, most-credited person) and check the actual response
  size/token count, not just that it returns _something_ — and read its top
  rows (a `character: 'Self'` filter let blank-character talk-show spots lead;
  an id-only dedupe dropped Hellboy, whose movie id 1487 equals a TV id). A stated cap
  (`MAX_EXPANDED_EPISODES` etc.) bounding _count_ doesn't mean the _payload_ is
  actually small — a heavy per-item field (e.g. `overview`) can still blow it
  up, exactly like the `expand_episodes` bug.
- **Documented vs. actual shape**: for anything that looked surprising live,
  grep the field back to its `.describe()` text — does the tool's own
  description promise what you just saw (or promise something you didn't)?
  Mismatches here are bugs even when the data itself is "correct." Eyeball
  raw strings too: TMDB pads some (`"K-8 "`, `"VIX "`). When an
  aggregation shortcut skips fetching some items entirely instead of
  fetching-then-trimming (e.g. a season past a combined-count budget never
  requested at all), check _every_ field of that stub, not just the one the
  cap is named after — unrelated fields (`overview`, `poster_url`) silently
  going null is exactly the kind of thing a "count capped at N" description
  never warns about, and a nearby test comment asserting "same contract as a
  trimmed item" can be flat wrong without a test actually failing.
- **Claims about upstream behavior, wherever they live**: a `.describe()` is
  not the only place this repo asserts "TMDB does X" — source comments,
  test comments and CHANGELOG entries justify guards the same way, and none
  of them is checked by any test. When a live call exercises a guard's
  scenario, verify the stated _reason_ for the guard too, not just that the
  guard fires. A real miss: three separate places claimed TMDB "silently
  ignores an unparseable id and applies no filter at all", while
  `with_genres="action"`, `with_companies="pixar"` and
  `with_watch_providers="netflix"` each return `total_results:0` — the
  opposite failure mode, and one an existing CHANGELOG entry for a sibling
  filter had already described correctly. Grep a corrected claim across
  `src/**`, `src/__tests__/**` and `CHANGELOG.md`; it is rarely written down
  only once.
- **Unicode / adult / locale weirdness**: emoji-only queries, non-Latin
  scripts, `include_adult` toggling, a fake 2-letter region/language that's
  shaped correctly but doesn't exist (`ZZ` → empty, but `XX` is a real TMDB
  pseudo-region). A non-English `TMDB_LANGUAGE` and a non-English-original
  title: `language` can _filter_, not translate (videos: 29 → 2 under `de-DE`).
- **Upstream params vs. our own filtering**: for each endpoint, diff the query
  params in TMDB's OpenAPI spec (`developer.themoviedb.org/openapi/tmdb-api.json`
  — incomplete, so confirm live) against what the client sends; for every
  client-side filter/sort/cap, test whether the endpoint does it itself. Also
  check cache keys: a dimension that only changes shaping (`region`,
  `department`, `limit`) must not key the cache — cache raw, shape per call.
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
  individually optional can still break when given alone. For an enum-valued
  arg (e.g. `media_type: "movie" | "tv"`), render **every** value, not just
  one — each can take a genuinely different branch in the prompt's own
  step-building logic. Missing this exact gap is how a real bug got past a
  prior live-audit pass in this repo: `media_type=movie` rendered fine, but
  `media_type=tv` left a dangling reference to a step ("the equivalent movies
  filter") that only exists in the movies branch — caught later by a
  `/code-review` pass, not by live-audit, because only one enum value had
  actually been rendered here.

For anything that looks like a bug, **don't stop at the symptom** — grep the
source for the actual mechanism (the const/regex/cap that produced it) before
calling it a finding. A live response that merely _looks_ odd but ties back to
correct, intentional code isn't a finding.

## 3. Docs/metadata consistency

Run the `docs-consistency-check` skill in full — it's the single source of
truth for this checklist (README's tool table, manifest.json/server.json's
`tools` arrays, tool `.describe()` text, CHANGELOG's `[Unreleased]` section,
`docs/*.md` staleness, AGENTS.md's project-shape description, and
`PRIVACY.md`/`SECURITY.md` accuracy against the current code). Don't rely on
a stale inline copy of it here — this section used to duplicate that
checklist verbatim and drifted (it still pointed at a `docs/changelog-style.md`
that had since moved to `.agents/skills/changelog-style/SKILL.md`), which is
exactly the kind of drift `docs-consistency-check` itself exists to catch.

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

**When the bug is "we read the wrong source for a fact", measure how often the
wrong one is actually wrong before switching sources — and check what the
replacement gets wrong.** Generalizing from the one example that exposed the bug
produces a worse bug. Found in steam-games-mcp, whose two price sources this
cost two wrong fixes: over a 500-item sample (421 priced), the legacy source was
wrong for 2 while the "modern" one answered with a multi-game bundle's price for
5, so the obvious "use the newer API" swap broke more than it fixed. Sample a few
hundred ids, diff the two sources, and read the disagreements one by one — they
are usually several distinct causes wearing one symptom, needing a rule rather
than a swap.

**Measure the cost you cite to justify a design, in the unit that matters.** In
the same repo a narrow follow-up request was justified on payload size (~2.2 KB →
~10.2 KB per item) with nobody timing it; measured interleaved, asking up front
cost ~+40 ms on a 50-item batch — inside run-to-run noise — against ~+300 ms for
the extra round-trip, so the "optimization" was a pessimization plus an extra
failure path. Interleave the A/B runs (5 each, compare medians AND minimums):
sequential blocks drift enough on these APIs to invent a difference that isn't
there.

## 5. Commit + changelog, if asked

Follow the pattern already in `git log`: one `fix:`/`feat:` commit per
logically distinct change (don't bundle two unrelated fixes into one commit),
then a separate `docs:` commit adding an `## [Unreleased]` section to
`CHANGELOG.md` (style: `.agents/skills/changelog-style/SKILL.md`) with one bullet per fix,
each linking that fix commit's short sha
(`https://github.com/Grinv/tmdb-mcp/commit/<7-char-sha>`). Author/committer
`Grinv <4070730+Grinv@users.noreply.github.com>`, **no** `Co-Authored-By`
trailer (project override of the usual default). Don't push unless explicitly
asked.
