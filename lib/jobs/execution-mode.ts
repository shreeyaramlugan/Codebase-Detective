// lib/jobs/execution-mode.ts
export type ExecutionMode = "worker" | "inline";

/** "inline" is ignored in production: only the worker may execute jobs there. */
export function executionMode(env: Record<string, string | undefined> = process.env): ExecutionMode {
  if (env.NODE_ENV === "production") return "worker";
  return env.BACKGROUND_EXECUTION === "inline" ? "inline" : "worker";
}
