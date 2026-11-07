// app/api/analyses/[analysisId]/explorer/symbols/route.ts
import { readPagination } from "@/lib/analysis/analysis.http";
import {
  EXPLORER_SYMBOL_KINDS,
  listExplorerSymbols,
} from "@/lib/explorer/explorer.service";
import {
  handleExplorerRequest,
  readBooleanParam,
  readListParam,
  readTextParam,
} from "@/lib/explorer/explorer.http";
import { AnalysisError } from "@/lib/analysis/analysis.errors";

type RouteContext = { params: Promise<{ analysisId: string }> };

/**
 * GET /api/analyses/[analysisId]/explorer/symbols
 *   ?q=&kinds=FUNCTION,CLASS&path=&pathContains=&exported=&parent=&limit=&cursor=
 *
 * Server-backed, cursor-paginated symbol search. `parent=none` lists
 * top-level symbols; `parent=<id>` lists that symbol's direct children.
 */
export async function GET(request: Request, context: RouteContext) {
  return handleExplorerRequest("Explorer symbols failed", async (userId) => {
    const { analysisId } = await context.params;
    const url = new URL(request.url);

    const parent = readTextParam(url, "parent", 64);
    if (
      parent !== undefined &&
      parent !== "none" &&
      !/^[A-Za-z0-9_-]+$/.test(parent)
    ) {
      throw new AnalysisError("parent is invalid.", "INVALID_QUERY");
    }

    return listExplorerSymbols(userId, analysisId, {
      ...readPagination(url),
      q: readTextParam(url, "q", 100),
      kinds: readListParam(url, "kinds", EXPLORER_SYMBOL_KINDS),
      path: readTextParam(url, "path", 1024),
      pathContains: readTextParam(url, "pathContains", 200),
      exported: readBooleanParam(url, "exported"),
      parent,
    });
  });
}
