// Bin entry point. tsup prepends the `#!/usr/bin/env node` shebang.
import { redact } from "./lib/errors.ts";
import { start } from "./server.ts";

start().catch((err: unknown) => {
  // Fatal startup error: report on stderr and exit non-zero. This runs before
  // the logger exists, so redact() is applied here directly — the only thing
  // that throws this early is loadConfig(), whose message never includes an
  // env-var value, but we redact anyway for defense-in-depth.
  process.stderr.write(
    `[tmdb-mcp] fatal: ${redact(err instanceof Error ? err.message : String(err))}\n`,
  );
  process.exit(1);
});
