// app/api/analyses/[analysisId]/files/[fileId]/route.ts
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
import { getAnalysisFile } from "@/lib/analysis/analysis.service";

type RouteContext = {
  params: Promise<{ analysisId: string; fileId: string }>;
};

/** GET /api/analyses/[analysisId]/files/[fileId] - per-file analysis details. */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    const { analysisId, fileId } = await context.params;

    const detail = await getAnalysisFile(session.user.id, analysisId, fileId);

    return NextResponse.json(detail, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof AnalysisError) return analysisErrorResponse(error);
    return unexpectedErrorResponse("Analysis file failed", error);
  }
}
