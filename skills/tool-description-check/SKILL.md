---
name: tool-description-check
description: Self-check a new or edited MCP tool `description`/field `.describe()` text before committing — verify every behavioral claim against live testing or the source, check for contradictions with sibling tools, and score against Glama's Tool Definition Quality Score (TDQS) rubric. Use whenever a tool description or schema field description in src/tools/tmdb/*.ts or src/tools/omdb.ts is added or changed.
---

# Tool descriptions: what to check before committing

Published research on this exact failure mode: [Glama's TDQS
methodology](https://github.com/glama-ai/tool-definition-quality-score) found
97% of 856 tools across 103 real MCP servers have a description defect — 56%
don't clearly state what the tool does, 89% don't say when to use it.
Separately, "From Docs to Descriptions" measured that strong descriptions get
260% more selection in competitive scenarios and lift task success ~6 points.
Bad descriptions aren't a hypothetical risk; they're the median case. This
server is scored on the same rubric at
[glama.ai/mcp/servers/Grinv/tmdb-mcp/score](https://glama.ai/mcp/servers/Grinv/tmdb-mcp/score)
(re-analyzed on Glama's own schedule, not on push — treat this as a manual
pre-commit check, not something to verify live after every edit).

| TDQS dimension          | Weight | Question                                                           |
| ----------------------- | ------ | ------------------------------------------------------------------ |
| Purpose Clarity         | 25%    | Does the description state what the tool does?                     |
| Usage Guidelines        | 20%    | Does it say when to use this tool vs. alternatives?                |
| Behavioral Transparency | 20%    | Does it disclose behavior beyond what annotations already provide? |
| Parameter Semantics     | 15%    | Does it add meaning beyond what the input schema provides?         |
| Conciseness & Structure | 10%    | Is it appropriately sized and front-loaded?                        |
| Contextual Completeness | 10%    | Given the tool's complexity, is the description complete enough?   |

Usage Guidelines and Behavioral Transparency carry the most weight after
Purpose Clarity — double-check those two first on any new or edited tool.

## Two rules that override everything below

1. **No unverified claims.** Every behavioral statement in a description —
   not just "the schema allows this input," which is self-evidently true,
   but "here's what happens when you send it" — must be backed by one of:
   - an in-code comment that already documents a verified-live upstream
     quirk, cited by reference instead of re-asserted from memory (e.g. the
     `verified live against the real /discover/tv` comment above
     `certification`/`TV_TYPES`/`TV_STATUSES` in `src/tools/tmdb/discover.ts`),
     or an existing note in [docs/architecture.md](../../docs/architecture.md)
     or [docs/clients.md](../../docs/clients.md);
   - a fresh live call against the real TMDB/OMDb API made during this
     review, with the actual response observed;
   - direct reading of the exact function implementing the behavior, when
     it's deterministic code logic (e.g. `getEnrichedDetail`'s ratings
     fallback in `src/tools/tmdb/details.ts`) rather than an external API's
     quirk.

   If you can't tick one of these, don't write the claim. This server
   already has a good example of the alternative — doing the verification
   and writing the precise result: `discover_movies`/`discover_tv`'s
   `certification` field distinguishes a hard validation error (missing
   `certification_country`) from a silent no-op (an unrecognized
   `certification_country` "silently disables this filter," confirmed
   against the live API rather than assumed) from an actual empty-result
   match (an unsupported certification value "returns zero results," also
   confirmed live). Collapsing any of those three into one vague "may not
   work as expected" is exactly the kind of claim this rule exists to
   prevent.

2. **No contradictions between tools.** A claim in tool A's description
   about tool B, a shared value, or a shared behavior must match what B
   actually says and does. `get_movie` and `get_movies` cross-reference each
   other ("If you only need the headline info … use get_movies instead");
   `get_movie_recommendations` and `get_similar` do too, in both directions.
   When you edit one description, re-read every sibling description that
   cross-references it or shares its underlying data — fixing A while
   leaving a now-false claim in B is still a bug you introduced this
   session, not a pre-existing one.

## Checklist

### Purpose and when to call it

- State what the tool does **and** when to call it — a trigger condition
  ("call this when the user asks about X"), not just a return-value
  description (a measured effect on newer, tool-call-conservative models,
  per Anthropic's own tool-use guidance — not just style).
- Give the tool itself a clear, specific name — verb + resource
  (`get_tv_season`, not `season`). An agent screens dozens of tool names
  before it ever reads a description; a vague or overlapping name loses the
  match before the description gets a chance to help.
- Name the alternative tool for every pair that could plausibly be confused
  (similar inputs, overlapping domain) — "use X instead of Y when Z" is the
  single highest-leverage fix for this dimension. Make it bidirectional:
  this server already does it for `search_movies`/`search_tv`/
  `search_people` vs. `search_multi`, `get_movie`/`get_tv` vs. their trimmed
  batch counterparts `get_movies`/`get_tv_shows`, and
  `get_movie_recommendations`/`get_tv_recommendations` vs. `get_similar` —
  keep both sides of a pair in sync whenever either changes.
- Don't split one concept across near-duplicate tools, and don't collapse
  unrelated actions into one tool with a mode flag — one tool, one job,
  matching how this project already groups by domain (`tools/tmdb/` vs.
  `tools/omdb.ts`) rather than by raw upstream endpoint.
- When genuinely unsure whether a description will make an agent pick the
  right tool among lookalikes, test it: prompt a fresh model with the
  candidate tools and a representative request (e.g. "what should fans of
  this director's other work watch next" — does it reach for
  `get_person_credits` + `discover_movies`, or misfire on `get_similar`?),
  see what it actually picks, and adjust the text from that observed choice
  — not from how it reads to you. This checks selection _effectiveness_, a
  different failure mode from the fact-_correctness_ rule above.

### Parameter semantics

- Name a field for what it actually accepts, per
  [AGENTS.md](../../AGENTS.md)'s Conventions section — check new fields
  against it and against every sibling tool handling the same concept. This
  file already reuses shared field builders (`tmdbId`, `page`, `language`,
  `region`, `mediaKind`/`mediaType`, …) across every tool that needs them for
  exactly this reason — reuse the existing builder for a concept instead of
  writing a fresh inline schema for it.
- If a field's coverage is already ~100% `.describe()` (this project's
  baseline), don't pad prose restating the schema — TDQS's own rubric caps
  this dimension at 3/5 regardless. Only add text for a genuinely non-obvious
  fact the schema can't express on its own.
- Every numeric range or enum the prose promises must be enforced in the Zod
  schema (`.min()`/`.max()`/`z.enum`) — a described bound with no matching
  constraint is a lie the schema doesn't back up. This server already ties
  the two together (e.g. `min_rating`/`max_rating`'s "0-10, must be <=
  max_rating" is enforced both by `.min()`/`.max()` and by
  `checkDiscoverFilterPairs`'s `superRefine`, not just asserted in prose).
- Mark a field `required` only if the tool genuinely can't work without it,
  and give every optional field a sensible, stated default when it's
  non-obvious — e.g. `get_movie`/`get_tv`'s `include_ratings` defaults to
  `true`, but the batch `get_movies`/`get_tv_shows`'s own `include_ratings`
  defaults to `false`; each description says so explicitly instead of
  leaving the asymmetry to be discovered by trial and error.
- If two fields that look alike are validated differently, say so — e.g.
  `discover_tv` treats `with_cast`/`with_crew`/`with_people` as a hard
  schema-validation error (rejected outright for TV) specifically because
  TMDB's own `/discover/tv` would otherwise silently ignore them, which is a
  different failure mode from `certification_country`, where an unrecognized
  value is a silent no-op (filter disabled) rather than an error or an empty
  match. Without this, "no results," "filter ignored," and "invalid input"
  are indistinguishable to the caller.

### Behavioral transparency

- This server's tools are all reads today — every registered tool carries
  `annotations: READ_ONLY` (`src/tools/shared.ts`); there are no mutation
  tools yet. If one is ever added, apply the fuller rigor
  `anilist-mcp-server`'s sibling skill uses for its write tools (full-replace
  vs. partial-merge at the exact field, upsert-vs-reset semantics,
  positional-matching hazards) rather than assuming a lighter bar just
  because this checklist doesn't spell those out.
- Distinguish "genuinely zero results" from "silently filtered out by a
  bad/unrecognized input" wherever TMDB doesn't error on a mismatch — this
  server already does this well for `certification`/`certification_country`
  (see above) and for `get_movies`/`get_tv_shows`'s per-id batch behavior (a
  bad/unknown id comes back as `{id, found:false, reason}` in place, rather
  than failing the call or silently dropping that entry — the response
  stays the same length and order as the input `ids`). Apply this
  **consistently across every sibling field of the same shape** — if one
  filter needs this caveat, every other field with the identical underlying
  behavior needs the same sentence, not just the one you happened to test
  first.
