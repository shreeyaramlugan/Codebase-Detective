// app/api/repositories/[repositoryId]/findings/runs/route.ts
import { handleFindingsRequest, requireId } from "@/lib/findings/findings.http";
import { listRepositoryFindingsRuns } from "@/lib/findings/findings.service";

type RouteContext = { params: Promise<{ repositoryId: string }> };

/** GET /api/repositories/[repositoryId]/findings/runs - runs across snapshots. */
export async function GET(_request: Request, context: RouteContext) {
  return handleFindingsRequest("Findings runs failed", async (userId) => {
    const { repositoryId } = await context.params;
    return listRepositoryFindingsRuns(
      userId,
      requireId(repositoryId, "repositoryId"),
    );
  });
}
