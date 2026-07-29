---
name: docs-consistency-check
description: Check README/manifest.json/server.json/CHANGELOG.md/AGENTS.md and docs/*.md for drift against the actual registered tools and source. Use after adding, renaming, or removing a tool, or as part of a live-audit pass.
---

# Docs/metadata consistency

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
  client function's real behavior? Cross-check new/edited descriptions
  against the `tool-description-check` skill (Glama's TDQS rubric).
- `CHANGELOG.md`'s `[Unreleased]` section (see the `changelog-style` skill for
  entry style) has one line per real behavior change made in this pass — add
  missing entries, don't just flag them as missing.
- Any `docs/*.md` documenting upstream API quirks (`docs/architecture.md`,
  etc.) still matches the current client code, especially any claim this
  pass's own fixes just invalidated.
- `AGENTS.md`'s project-shape/file-tree description still matches the
  filesystem — including every `docs/*.md`/`skills/*/SKILL.md` link it
  points to (a doc move/rename, e.g. `docs/*.md` → `skills/*/SKILL.md`,
  easily strands an old path — grep every `docs/`/`skills/` link target and
  confirm the file exists).
- `docs/clients.md` and any other `docs/*.md` for stale phrasing (e.g.
  describing something as "once published"/"upcoming" that already
  shipped).
- `PRIVACY.md` and `SECURITY.md`: re-verify every specific claim against the
  actual current code, don't just skim for plausibility — which credentials
  exist and how each is transmitted/redacted, what is and isn't cached (incl.
  cache key/TTL), the current list of read-only vs. write/mutating tools, and
  any host-allowlist statement. This class of drift is easy to miss because
  it reads fine on its own and only breaks against the code: a sibling repo's
  `SECURITY.md`/`PRIVACY.md` both claimed "player-specific data is never
  cached" after a later feature added exactly that caching, and a separate
  claim conflated an actually-cached field with a similarly-named
  never-cached one — neither doc was self-evidently wrong, both required
  re-reading the client code to catch. Also confirm `README.md` links both
  (a `## Privacy Policy`/`## Security` section pointing at them) — adding
  either file doesn't make it discoverable on its own, and this repo's own
  `SECURITY.md` shipped with no README link at all until this exact check
  caught it.
