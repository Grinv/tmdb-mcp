// Bin entry point. tsdown prepends the `#!/usr/bin/env node` shebang.
import { createLogger } from "./lib/logger.ts";
import { start } from "./server.ts";

start().catch((err: unknown) => {
  // Fatal startup error (e.g. an invalid config). The configured logger may not
  // exist yet, so use a fresh one at error level: it formats the stack, cause
  // chain and redaction.
  createLogger("error").error("fatal:", err);
  process.exit(1);
});
