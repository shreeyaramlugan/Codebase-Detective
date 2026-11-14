// app/api/repositories/[repositoryId]/jobs/route.ts
import { listOwnedJobs } from "@/lib/jobs/job-admin";
import { JOB_TYPES, type JobType } from "@/lib/jobs/job-types";
import { handleJobRequest } from "@/lib/jobs/job.http";

type RouteContext = { params: Promise<{ repositoryId: string }> };

/** GET - recent jobs for a repository the user owns. Query: ?type=, ?limit= */
export async function GET(request: Request, context: RouteContext) {
  return handleJobRequest("Job list failed", async (userId) => {
    const { repositoryId } = await context.params;
    const url = new URL(request.url);
    const type = url.searchParams.get("type");
    const limit = Number(url.searchParams.get("limit") ?? 20);
    return listOwnedJobs(userId, repositoryId, {
      limit: Number.isFinite(limit) ? limit : 20,
      type: type && (JOB_TYPES as readonly string[]).includes(type) ? (type as JobType) : undefined,
    });
  });
}
