// app/api/admin/jobs/[jobId]/route.ts
import { getJobEvents, JobNotFoundError, toJobView } from "@/lib/jobs/job-admin";
import { prisma } from "@/lib/db/prisma";
import { handleJobRequest, requireWorkerAdmin } from "@/lib/jobs/job.http";

type RouteContext = { params: Promise<{ jobId: string }> };

/** GET - one job with its event history. Operators only. */
export async function GET(_request: Request, context: RouteContext) {
  return handleJobRequest("Admin job read failed", async (userId) => {
    requireWorkerAdmin(userId);
    const { jobId } = await context.params;
    const job = await prisma.indexingJob.findUnique({ where: { id: jobId } });
    if (!job) throw new JobNotFoundError();
    return { job: toJobView(job), events: await getJobEvents(jobId) };
  });
}
