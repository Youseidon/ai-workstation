type Level = "info" | "warn" | "error" | "debug";

const debugEnabled = ["1", "true", "yes"].includes(
  (process.env.DEBUG ?? "").toLowerCase(),
);

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (level === "debug" && !debugEnabled) return;
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${message}`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) stream(line);
  else stream(line, extra);
}

export function createLogger(scope: string) {
  return {
    info: (message: string, extra?: unknown) => emit("info", scope, message, extra),
    warn: (message: string, extra?: unknown) => emit("warn", scope, message, extra),
    error: (message: string, extra?: unknown) => emit("error", scope, message, extra),
    debug: (message: string, extra?: unknown) => emit("debug", scope, message, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;
