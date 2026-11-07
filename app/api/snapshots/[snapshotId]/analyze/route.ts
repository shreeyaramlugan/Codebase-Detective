// app/api/snapshots/[snapshotId]/analyze/route.ts
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
import { startSnapshotAnalysis } from "@/lib/analysis/analysis.service";

type RouteContext = { params: Promise<{ snapshotId: string }> };

/**
 * POST /api/snapshots/[snapshotId]/analyze
 *
 * Starts a NEW immutable analysis run for a snapshot the user owns. The body
 * is ignored: the client can only name a snapshot, never a storage path.
 * Repeating the call creates another run; earlier runs are never modified.
 */
export async function POST(_request: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    const { snapshotId } = await context.params;

    const result = await startSnapshotAnalysis(session.user.id, snapshotId);

    return NextResponse.json(
      {
        analysisId: result.analysisId,
        status: result.status,
        errorCode: result.errorCode,
      },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof AnalysisError) return analysisErrorResponse(error);
    return unexpectedErrorResponse("Analysis start failed", error);
  }
}
