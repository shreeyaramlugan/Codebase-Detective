// lib/jobs/job.http.ts
//
// Shared request handling for the job endpoints and for routes that enqueue
// background work: session check, error mapping, no-store header. Responses
// never contain stack traces, payloads, lock owners or internal exceptions.
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/session";
import {
  isUnauthorized,
  unauthorizedResponse,
} from "@/lib/ingestion/source-content/source-content.http";
import { AnalysisError } from "@/lib/analysis/analysis.errors";
import { FindingsError } from "@/lib/findings/findings.errors";
import { ResearchError } from "@/lib/research/research.errors";

import { JobNotFoundError, isWorkerAdmin } from "./job-admin";
import { PipelineEnqueueError, type PipelineEnqueueCode } from "./job-enqueue-pipeline";
import { JobTransitionError } from "./job-errors";

const NO_STORE = { "Cache-Control": "private, no-store" };

const ENQUEUE_STATUS: Record<PipelineEnqueueCode, number> = {
  NOT_FOUND: 404,
  INVALID_PAYLOAD: 400,
  SNAPSHOT_NOT_READY: 409,
  ANALYSIS_NOT_READY: 409,
  BUSY: 409,
};

const TRANSITION_MESSAGES: Record<string, string> = {
  JOB_NOT_FOUND: "Job not found.",
  MAX_ATTEMPTS_REACHED: "This job has reached its maximum retry attempts.",
  INVALID_TRANSITION: "This job is not currently eligible for retry.",
  JOB_ALREADY_CLAIMED: "This job is already being processed.",
};

export class ForbiddenError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "ForbiddenError";
  }
}

/** Throws ForbiddenError unless the user is an operator listed in WORKER_ADMIN_USER_IDS. */
export function requireWorkerAdmin(userId: string): void {
  if (!isWorkerAdmin(userId)) throw new ForbiddenError();
}

export async function handleJobRequest(
  label: string,
  run: (userId: string) => Promise<unknown>,
  status = 200,
): Promise<Response> {
  try {
    const session = await requireSession();
    const body = await run(session.user.id);
    return NextResponse.json(body, { status, headers: NO_STORE });
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof ForbiddenError) {
      // Indistinguishable from a missing route for non-operators.
      return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    }
    if (error instanceof JobNotFoundError) {
      return NextResponse.json({ error: "Job not found.", code: "NOT_FOUND" }, { status: 404, headers: NO_STORE });
    }
    if (error instanceof PipelineEnqueueError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: ENQUEUE_STATUS[error.code], headers: NO_STORE },
      );
    }
    if (error instanceof JobTransitionError) {
      return NextResponse.json(
        { error: TRANSITION_MESSAGES[error.code] ?? "Unable to update the job.", code: error.code },
        { status: error.code === "JOB_NOT_FOUND" ? 404 : 409, headers: NO_STORE },
      );
    }
    if (error instanceof ResearchError) {
      const status = { NOT_FOUND: 404, INVALID_INPUT: 400, UNSUPPORTED: 422, CONTEXT_UNAVAILABLE: 409, LIMIT_EXCEEDED: 429, BUSY: 409, INVALID_STATE: 409, PROVIDER_ERROR: 502, NOT_CONFIGURED: 503 }[error.code];
      return NextResponse.json({ error: error.message, code: error.code }, { status, headers: NO_STORE });
    }
    if (error instanceof AnalysisError || error instanceof FindingsError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "INVALID_INPUT" ? 400 : 409;
      return NextResponse.json({ error: error.message, code: error.code }, { status, headers: NO_STORE });
    }
    if (error instanceof Error && error.name === "AIError") {
      return NextResponse.json({ error: error.message, code: "INVALID_INPUT" }, { status: 400, headers: NO_STORE });
    }
    console.error(`${label}:`, error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "An unexpected error occurred." }, { status: 500, headers: NO_STORE });
  }
}
