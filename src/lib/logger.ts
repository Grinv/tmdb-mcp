// Minimal leveled logger. Writes to stderr only (stdout is the MCP stdio
// protocol) and redacts credentials.
import { inspect } from "node:util";
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

// util.inspect prints an error with its stack, own fields (an ApiError's code
// and status, a system error's ECONNRESET), cause chain and AggregateError
// errors, and survives cycles. Internal errors are shown only here, never to
// the agent (toProblem in lib/result.ts). emit() redacts the joined text.
function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  // A value's own [inspect.custom] may throw; the logger must not (it runs
  // inside the process's last-resort error handlers).
  try {
    return inspect(value, { depth: 6, breakLength: Infinity });
  } catch {
    try {
      return String(value);
    } catch {
      return "[unprintable value]";
    }
  }
}
