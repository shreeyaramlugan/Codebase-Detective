// app/api/analyses/[analysisId]/dependencies/route.ts
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/session";
import { AnalysisError } from "@/lib/analysis/analysis.errors";
import {
  analysisErrorResponse,
  unexpectedErrorResponse,
  readEnumParam,
  readPagination,
} from "@/lib/analysis/analysis.http";
import {
  isUnauthorized,
  unauthorizedResponse,
} from "@/lib/ingestion/source-content/source-content.http";
import { listAnalysisDependencies } from "@/lib/analysis/analysis.service";

type RouteContext = { params: Promise<{ analysisId: string }> };

const STATUSES = ["RESOLVED", "UNRESOLVED", "AMBIGUOUS", "EXTERNAL"] as const;
const KINDS = [
  "IMPORT",
  "SIDE_EFFECT_IMPORT",
  "DYNAMIC_IMPORT",
  "REQUIRE",
  "RE_EXPORT",
  "EXPORT_ALL",
] as const;

/** GET /api/analyses/[analysisId]/dependencies?status=&kind=&path=&limit=&cursor= */
export async function GET(request: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    const { analysisId } = await context.params;
    const url = new URL(request.url);

    const page = await listAnalysisDependencies(session.user.id, analysisId, {
      ...readPagination(url),
      status: readEnumParam(url, "status", STATUSES),
      kind: readEnumParam(url, "kind", KINDS),
      path: url.searchParams.get("path") ?? undefined,
    });

    return NextResponse.json(page, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof AnalysisError) return analysisErrorResponse(error);
    return unexpectedErrorResponse("Analysis dependencies failed", error);
  }
}
