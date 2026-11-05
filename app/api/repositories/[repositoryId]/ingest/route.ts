// app/api/repositories/[repositoryId]/ingest/route.ts
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/session";
import { GitHubApiError } from "@/lib/github/github.errors";
import {
  enqueueErrorResponse,
  gitHubUnavailableResponse,
  isUnauthorized,
  unauthorizedResponse,
} from "@/lib/ingestion/source-content/source-content.http";
import { EnqueueError, enqueueIngestionJob } from "@/lib/jobs/job-enqueue";

type RouteContext = {
  params: Promise<{ repositoryId: string }>;
};

/**
 * Queue ingestion for an owned repository. Also used to retry the failed
 * files of a PARTIAL snapshot: the worker reuses the snapshot for the
 * commit and only retries files that did not succeed.
 */
export async function POST(_request: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    const { repositoryId } = await context.params;

    if (!repositoryId) {
      return NextResponse.json(
        { error: "Invalid repository ID." },
        { status: 400 },
      );
    }

    const job = await enqueueIngestionJob({
      repositoryId,
      ownerId: session.user.id,
    });

    return NextResponse.json(
      {
        message: "Ingestion queued.",
        job: {
          id: job.id,
          status: job.status,
          targetCommitSha: job.targetCommitSha,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
        },
      },
      { status: 202 },
    );
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof EnqueueError) return enqueueErrorResponse(error);
    if (error instanceof GitHubApiError) {
      return gitHubUnavailableResponse(error);
    }

    console.error("Ingestion enqueue failed:", error);

    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 },
    );
  }
}
