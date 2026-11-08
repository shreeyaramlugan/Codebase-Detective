// app/api/findings/runs/[runId]/findings/route.ts
import { readPagination } from "@/lib/analysis/analysis.http";
import { handleFindingsRequest, requireId } from "@/lib/findings/findings.http";
import { FindingsError } from "@/lib/findings/findings.errors";
import {
  listFindings,
  REVIEW_FILTERS,
  type ReviewFilter,
} from "@/lib/findings/findings.service";

type RouteContext = { params: Promise<{ runId: string }> };

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
 * GET /api/findings/runs/[runId]/findings
 * Query: severity, category, certainty, rule (comma lists), path, q, review,
 * limit, cursor. Every value is allow-listed or length-bounded in the service.
 */
export async function GET(request: Request, context: RouteContext) {
  return handleFindingsRequest("Findings list failed", async (userId) => {
    const { runId } = await context.params;
    const url = new URL(request.url);
    const { limit, cursor } = readPagination(url);

    const review = url.searchParams.get("review");
    if (review && !(REVIEW_FILTERS as readonly string[]).includes(review)) {
      throw new FindingsError("review is invalid.", "INVALID_INPUT");
    }

    return listFindings(userId, requireId(runId, "runId"), {
      severities: list(url, "severity"),
      categories: list(url, "category"),
      certainties: list(url, "certainty"),
      ruleIds: list(url, "rule"),
      path: url.searchParams.get("path") || undefined,
      q: url.searchParams.get("q") || undefined,
      review: (review || undefined) as ReviewFilter | undefined,
      limit,
      cursor,
    });
  });
}
