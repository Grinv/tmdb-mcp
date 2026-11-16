// Minimal leveled logger. Writes to stderr only (stdout is the MCP stdio
// protocol) and redacts credentials.
import { ApiError, redact } from "./errors.ts";

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

// A bug (any error but ApiError) is logged with its stack, the only clue to
// where it happened (toProblem in lib/result.ts). A classified ApiError is
// always raised in lib/http.ts, so its stack says nothing: it gets one line
// with its code and status. Causes get one line each (`name: message`, plus a
// system error's code such as ECONNRESET). `seen` stops a cause chain that
// loops back on itself. emit() redacts the joined text.
function safeString(value: unknown, seen = new Set<unknown>(), outermost = true): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    seen.add(value);
    const cause =
      value.cause === undefined
        ? ""
        : seen.has(value.cause)
          ? "\ncaused by: (cycle)"
          : `\ncaused by: ${safeString(value.cause, seen, false)}`;
    return `${headline(value, outermost)}${cause}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function headline(err: Error, outermost: boolean): string {
  if (err instanceof ApiError) {
    const status = err.status === undefined ? "" : ` ${err.status}`;
    return `${err.name} [${err.code}${status}]: ${err.message}`;
  }
  if (outermost && err.stack) return err.stack;
  const code = (err as { code?: unknown }).code;
  return `${err.name}${typeof code === "string" ? ` [${code}]` : ""}: ${err.message}`;
}
