// File logger for multicodex plugin debug traces and rotation decisions.

import fs from "node:fs/promises";
import path from "node:path";

const LOG_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../multicodex-debug.log",
);

type LogLevel = "debug" | "info" | "warn" | "error";

function nowIso() {
  return new Date().toISOString();
}

function toMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function scrub(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(scrub);
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    const k = key.toLowerCase();
    if (k.includes("access") || k.includes("refresh") || k.includes("token") || k.includes("authorization")) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = scrub(raw);
  }
  return output;
}

class MulticodexLogger {
  readonly logPath = LOG_PATH;

  async log(level: LogLevel, message: string, context?: Record<string, unknown>) {
    const line = JSON.stringify({
      time: nowIso(),
      level,
      message,
      context: scrub(context ?? {}),
    });
    try {
      await fs.appendFile(this.logPath, `${line}\n`, "utf8");
    } catch {
      // ignore logger failures
    }
  }

  debug(message: string, context?: Record<string, unknown>) {
    return this.log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>) {
    return this.log("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>) {
    return this.log("warn", message, context);
  }

  error(message: string, error?: unknown, context?: Record<string, unknown>) {
    return this.log("error", message, {
      ...(context ?? {}),
      error: error ? toMessage(error) : undefined,
    });
  }
}

export { MulticodexLogger };
