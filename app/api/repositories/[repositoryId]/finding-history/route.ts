// app/api/repositories/[repositoryId]/finding-history/route.ts
import { handleFindingsRequest, requireId } from "@/lib/findings/findings.http";
import { getRepositoryFindingHistory } from "@/lib/findings/findings.service";

type RouteContext = { params: Promise<{ repositoryId: string }> };

/**
 * GET /api/repositories/[repositoryId]/finding-history[?fingerprint=fnd_...]
 * Every findings run for the repository, optionally with the timeline of one
 * finding identity across those runs.
 */
export async function GET(request: Request, context: RouteContext) {
  return handleFindingsRequest("Finding history failed", async (userId) => {
    const { repositoryId } = await context.params;
    const fingerprint = new URL(request.url).searchParams.get("fingerprint");
    return getRepositoryFindingHistory(
      userId,
      requireId(repositoryId, "repositoryId"),
      { fingerprint: fingerprint || undefined },
    );
  });
}
