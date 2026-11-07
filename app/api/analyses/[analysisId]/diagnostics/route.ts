// app/api/analyses/[analysisId]/diagnostics/route.ts
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
import { listAnalysisDiagnostics } from "@/lib/analysis/analysis.service";

type RouteContext = { params: Promise<{ analysisId: string }> };

const SEVERITIES = ["ERROR", "WARNING", "INFO"] as const;
const SOURCES = [
  "SNAPSHOT",
  "PARSER",
  "EXTRACTOR",
  "RESOLVER",
  "LINKER",
  "CONFIG",
  "GRAPH",
  "ENGINE",
] as const;

/** GET /api/analyses/[analysisId]/diagnostics?severity=&source=&path=&limit=&cursor= */
export async function GET(request: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    const { analysisId } = await context.params;
    const url = new URL(request.url);

    const page = await listAnalysisDiagnostics(session.user.id, analysisId, {
      ...readPagination(url),
      severity: readEnumParam(url, "severity", SEVERITIES),
      source: readEnumParam(url, "source", SOURCES),
      path: url.searchParams.get("path") ?? undefined,
    });

    return NextResponse.json(page, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof AnalysisError) return analysisErrorResponse(error);
    return unexpectedErrorResponse("Analysis diagnostics failed", error);
  }
}
