// app/api/analyses/[analysisId]/rules/route.ts
import { handleFindingsRequest, requireId } from "@/lib/findings/findings.http";
import { getAnalysisRules } from "@/lib/findings/findings.service";

type RouteContext = { params: Promise<{ analysisId: string }> };

/** GET /api/analyses/[analysisId]/rules - rules and versions the latest run used. */
export async function GET(request: Request, context: RouteContext) {
  return handleFindingsRequest("Analysis rules failed", async (userId) => {
    const { analysisId } = await context.params;
    const runId = new URL(request.url).searchParams.get("runId");
    return getAnalysisRules(userId, requireId(analysisId, "analysisId"), {
      runId: runId ? requireId(runId, "runId") : undefined,
    });
  });
}
