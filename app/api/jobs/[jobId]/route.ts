// app/api/jobs/[jobId]/route.ts
import { getOwnedJob } from "@/lib/jobs/job-admin";
import { handleJobRequest } from "@/lib/jobs/job.http";

type RouteContext = { params: Promise<{ jobId: string }> };

/** GET - status of one of the signed-in user's own jobs (safe fields only). */
export async function GET(_request: Request, context: RouteContext) {
  return handleJobRequest("Job read failed", async (userId) => {
    const { jobId } = await context.params;
    return { job: await getOwnedJob(userId, jobId) };
  });
}
