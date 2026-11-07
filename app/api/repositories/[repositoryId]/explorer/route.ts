// app/api/repositories/[repositoryId]/explorer/route.ts
import { getRepositoryExplorerOverview } from "@/lib/explorer/explorer.service";
import {
  handleExplorerRequest,
  readIdParam,
} from "@/lib/explorer/explorer.http";

type RouteContext = { params: Promise<{ repositoryId: string }> };

/**
 * GET /api/repositories/[repositoryId]/explorer?snapshotId=&analysisId=
 *
 * Repository, snapshot and analysis selection plus statistics computed from
 * the persisted analysis records.
 */
export async function GET(request: Request, context: RouteContext) {
  return handleExplorerRequest("Explorer overview failed", async (userId) => {
    const { repositoryId } = await context.params;
    const url = new URL(request.url);

    return getRepositoryExplorerOverview(userId, repositoryId, {
      snapshotId: readIdParam(url, "snapshotId"),
      analysisId: readIdParam(url, "analysisId"),
    });
  });
}
