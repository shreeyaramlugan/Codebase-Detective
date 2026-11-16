// lib/worker/config.ts
//
// Environment-driven worker configuration. Everything is validated before the
// first job is claimed; problems are collected and reported together so a bad
// deployment fails fast with one clear message instead of one error at a time.
import { hostname } from "node:os";

import { DEFAULT_JOB_TIMEOUTS_MS } from "@/lib/jobs/job-policy";
import { JOB_TYPES, type JobType } from "@/lib/jobs/job-types";

export interface WorkerConfig {
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
  recoveryIntervalMs: number;
  shutdownGraceMs: number;
  maxRssMb: number;
  healthPort: number;
  healthHost: string;
  logLevel: "debug" | "info" | "warn" | "error";
  jobTimeoutsMs: Record<JobType, number>;
  /** Job types this worker will claim (default: all). */
  enabledTypes: JobType[];
}

export class WorkerConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid worker configuration:\n- ${problems.join("\n- ")}`);
    this.name = "WorkerConfigError";
  }
}

type Env = Record<string, string | undefined>;

function int(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number between ${min} and ${max}.`);
    return fallback;
  }
  return n;
}

export function loadWorkerConfig(env: Env = process.env): {
  config: WorkerConfig;
  warnings: string[];
} {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (!env.DATABASE_URL?.trim()) problems.push("DATABASE_URL is required.");

  if (env.NODE_ENV === "production" && env.BACKGROUND_EXECUTION === "inline") {
    problems.push("BACKGROUND_EXECUTION=inline is not allowed in production.");
  }

  const storage = (env.SOURCE_STORAGE_PROVIDER ?? "local").trim();
  if (storage !== "local" && storage !== "s3") {
    problems.push(`SOURCE_STORAGE_PROVIDER "${storage.slice(0, 30)}" is not supported.`);
  }
  if (storage === "s3") {
    for (const name of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
      if (!env[name]?.trim()) problems.push(`${name} is required when SOURCE_STORAGE_PROVIDER=s3.`);
    }
  }
  if (storage === "s3" && env.S3_ENDPOINT?.trim()) {
    let endpointOk = false;
    try {
      const url = new URL(env.S3_ENDPOINT.trim());
      endpointOk = url.protocol === "https:" && !url.hostname.includes("<");
    } catch {
      endpointOk = false;
    }
    if (!endpointOk) {
      problems.push(
        "S3_ENDPOINT must be a full https URL, for example https://<account-id>.r2.cloudflarestorage.com with your real account id (no bucket name, no placeholder).",
      );
    }
  }
  if (env.NODE_ENV === "production" && storage === "local") {
    if (env.ALLOW_LOCAL_STORAGE === "true") {
      // Self-hosting on one machine: the web app and worker share one disk.
      warnings.push(
        "Using local snapshot storage in production (ALLOW_LOCAL_STORAGE=true). Only valid when the web app and worker run on the same machine and the disk is backed up.",
      );
    } else {
      // On a hosted worker the disk is separate from the web app's and is lost
      // on every redeploy.
      problems.push(
        "SOURCE_STORAGE_PROVIDER=local is not allowed in production; use s3 (or set ALLOW_LOCAL_STORAGE=true when the web app and worker run on the same machine).",
      );
    }
  }

  const ai = env.AI_PROVIDER ?? "mock";
  if (ai !== "mock" && ai !== "gemini") {
    problems.push(`AI_PROVIDER "${ai.slice(0, 30)}" is not supported.`);
  }
  // The provider key is deliberately not read here. Only the AI provider
  // factory touches it (enforced by tests/unit/ai/security.test.ts).

  const heartbeatIntervalMs = int(env, "WORKER_HEARTBEAT_INTERVAL_MS", 15_000, 1_000, 60_000, problems);
  const staleAfterMs = int(env, "WORKER_STALE_AFTER_MS", 90_000, 5_000, 3_600_000, problems);
  if (staleAfterMs < heartbeatIntervalMs * 3) {
    problems.push("WORKER_STALE_AFTER_MS must be at least three times WORKER_HEARTBEAT_INTERVAL_MS.");
  }

  const logLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    problems.push("LOG_LEVEL must be debug, info, warn or error.");
  }

  const enabled = (env.WORKER_JOB_TYPES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const enabledTypes = enabled.length
    ? (enabled.filter((t): t is JobType => (JOB_TYPES as readonly string[]).includes(t)))
    : [...JOB_TYPES];
  if (enabled.length && enabledTypes.length !== enabled.length) {
    problems.push("WORKER_JOB_TYPES contains an unknown job type.");
  }

  const timeout = int(env, "WORKER_JOB_TIMEOUT_MS", 0, 0, 3_600_000, problems);
  const jobTimeoutsMs = { ...DEFAULT_JOB_TIMEOUTS_MS };
  if (timeout > 0) for (const t of JOB_TYPES) jobTimeoutsMs[t] = timeout;

  const config: WorkerConfig = {
    workerId:
      env.WORKER_ID?.trim().slice(0, 80) ||
      `${hostname().slice(0, 30)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    concurrency: int(env, "WORKER_CONCURRENCY", 2, 1, 8, problems),
    pollIntervalMs: int(env, "WORKER_POLL_INTERVAL_MS", 2_000, 250, 60_000, problems),
    heartbeatIntervalMs,
    staleAfterMs,
    recoveryIntervalMs: int(env, "WORKER_RECOVERY_INTERVAL_MS", 30_000, 1_000, 600_000, problems),
    shutdownGraceMs: int(env, "WORKER_SHUTDOWN_GRACE_MS", 30_000, 0, 300_000, problems),
    maxRssMb: int(env, "WORKER_MAX_RSS_MB", 1_536, 0, 65_536, problems),
    healthPort: int(env, "WORKER_HEALTH_PORT", 3101, 0, 65_535, problems),
    healthHost: env.WORKER_HEALTH_HOST?.trim() || "127.0.0.1",
    logLevel: logLevel as WorkerConfig["logLevel"],
    jobTimeoutsMs,
    enabledTypes,
  };

  if (problems.length) throw new WorkerConfigError(problems);
  return { config, warnings };
}
