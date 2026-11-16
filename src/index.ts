// Bin entry point. tsdown prepends the `#!/usr/bin/env node` shebang.
import { createLogger } from "./lib/logger.ts";
import { start } from "./server.ts";

start().catch((err: unknown) => {
  // Fatal startup error (e.g. an invalid config): report it and exit non-zero.
  // The configured logger may not exist yet, but formatting an error (stack,
  // cause chain, redaction) is the logger's job, so use one at error level.
  createLogger("error").error("fatal:", err);
  process.exit(1);
});
