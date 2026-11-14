// app/api/admin/jobs/[jobId]/retry/route.ts
import { dispatchJob } from "@/lib/jobs/dispatch";
import { adminRetryJob } from "@/lib/jobs/job-admin";
import { handleJobRequest, requireWorkerAdmin } from "@/lib/jobs/job.http";

type RouteContext = { params: Promise<{ jobId: string }> };

/** POST - controlled retry of a FAILED job. Operators only. */
export async function POST(_request: Request, context: RouteContext) {
  return handleJobRequest("Admin job retry failed", async (userId) => {
    requireWorkerAdmin(userId);
    const { jobId } = await context.params;
    const job = await adminRetryJob(jobId, userId);
    dispatchJob(jobId);
    return { job };
  });
}
