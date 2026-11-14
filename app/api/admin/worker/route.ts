// app/api/admin/worker/route.ts
import { getQueueStats } from "@/lib/jobs/job-admin";
import { handleJobRequest, requireWorkerAdmin } from "@/lib/jobs/job.http";

/** GET - queue statistics, workers and recent failures. Operators only. */
export async function GET() {
  return handleJobRequest("Worker status failed", async (userId) => {
    requireWorkerAdmin(userId);
    return getQueueStats();
  });
}
