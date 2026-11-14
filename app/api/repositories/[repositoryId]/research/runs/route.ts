// app/api/repositories/[repositoryId]/research/runs/route.ts
import { dispatchJob } from "@/lib/jobs/dispatch";
import { toJobView } from "@/lib/jobs/job-admin";
import { enqueueResearchDiscoveryJob } from "@/lib/jobs/job-enqueue-pipeline";
import { createResearchDeps } from "@/lib/research/research.runtime";
import { handleResearchRequest, readJsonObject } from "@/lib/research/research.http";
import { failRunFinal, getRun, listRuns, prepareRun } from "@/lib/research/research.service";

type RouteContext = { params: Promise<{ repositoryId: string }> };

/** GET - research history. Query: ?archived=true, ?finding=<fingerprint> */
export async function GET(request: Request, context: RouteContext) {
  return handleResearchRequest("Research history read failed", async (userId) => {
    const { repositoryId } = await context.params;
    const url = new URL(request.url);
    const finding = url.searchParams.get("finding") ?? undefined;
    return listRuns(createResearchDeps(userId), userId, repositoryId, {
      archived: url.searchParams.get("archived") === "true",
      findingFingerprint: finding && /^fnd_[0-9a-f]{32}$/.test(finding) ? finding : undefined,
    });
  });
}

/**
 * POST - start a user-initiated research run. The run is validated, quota is
 * reserved and the run is created in DISCOVERING; the provider lookups happen
 * in a worker job. Returns 202 { run, job }; poll the run or the job.
 * Body: { findingId } or { question, analysisId? | snapshotId? }
 */
export async function POST(request: Request, context: RouteContext) {
  return handleResearchRequest(
    "Research run failed",
    async (userId) => {
      const { repositoryId } = await context.params;
      const body = await readJsonObject(request);
      const deps = createResearchDeps(userId);
      const prepared = await prepareRun(deps, userId, repositoryId, body, { lock: false });
      try {
        const { job } = await enqueueResearchDiscoveryJob(userId, prepared.id);
        dispatchJob(job.id);
        return { run: await getRun(deps, userId, prepared.id), job: toJobView(job) };
      } catch (error) {
        // Never leave a run stuck in DISCOVERING with no job behind it.
        await failRunFinal(deps, prepared.id, "ENQUEUE_FAILED").catch(() => undefined);
        throw error;
      }
    },
    202,
  );
}
