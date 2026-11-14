// app/api/snapshots/[snapshotId]/analyze/route.ts
import { dispatchJob } from "@/lib/jobs/dispatch";
import { enqueueAnalysisJob } from "@/lib/jobs/job-enqueue-pipeline";
import { toJobView } from "@/lib/jobs/job-admin";
import { handleJobRequest } from "@/lib/jobs/job.http";

type RouteContext = { params: Promise<{ snapshotId: string }> };

/**
 * POST /api/snapshots/[snapshotId]/analyze
 *
 * Queues a NEW immutable analysis for a snapshot the user owns and returns
 * 202 with the job. The worker runs it; poll GET /api/jobs/[jobId] and read
 * `result.analysisId` when it completes. A repeated request while one is
 * still queued or running returns that same job.
 */
export async function POST(_request: Request, context: RouteContext) {
  return handleJobRequest(
    "Analysis enqueue failed",
    async (userId) => {
      const { snapshotId } = await context.params;
      const { job, deduplicated } = await enqueueAnalysisJob(userId, snapshotId);
      if (!deduplicated) dispatchJob(job.id);
      return { job: toJobView(job), deduplicated };
    },
    202,
  );
}
