// app/api/repositories/[repositoryId]/snapshots/route.ts
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/session";
import {
  isUnauthorized,
  sourceContentErrorResponse,
  unauthorizedResponse,
} from "@/lib/ingestion/source-content/source-content.http";
import {
  SourceContentError,
  listRepositorySnapshots,
} from "@/lib/ingestion/source-content/source-content.service";

type RouteContext = {
  params: Promise<{ repositoryId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    const { repositoryId } = await context.params;

    const snapshots = await listRepositorySnapshots(
      session.user.id,
      repositoryId,
    );

    return NextResponse.json(
      { snapshots },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof SourceContentError) {
      return sourceContentErrorResponse(error);
    }

    console.error("Snapshot history failed:", error);

    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 },
    );
  }
}
