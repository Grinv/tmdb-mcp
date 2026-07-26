---
name: prompt-check
description: Live-test every MCP Prompt in src/prompts.ts through the real MCP protocol (not a static read) across every argument combination, including every enum value. Use when a prompt is added or its argument-handling logic changes, or as part of a live-audit pass.
---

# Prompt check — live-test every MCP Prompt argument combination

A static read comparing prompt text against tool names/params misses
argument-handling bugs (found this way in a sibling repo: a prompt silently
dropped one of two independent optional filters whenever it was given
without the other, because its branching logic wrongly required both
together). Actually render every prompt through the real MCP protocol:

```sh
npx @modelcontextprotocol/inspector --cli node dist/index.js --method prompts/list
npx @modelcontextprotocol/inspector --cli node dist/index.js --method prompts/get \
  --prompt-name <name> --prompt-args key=value key2=value2
```

`--prompt-args` takes space-separated `key=value` pairs, **not** a JSON blob
— the CLI rejects JSON with "Invalid parameter format".

For each prompt: no args, only one optional arg at a time, and all of them
together — an arg that's individually optional can still break when given
alone.

**For an enum-valued arg** (e.g. `media_type: "movie" | "tv"`), render
**every** value, not just one — each can take a genuinely different branch
in the prompt's own step-building logic. Missing this exact gap is how a
real bug got past a prior live-audit pass in this repo: `media_type=movie`
rendered fine, but `media_type=tv` left a dangling reference to a step ("the
equivalent movies filter") that only exists in the movies branch — caught
later by a `/code-review` pass, not by live-audit, because only one enum
value had actually been rendered here.
