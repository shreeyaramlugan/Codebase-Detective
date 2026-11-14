// lib/jobs/dispatch.ts
//
// After a job is created, decide whether anything needs to be done to get it
// running:
//   BACKGROUND_EXECUTION=worker (default): nothing. The worker process polls
//     the queue. This is the only mode allowed in production.
//   BACKGROUND_EXECUTION=inline (development convenience): run the job in this
//     process, in the background, through exactly the same executor the worker
//     uses (claim, heartbeat, timeout, retry rules, handlers).
import { executionMode } from "./execution-mode";

export { executionMode } from "./execution-mode";

export function dispatchJob(jobId: string): void {
  if (executionMode() !== "inline") return;
  // Not awaited: the request returns immediately and the UI polls the job.
  void runInline(jobId).catch((error) => {
    console.error(
      JSON.stringify({ level: "error", msg: "inline job failed", event: "inline_failed", jobId, error: error instanceof Error ? error.name : "Error" }),
    );
  });
}

async function runInline(jobId: string): Promise<void> {
  // Loaded lazily so the web bundle does not pull in the worker unless inline mode is on.
  const [{ startIndexingJob }, { createPrismaQueue }, { createHandlers }, { createPrismaPorts }, { loadWorkerConfig }, { createLogger }, { executeClaimedJob }] =
    await Promise.all([
      import("./job-lifecycle"),
      import("../worker/queue.prisma"),
      import("../worker/handlers"),
      import("../worker/pipeline-ports"),
      import("../worker/config"),
      import("../worker/logger"),
      import("../worker/runtime"),
    ]);
  const { config } = loadWorkerConfig({ ...process.env, WORKER_ID: "inline" });
  const job = await startIndexingJob(jobId, { workerId: config.workerId });
  await executeClaimedJob(
    {
      queue: createPrismaQueue(),
      handlers: createHandlers(createPrismaPorts()),
      logger: createLogger({ level: config.logLevel, bindings: { service: "inline" } }),
      config,
      workerId: config.workerId,
    },
    job,
  );
}
