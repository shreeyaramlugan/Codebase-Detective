// app/api/repositories/[repositoryId]/snapshots/[snapshotId]/files/content/route.ts
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/session";
import {
  isUnauthorized,
  sourceContentErrorResponse,
  unauthorizedResponse,
} from "@/lib/ingestion/source-content/source-content.http";
import {
  SourceContentError,
  readSnapshotFileContent,
} from "@/lib/ingestion/source-content/source-content.service";

type RouteContext = {
  params: Promise<{ repositoryId: string; snapshotId: string }>;
};

/**
 * GET ...?path=src/index.ts
 *
 * Returns stored source as inert text. Repository content is untrusted, so
 * it is never served as HTML and the browser is told not to sniff it.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    const { repositoryId, snapshotId } = await context.params;

    const path = new URL(request.url).searchParams.get("path");

    if (!path) {
      return NextResponse.json(
        { error: "A file path is required.", code: "INVALID_PATH" },
        { status: 400 },
      );
    }

    const file = await readSnapshotFileContent({
      userId: session.user.id,
      repositoryId,
      snapshotId,
      path,
    });

    return new NextResponse(new Uint8Array(file.content), {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(file.sizeBytes),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
        ETag: `"${file.contentHash}"`,
      },
    });
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof SourceContentError) {
      return sourceContentErrorResponse(error);
    }

    console.error("Source content read failed:", error);

    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 },
    );
  }
}
