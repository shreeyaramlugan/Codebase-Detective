// app/api/research/runs/[runId]/synthesize/route.ts
import { dispatchJob } from "@/lib/jobs/dispatch";
import { toJobView } from "@/lib/jobs/job-admin";
import { enqueueResearchSynthesisJob } from "@/lib/jobs/job-enqueue-pipeline";
import { createResearchDeps } from "@/lib/research/research.runtime";
import { handleResearchRequest } from "@/lib/research/research.http";
import { beginSynthesis, getRun, reopenReview } from "@/lib/research/research.service";

type RouteContext = { params: Promise<{ runId: string }> };

/**
 * POST - queue synthesis of recommendations from the sources the user kept.
 * The run moves to SYNTHESIZING (sources lock) and a worker job does the AI
 * call. Returns 202 { run, job }. If the job finally fails the run returns to
 * AWAITING_REVIEW so the person can try again.
 */
export async function POST(_request: Request, context: RouteContext) {
  return handleResearchRequest(
    "Research synthesis failed",
    async (userId) => {
      const { runId } = await context.params;
      const deps = createResearchDeps(userId);
      await beginSynthesis(deps, userId, runId);
      try {
        const { job } = await enqueueResearchSynthesisJob(userId, runId);
        dispatchJob(job.id);
        return { run: await getRun(deps, userId, runId), job: toJobView(job) };
      } catch (error) {
        await reopenReview(deps, runId, "ENQUEUE_FAILED").catch(() => undefined);
        throw error;
      }
    },
    202,
  );
}
