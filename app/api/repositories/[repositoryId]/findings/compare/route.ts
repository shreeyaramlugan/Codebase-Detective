// app/api/repositories/[repositoryId]/findings/compare/route.ts
import { FindingsError } from "@/lib/findings/findings.errors";
import { handleFindingsRequest, requireId } from "@/lib/findings/findings.http";
import { compareFindingsRuns } from "@/lib/findings/findings.service";

type RouteContext = { params: Promise<{ repositoryId: string }> };

/**
 * GET /api/repositories/[repositoryId]/findings/compare?base=<runId>&head=<runId>
 * Both runs must belong to this repository and to the caller.
 */
export async function GET(request: Request, context: RouteContext) {
  return handleFindingsRequest("Findings comparison failed", async (userId) => {
    const { repositoryId } = await context.params;
    requireId(repositoryId, "repositoryId");
    const url = new URL(request.url);
    const base = url.searchParams.get("base");
    const head = url.searchParams.get("head");

    if (!base || !head) {
      throw new FindingsError("base and head are required.", "INVALID_INPUT");
    }

    const result = await compareFindingsRuns(
      userId,
      requireId(base, "base"),
      requireId(head, "head"),
    );

    if (
      result.base.repositoryId !== repositoryId ||
      result.head.repositoryId !== repositoryId
    ) {
      throw new FindingsError("Findings run not found.", "NOT_FOUND");
    }

    return result;
  });
}
