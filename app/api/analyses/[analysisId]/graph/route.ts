// app/api/analyses/[analysisId]/graph/route.ts
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/session";
import { AnalysisError } from "@/lib/analysis/analysis.errors";
import {
  analysisErrorResponse,
  unexpectedErrorResponse,
  readEnumParam,
} from "@/lib/analysis/analysis.http";
import {
  isUnauthorized,
  unauthorizedResponse,
} from "@/lib/ingestion/source-content/source-content.http";
import { getAnalysisGraph } from "@/lib/analysis/analysis.service";

type RouteContext = { params: Promise<{ analysisId: string }> };

/**
 * GET /api/analyses/[analysisId]/graph
 *
 * Returns the stored graph read model. `?source=relational` rebuilds it from
 * the relational records instead (read-only; nothing is written).
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    const { analysisId } = await context.params;

    const source = readEnumParam(new URL(request.url), "source", [
      "stored",
      "relational",
    ]) as "stored" | "relational" | undefined;

    const graph = await getAnalysisGraph(session.user.id, analysisId, source);

    return NextResponse.json(
      { graph },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof AnalysisError) return analysisErrorResponse(error);
    return unexpectedErrorResponse("Analysis graph failed", error);
  }
}
