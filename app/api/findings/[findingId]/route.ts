// app/api/findings/[findingId]/route.ts
import { handleFindingsRequest, requireId } from "@/lib/findings/findings.http";
import { getFinding } from "@/lib/findings/findings.service";

type RouteContext = { params: Promise<{ findingId: string }> };

/** GET /api/findings/[findingId] - finding with evidence and rule details. */
export async function GET(_request: Request, context: RouteContext) {
  return handleFindingsRequest("Finding lookup failed", async (userId) => {
    const { findingId } = await context.params;
    return getFinding(userId, requireId(findingId, "findingId"));
  });
}
