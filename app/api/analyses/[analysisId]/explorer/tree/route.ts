// app/api/analyses/[analysisId]/explorer/tree/route.ts
import { getAnalysisTree } from "@/lib/explorer/explorer.service";
import { handleExplorerRequest } from "@/lib/explorer/explorer.http";

type RouteContext = { params: Promise<{ analysisId: string }> };

/** GET /api/analyses/[analysisId]/explorer/tree - merged snapshot/analysis file list. */
export async function GET(_request: Request, context: RouteContext) {
  return handleExplorerRequest("Explorer tree failed", async (userId) => {
    const { analysisId } = await context.params;
    return getAnalysisTree(userId, analysisId);
  });
}
