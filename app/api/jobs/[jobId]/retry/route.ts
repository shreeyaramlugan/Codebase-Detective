import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { requireSession } from "@/lib/auth/session";
import { retryIndexingJob } from "@/lib/jobs/job-lifecycle";
import { JobTransitionError } from "@/lib/jobs/job-errors";

type RouteContext = {
  params: Promise<{
    jobId: string;
  }>;
};

export async function POST(_request: Request, context: RouteContext) {
  try {
    const session = await requireSession();

    const { jobId } = await context.params;

    if (!jobId || typeof jobId !== "string") {
      return NextResponse.json(
        { error: "Invalid indexing job ID." },
        { status: 400 },
      );
    }

    // Verify that this job belongs to the authenticated user.
    const ownedJob = await prisma.indexingJob.findFirst({
      where: {
        id: jobId,
        repository: {
          ownerId: session.user.id,
        },
      },
      select: {
        id: true,
      },
    });

    if (!ownedJob) {
      return NextResponse.json(
        { error: "Indexing job not found." },
        { status: 404 },
      );
    }

    const job = await retryIndexingJob(jobId);

    return NextResponse.json({
      message: "Indexing job queued for retry.",
      job: {
        id: job.id,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        nextRetryAt: job.nextRetryAt?.toISOString() ?? null,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 },
      );
    }

    if (error instanceof JobTransitionError) {
      const status = error.code === "JOB_NOT_FOUND" ? 404 : 409;

      const messages: Record<string, string> = {
        JOB_NOT_FOUND: "Indexing job not found.",
        MAX_ATTEMPTS_REACHED:
          "This job has reached its maximum retry attempts.",
        INVALID_TRANSITION: "This job is not currently eligible for retry.",
        JOB_ALREADY_CLAIMED: "This job is already being processed.",
      };

      return NextResponse.json(
        {
          error: messages[error.code] ?? "Unable to retry indexing job.",
          code: error.code,
        },
        { status },
      );
    }

    console.error("Indexing job retry failed:", error);

    return NextResponse.json(
      { error: "An unexpected error occurred while retrying the job." },
      { status: 500 },
    );
  }
}
