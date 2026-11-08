// app/api/analyses/[analysisId]/findings/route.ts
import { readPagination } from "@/lib/analysis/analysis.http";
import { FindingsError } from "@/lib/findings/findings.errors";
import { handleFindingsRequest, requireId } from "@/lib/findings/findings.http";
import {
  listAnalysisFindings,
  REVIEW_FILTERS,
  type ReviewFilter,
} from "@/lib/findings/findings.service";

type RouteContext = { params: Promise<{ analysisId: string }> };

function list(url: URL, name: string): string[] | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return undefined;
  const items = value.split(",").map((item) => item.trim());
  if (
    items.length > 20 ||
    items.some((item) => !/^[A-Za-z0-9_]{1,32}$/.test(item))
  ) {
    throw new FindingsError(`${name} is invalid.`, "INVALID_INPUT");
  }
  return [...new Set(items)];
}

/**
 * GET /api/analyses/[analysisId]/findings
 * Findings of the latest finished run for this analysis (or ?runId=).
 * Filters: severity, category, certainty, rule, path, q, review, limit, cursor.
 */
export async function GET(request: Request, context: RouteContext) {
  return handleFindingsRequest("Analysis findings failed", async (userId) => {
    const { analysisId } = await context.params;
    const url = new URL(request.url);
    const { limit, cursor } = readPagination(url);
    const runId = url.searchParams.get("runId");
    const review = url.searchParams.get("review");

    if (review && !(REVIEW_FILTERS as readonly string[]).includes(review)) {
      throw new FindingsError("review is invalid.", "INVALID_INPUT");
    }

    return listAnalysisFindings(userId, requireId(analysisId, "analysisId"), {
      runId: runId ? requireId(runId, "runId") : undefined,
      filters: {
        severities: list(url, "severity"),
        categories: list(url, "category"),
        certainties: list(url, "certainty"),
        ruleIds: list(url, "rule"),
        path: url.searchParams.get("path") || undefined,
        q: url.searchParams.get("q") || undefined,
        review: (review || undefined) as ReviewFilter | undefined,
        limit,
        cursor,
      },
    });
  });
}
