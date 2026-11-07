// app/api/analyses/[analysisId]/explorer/search/route.ts
import { AnalysisError } from "@/lib/analysis/analysis.errors";
import { SEARCH_CATEGORIES } from "@/features/explorer/search/search-model";
import { searchAnalysis } from "@/lib/explorer/explorer.service";
import {
  handleExplorerRequest,
  readListParam,
} from "@/lib/explorer/explorer.http";

type RouteContext = { params: Promise<{ analysisId: string }> };

/**
 * GET /api/analyses/[analysisId]/explorer/search?q=&categories=files,symbols&limit=
 *
 * Searches files/paths, symbols, modules and exports of ONE analysis. `q` is
 * required (2-100 characters); `limit` applies per category.
 */
export async function GET(request: Request, context: RouteContext) {
  return handleExplorerRequest("Explorer search failed", async (userId) => {
    const { analysisId } = await context.params;
    const url = new URL(request.url);

    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new AnalysisError(
        "limit must be a positive integer.",
        "INVALID_QUERY",
      );
    }

    return searchAnalysis(userId, analysisId, {
      q: url.searchParams.get("q") ?? "",
      categories: readListParam(url, "categories", SEARCH_CATEGORIES) as
        Array<(typeof SEARCH_CATEGORIES)[number]> | undefined,
      limit,
    });
  });
}
