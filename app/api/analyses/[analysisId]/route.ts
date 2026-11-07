// app/api/analyses/[analysisId]/route.ts
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/session";
import { AnalysisError } from "@/lib/analysis/analysis.errors";
import {
  analysisErrorResponse,
  unexpectedErrorResponse,
} from "@/lib/analysis/analysis.http";
import {
  isUnauthorized,
  unauthorizedResponse,
} from "@/lib/ingestion/source-content/source-content.http";
import { getAnalysisSummary } from "@/lib/analysis/analysis.service";

type RouteContext = { params: Promise<{ analysisId: string }> };

/** GET /api/analyses/[analysisId] - analysis summary. */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    const { analysisId } = await context.params;

    const analysis = await getAnalysisSummary(session.user.id, analysisId);

    return NextResponse.json(
      { analysis },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof AnalysisError) return analysisErrorResponse(error);
    return unexpectedErrorResponse("Analysis summary failed", error);
  }
}
