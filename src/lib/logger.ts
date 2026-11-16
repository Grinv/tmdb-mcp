// Minimal leveled logger. Writes to stderr only (stdout is the MCP stdio
// protocol) and redacts credentials.
import { redact } from "./errors.ts";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export function createLogger(level: LogLevel): Logger {
  const threshold = ORDER[level];

  function emit(lvl: Exclude<LogLevel, "silent">, msg: string, args: unknown[]): void {
    if (ORDER[lvl] < threshold) return;
    const extra = args.length ? " " + redact(args.map((a) => safeString(a)).join(" ")) : "";
    const text = `${redact(msg)}${extra}`;
    console.error(`[tmdb-mcp] ${lvl}: ${text}`);
  }

  return {
    debug: (m, ...a) => emit("debug", m, a),
    info: (m, ...a) => emit("info", m, a),
    warn: (m, ...a) => emit("warn", m, a),
    error: (m, ...a) => emit("error", m, a),
  };
}

// `seen` stops a cause chain that loops back on itself (a.cause = b,
// b.cause = a) from recursing until the logger itself throws.
function safeString(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === "string") return value;
  // The stack (it opens with "Name: message") and cause chain are the only
  // diagnostics: internal errors are logged, not shown to the agent
  // (toProblem in lib/result.ts). emit() redacts the joined text.
  if (value instanceof Error) {
    seen.add(value);
    const cause =
      value.cause === undefined
        ? ""
        : seen.has(value.cause)
          ? "\ncaused by: (cycle)"
          : `\ncaused by: ${safeString(value.cause, seen)}`;
    return `${value.stack ?? `${value.name}: ${value.message}`}${cause}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