- A caveat copied from one tool to a similar-looking sibling must be
  re-verified against _that specific tool's_ actual code path, not assumed
  to transfer as-is — e.g. `get_movie`/`get_tv`'s `ratings` degrade-to-
  `{found:false, reason}` behavior and the standalone `get_ratings` tool
  (`src/tools/omdb.ts`) both wrap the same `OmdbClient`, but `get_ratings`
  additionally accepts a raw `title` lookup with no `imdb_id` at all — check
  that path's own match/no-match behavior independently instead of assuming
  it degrades identically to the `imdb_id`-only path the other two use.
  Even *identical* shared code (e.g. `get_movie_credits`/`get_tv_credits`
  both filter through `summarizeCredits()`'s same `KEY_JOBS`) can still
  diverge per media type because the upstream data itself differs — verify
  each variant live rather than trusting shared code as proof of shared
  behavior (found live: TMDB's `/tv/{id}/credits` crew never carries
  "Director"/"Writer"/"Creator" the way `/movie/{id}/credits` does).
- Disclose the return shape's real substance, not just the auth/key caveat —
  fixed caps, ordering, and which nested fields a specific tool omits that a
  same-shaped sibling includes. This server already does this precisely
  (`get_movie_credits`/`get_tv_credits`'s "top-billed cast (up to 20)",
  `get_person_credits`'s 25-per-side cap and "a title with several crew
  jobs … still only counts once against the crew cap", `get_tv_season`'s
  50-episode cap with `episode_count` still reporting the true total) —
  match that level of detail for any new or edited tool, not just the
  top-level description's opening sentence.
- Never claim a capability the schema doesn't wire up, and never contradict
  an annotation — a description implying a side effect a `readOnlyHint:
true` tool doesn't have is an automatic failure on this dimension.

### Conciseness, title, and structure

- Front-load the single most important fact (what + when) in the first
  sentence — a caller reads the opening far more reliably than the tail of a
  long description. Keep total length proportional to actual complexity: one
  sentence for a simple lookup (`get_movie_genres`), several for a
  filter-heavy tool with real caveats (`discover_movies`/`discover_tv`) —
  don't pad either direction.
- Keep `title` a short, literal human label — it's the UI-facing name, not a
  second description; don't duplicate `description`'s content there or leave
  it vaguer than the tool's own name.

## Verify, then fix the implementation before dumbing down the description

When a true fact would make a description more useful but the code doesn't
actually do it yet (e.g. a field the description could confidently promise
if the client computed it), prefer fixing the implementation to match the
better description over writing a weaker, technically-safe sentence — as
long as the fix is small, deterministic, and doesn't change any other
observable behavior. Only fall back to narrowing the claim when the fix
would be a real feature addition, not a one-line gap-filler.

## Full spec

The [repo README](https://github.com/glama-ai/tool-definition-quality-score)
is the complete TDQS methodology: scoring pipeline, exact LLM prompts
(Appendix A), calibration examples, and weight formulas. Read it once for
calibration examples if an edit isn't clearly hitting 4-5 on the dimension
you're targeting.

## Keep this checklist honest against drift

This is an incremental, diff-based check by design — "new or edited"
descriptions — which means a rule added here today says nothing about
whether _already-registered_ tools already violate it. A sibling repo in
this project family (anilist-mcp-server) found exactly that gap live: its
"never contradict an annotation" rule (an `idempotentHint: true` tool whose
own description says a repeat call errors, not no-ops) was added in a fix
commit that corrected _other_ tools' descriptions — but the delete-tool
annotations that rule was written to catch were never rechecked against it
at the same time, and stayed wrong from the very first release through
several audits after.

- **A new or tightened rule here implies an immediate retroactive sweep, not
  just future guidance.** When you add or tighten a rule in this file, run
  it against every currently registered tool (not just the one you're
  editing) before considering the update done, and fix what it finds in the
  same pass.
- **Periodically run this whole checklist as a full sweep**, not only on
  new/edited descriptions — e.g. before a release, or whenever asked for a
  broader audit — since incremental diff-based checking alone lets an
  already-registered tool drift out of compliance forever once nobody edits
  it again.
