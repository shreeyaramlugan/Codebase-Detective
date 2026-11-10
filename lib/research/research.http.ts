// lib/research/research.http.ts
//
// Shared request handling for the research routes: session check, error
// mapping and the no-store header. Responses never include stack traces,
// credentials or raw provider diagnostics.
import { NextResponse } from "next/server";

import { unexpectedErrorResponse } from "@/lib/analysis/analysis.http";
import { readJsonObject } from "@/lib/ai/ai.http";
import { requireSession } from "@/lib/auth/session";
import {
  isUnauthorized,
  unauthorizedResponse,
} from "@/lib/ingestion/source-content/source-content.http";

import { ResearchError, type ResearchErrorCode } from "./research.errors";

const STATUSES: Record<ResearchErrorCode, number> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  UNSUPPORTED: 422,
  CONTEXT_UNAVAILABLE: 409,
  LIMIT_EXCEEDED: 429,
  BUSY: 409,
  INVALID_STATE: 409,
  PROVIDER_ERROR: 502,
  NOT_CONFIGURED: 503,
};

const NO_STORE = { "Cache-Control": "private, no-store" };

export { readJsonObject };

export async function handleResearchRequest(
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
    if (error instanceof ResearchError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          ...(error.options.retryable !== undefined ? { retryable: error.options.retryable } : {}),
          ...(error.options.resetsAt ? { resetsAt: error.options.resetsAt } : {}),
          ...(error.options.data ?? {}),
        },
        { status: error.options.status ?? STATUSES[error.code], headers: NO_STORE },
      );
    }
    // readJsonObject throws AIError for malformed bodies.
    if (error instanceof Error && error.name === "AIError") {
      return NextResponse.json({ error: error.message, code: "INVALID_INPUT" }, { status: 400, headers: NO_STORE });
    }
    return unexpectedErrorResponse(label, error);
  }
}
