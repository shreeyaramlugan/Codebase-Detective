// app/api/findings/[findingId]/evidence/route.ts
import { handleFindingsRequest, requireId } from "@/lib/findings/findings.http";
import { getFindingEvidence } from "@/lib/findings/findings.service";

type RouteContext = { params: Promise<{ findingId: string }> };

/** GET /api/findings/[findingId]/evidence - the evidence supporting a finding. */
export async function GET(_request: Request, context: RouteContext) {
  return handleFindingsRequest("Finding evidence failed", async (userId) => {
    const { findingId } = await context.params;
    return getFindingEvidence(userId, requireId(findingId, "findingId"));
  });
}
