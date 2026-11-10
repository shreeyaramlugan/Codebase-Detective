// app/api/repositories/[repositoryId]/research/runs/route.ts
import { createResearchDeps } from "@/lib/research/research.runtime";
import { handleResearchRequest, readJsonObject } from "@/lib/research/research.http";
import { listRuns, startRun } from "@/lib/research/research.service";

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
 * POST - start a user-initiated research run (discovery only; no AI call).
 * Body: { findingId } or { question, analysisId? | snapshotId? }
 */
export async function POST(request: Request, context: RouteContext) {
  return handleResearchRequest(
    "Research run failed",
    async (userId) => {
      const { repositoryId } = await context.params;
      const body = await readJsonObject(request);
      return startRun(createResearchDeps(userId), userId, repositoryId, body);
    },
    201,
  );
}
