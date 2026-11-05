// lib/ingestion/source-content/source-content.http.ts
import { NextResponse } from "next/server";

import { GitHubApiError } from "@/lib/github/github.errors";
import { EnqueueError } from "@/lib/jobs/job-enqueue";
import { SourceContentError } from "./source-content.service";

export function unauthorizedResponse() {
  return NextResponse.json(
    { error: "Authentication required." },
    { status: 401 },
  );
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof Error && error.message === "UNAUTHORIZED";
}

export function sourceContentErrorResponse(error: SourceContentError) {
  const statuses: Record<SourceContentError["code"], number> = {
    NOT_FOUND: 404,
    INVALID_PATH: 400,
    SNAPSHOT_NOT_READY: 409,
    CONTENT_UNAVAILABLE: 410,
    INTEGRITY_FAILURE: 500,
  };

  return NextResponse.json(
    { error: error.message, code: error.code },
    { status: statuses[error.code] },
  );
}

export function enqueueErrorResponse(error: EnqueueError) {
  const statuses: Record<EnqueueError["code"], number> = {
    REPOSITORY_NOT_FOUND: 404,
    JOB_ALREADY_ACTIVE: 409,
    NO_COMMITS: 422,
    NO_BRANCH: 422,
  };

  return NextResponse.json(
    { error: error.message, code: error.code },
    { status: statuses[error.code] },
  );
}

export function gitHubUnavailableResponse(error: GitHubApiError) {
  const rateLimited = error.code === "RATE_LIMITED";

  return NextResponse.json(
    {
      error: rateLimited
        ? "GitHub API rate limit reached. Please try again later."
        : "GitHub is temporarily unavailable. Please try again.",
      code: error.code,
    },
    { status: rateLimited ? 429 : 503 },
  );
}
