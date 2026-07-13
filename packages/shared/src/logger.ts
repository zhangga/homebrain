/**
 * Minimal structured logger. JSON lines to stderr so stdout stays clean for
 * connectors that stream data (e.g. lark-cli piping). Level is controlled by
 * HOMEBRAIN_LOG_LEVEL (debug|info|warn|error), default info.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function threshold(): number {
  const raw = (process.env.HOMEBRAIN_LOG_LEVEL ?? "info").toLowerCase();
  return ORDER[raw as LogLevel] ?? ORDER.info;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function emit(
  level: LogLevel,
  scope: string,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (ORDER[level] < threshold()) return;
  const line = {
    t: new Date().toISOString(),
    level,
    scope,
    msg,
    ...fields,
  };
  process.stderr.write(JSON.stringify(line) + "\n");
}

export function createLogger(scope = "homebrain"): Logger {
  return {
    debug: (m, f) => emit("debug", scope, m, f),
    info: (m, f) => emit("info", scope, m, f),
    warn: (m, f) => emit("warn", scope, m, f),
    error: (m, f) => emit("error", scope, m, f),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

/** Default root logger. */
export const logger = createLogger();
