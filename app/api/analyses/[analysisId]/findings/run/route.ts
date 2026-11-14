// app/api/analyses/[analysisId]/findings/run/route.ts
import { readJsonBody, requireId } from "@/lib/findings/findings.http";
import { dispatchJob } from "@/lib/jobs/dispatch";
import { enqueueFindingsJob } from "@/lib/jobs/job-enqueue-pipeline";
import { toJobView } from "@/lib/jobs/job-admin";
import { handleJobRequest } from "@/lib/jobs/job.http";

type RouteContext = { params: Promise<{ analysisId: string }> };

/**
 * POST /api/analyses/[analysisId]/findings/run
 * Body (optional): { "thresholds": { "cyclomaticMedium": 20, ... } }
 * Queues a new immutable findings run and returns 202 with the job. When the
 * job completes, `result.findingsRunId` identifies the run.
 */
export async function POST(request: Request, context: RouteContext) {
  return handleJobRequest(
    "Findings enqueue failed",
    async (userId) => {
      const { analysisId } = await context.params;
      const body = (await readJsonBody(request)) as { thresholds?: unknown };
      const { job, deduplicated } = await enqueueFindingsJob(
        userId,
        requireId(analysisId, "analysisId"),
        body?.thresholds,
      );
      if (!deduplicated) dispatchJob(job.id);
      return { job: toJobView(job), deduplicated };
    },
    202,
  );
}
