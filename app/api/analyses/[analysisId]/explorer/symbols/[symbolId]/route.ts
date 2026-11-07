// app/api/analyses/[analysisId]/explorer/symbols/[symbolId]/route.ts
import { getExplorerSymbol } from "@/lib/explorer/explorer.service";
import { handleExplorerRequest } from "@/lib/explorer/explorer.http";

type RouteContext = {
  params: Promise<{ analysisId: string; symbolId: string }>;
};

/** GET /api/analyses/[analysisId]/explorer/symbols/[symbolId] */
export async function GET(_request: Request, context: RouteContext) {
  return handleExplorerRequest("Explorer symbol failed", async (userId) => {
    const { analysisId, symbolId } = await context.params;
    return getExplorerSymbol(userId, analysisId, symbolId);
  });
}
