// app/api/repositories/[repositoryId]/snapshots/[snapshotId]/files/route.ts
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/session";
import {
  isUnauthorized,
  sourceContentErrorResponse,
  unauthorizedResponse,
} from "@/lib/ingestion/source-content/source-content.http";
import {
  SourceContentError,
  isSnapshotFileStatusFilter,
  listSnapshotFiles,
} from "@/lib/ingestion/source-content/source-content.service";

type RouteContext = {
  params: Promise<{ repositoryId: string; snapshotId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    const { repositoryId, snapshotId } = await context.params;

    const statusParam = new URL(request.url).searchParams.get("status");

    if (statusParam !== null && !isSnapshotFileStatusFilter(statusParam)) {
      return NextResponse.json(
        { error: "Invalid status filter." },
        { status: 400 },
      );
    }

    const files = await listSnapshotFiles(
      session.user.id,
      repositoryId,
      snapshotId,
      statusParam ?? undefined,
    );

    return NextResponse.json(
      { files },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof SourceContentError) {
      return sourceContentErrorResponse(error);
    }

    console.error("Snapshot file listing failed:", error);

    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 },
    );
  }
}
