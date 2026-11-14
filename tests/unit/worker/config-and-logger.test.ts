// tests/unit/worker/config-and-logger.test.ts
import { describe, expect, it } from "vitest";

import { loadWorkerConfig, WorkerConfigError } from "../../../lib/worker/config";
import { createLogger, sanitiseLogValue } from "../../../lib/worker/logger";

const ok = { DATABASE_URL: "postgres://u:p@localhost/db" };

function problems(env: Record<string, string>): string {
  try { loadWorkerConfig(env); return ""; } catch (e) { return e instanceof WorkerConfigError ? e.problems.join("|") : `wrong: ${String(e)}`; }
}

describe("worker configuration", () => {
  it("loads safe defaults", () => {
    const { config } = loadWorkerConfig(ok);
    expect(config.concurrency).toBe(2);
    expect(config.healthHost).toBe("127.0.0.1");
    expect(config.staleAfterMs).toBeGreaterThanOrEqual(config.heartbeatIntervalMs * 3);
    expect(config.enabledTypes).toHaveLength(5);
  });

  it("requires a database url", () => {
    expect(problems({})).toContain("DATABASE_URL is required");
  });

  it("rejects inline execution in production", () => {
    expect(problems({ ...ok, NODE_ENV: "production", BACKGROUND_EXECUTION: "inline" })).toContain("not allowed in production");
  });

  it("rejects out-of-range or non-numeric limits instead of guessing", () => {
    expect(problems({ ...ok, WORKER_CONCURRENCY: "0" })).toContain("WORKER_CONCURRENCY");
    expect(problems({ ...ok, WORKER_CONCURRENCY: "99" })).toContain("WORKER_CONCURRENCY");
    expect(problems({ ...ok, WORKER_POLL_INTERVAL_MS: "abc" })).toContain("WORKER_POLL_INTERVAL_MS");
  });

  it("requires the stale threshold to be at least three heartbeats", () => {
    expect(problems({ ...ok, WORKER_HEARTBEAT_INTERVAL_MS: "30000", WORKER_STALE_AFTER_MS: "40000" })).toContain("three times");
  });

  it("validates job types, log level and providers", () => {
    expect(problems({ ...ok, WORKER_JOB_TYPES: "CODE_ANALYSIS,NOPE" })).toContain("unknown job type");
    expect(problems({ ...ok, LOG_LEVEL: "loud" })).toContain("LOG_LEVEL");
    expect(problems({ ...ok, AI_PROVIDER: "other" })).toContain("AI_PROVIDER");
    expect(problems({ ...ok, SOURCE_STORAGE_PROVIDER: "s3" })).toContain("SOURCE_STORAGE_PROVIDER");
    expect(loadWorkerConfig({ ...ok, WORKER_JOB_TYPES: "CODE_ANALYSIS" }).config.enabledTypes).toEqual(["CODE_ANALYSIS"]);
  });

  it("does not read the AI provider key", () => {
    const { warnings } = loadWorkerConfig({ ...ok, AI_PROVIDER: "gemini", GEMINI_API_KEY: "AIzaSyA1234567890abcdefghijklmnopqrstuv" });
    expect(warnings.join(" ")).not.toContain("AIza");
  });

  it("never echoes the database url in an error", () => {
    expect(problems({ ...ok, WORKER_CONCURRENCY: "0" })).not.toContain("postgres://");
  });
});

describe("structured logging", () => {
  function capture() {
    const lines: string[] = [];
    const log = createLogger({ level: "debug", write: (l) => lines.push(l), now: () => new Date("2026-11-10T10:00:00Z") });
    return { lines, log };
  }

  it("writes one JSON object per line with timestamp, level and bindings", () => {
    const { lines, log } = capture();
    log.child({ jobId: "j1", correlationId: "c_1" }).info("job started", { attempt: 2 });
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ ts: "2026-11-10T10:00:00.000Z", level: "info", msg: "job started", jobId: "j1", correlationId: "c_1", attempt: 2 });
  });

  it("redacts secrets in values and messages", () => {
    const { lines, log } = capture();
    log.error("failed with key AIzaSyA1234567890abcdefghijklmnopqrstuv", {
      detail: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and Bearer abcdefghijklmnopqrstuvwxyz",
    });
    expect(lines[0]).not.toContain("AIzaSyA1234567890");
    expect(lines[0]).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("never logs source content or prompts, whatever they are called", () => {
    const { lines, log } = capture();
    log.info("x", { content: "function secret() {}", source: "const a = 1", prompt: "explain", snippet: "abc", ok: 1 });
    const entry = JSON.parse(lines[0]);
    for (const key of ["content", "source", "prompt", "snippet"]) expect(entry[key]).toBe("[omitted]");
    expect(lines[0]).not.toContain("function secret");
    expect(entry.ok).toBe(1);
  });

  it("logs errors by name and message only, without stacks", () => {
    const { lines, log } = capture();
    log.error("boom", { error: new Error("disk failed") });
    expect(lines[0]).not.toContain("at ");
    expect(JSON.parse(lines[0]).error.name).toBe("Error");
  });

  it("truncates huge strings and deep structures", () => {
    const v = sanitiseLogValue({ a: "x".repeat(10_000), deep: { a: { b: { c: { d: { e: 1 } } } } } }) as any;
    expect(v.a.length).toBeLessThan(2_100);
  });

  it("respects the level threshold", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "warn", write: (l) => lines.push(l) });
    log.info("a"); log.warn("b");
    expect(lines).toHaveLength(1);
  });
});
