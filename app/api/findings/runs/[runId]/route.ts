// app/api/findings/runs/[runId]/route.ts
import { handleFindingsRequest, requireId } from "@/lib/findings/findings.http";
import { getFindingsRun } from "@/lib/findings/findings.service";

type RouteContext = { params: Promise<{ runId: string }> };

/** GET /api/findings/runs/[runId] - run summary, limitations and rule runs. */
export async function GET(_request: Request, context: RouteContext) {
  return handleFindingsRequest("Findings run lookup failed", async (userId) => {
    const { runId } = await context.params;
    return getFindingsRun(userId, requireId(runId, "runId"));
  });
}
