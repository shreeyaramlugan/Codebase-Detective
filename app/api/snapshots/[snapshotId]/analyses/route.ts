// app/api/snapshots/[snapshotId]/analyses/route.ts
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
import { listSnapshotAnalyses } from "@/lib/analysis/analysis.service";

type RouteContext = { params: Promise<{ snapshotId: string }> };

/** GET /api/snapshots/[snapshotId]/analyses - analysis history, newest first. */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    const { snapshotId } = await context.params;

    const analyses = await listSnapshotAnalyses(session.user.id, snapshotId);

    return NextResponse.json(
      { analyses },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof AnalysisError) return analysisErrorResponse(error);
    return unexpectedErrorResponse("Analysis history failed", error);
  }
}
