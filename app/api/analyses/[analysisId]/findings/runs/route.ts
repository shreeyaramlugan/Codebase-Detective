// app/api/analyses/[analysisId]/findings/runs/route.ts
import { handleFindingsRequest, requireId } from "@/lib/findings/findings.http";
import { listAnalysisFindingsRuns } from "@/lib/findings/findings.service";

type RouteContext = { params: Promise<{ analysisId: string }> };

/** GET /api/analyses/[analysisId]/findings/runs - runs for one analysis. */
export async function GET(_request: Request, context: RouteContext) {
  return handleFindingsRequest("Findings runs failed", async (userId) => {
    const { analysisId } = await context.params;
    return listAnalysisFindingsRuns(
      userId,
      requireId(analysisId, "analysisId"),
    );
  });
}
