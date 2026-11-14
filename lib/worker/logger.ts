// lib/worker/logger.ts
//
// Structured JSON logging. Every field passes through sanitisation so a log
// line can never carry credentials, bearer tokens, or source file contents,
// even if a caller passes them by mistake.
import { redactSecrets } from "@/features/ai/assistant/redact";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY =
  /(secret|password|passwd|authorization|api[_-]?key|cookie|credential|private[_-]?key|database[_-]?url)|(^|[_-])(access|auth|refresh|bearer|api|github|gemini)[_-]?token$|^token$|^session(id|token)?$/i;
/** Field names that hold repository or external content; never logged. */
const CONTENT_KEY = /^(content|contents|source|sourcecode|body|text|passages|excerpt|html|diff|stdout|stderr|env|prompt|snippet|snippets|passage|question|answer|completion)$/i;

const MAX_STRING = 300;
const MAX_KEYS = 30;
const MAX_DEPTH = 3;

export function sanitiseLogValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const redacted = redactSecrets(value).text;
    return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}...` : redacted;
  }
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return {
      name: value.name,
      ...(typeof code === "string" ? { code: code.slice(0, 60) } : {}),
      message: sanitiseLogValue(value.message, depth + 1),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => sanitiseLogValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      if (SECRET_KEY.test(key)) out[key] = "[REDACTED]";
      else if (CONTENT_KEY.test(key)) out[key] = "[omitted]";
      else out[key] = sanitiseLogValue(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 60);
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(options: {
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => Date;
  bindings?: Record<string, unknown>;
} = {}): Logger {
  const level = options.level ?? "info";
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const bindings = options.bindings ?? {};

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const entry = sanitiseLogValue({ ...bindings, ...fields }) as Record<string, unknown>;
    write(
      JSON.stringify({
        ts: now().toISOString(),
        level: lvl,
        msg: sanitiseLogValue(msg),
        ...entry,
      }),
    );
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (extra) =>
      createLogger({ level, write, now, bindings: { ...bindings, ...extra } }),
  };
}

export function newCorrelationId(): string {
  return `c_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
