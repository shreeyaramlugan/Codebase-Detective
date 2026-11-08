// lib/findings/findings.http.ts
//
// Shared request handling for the findings routes: session check, error
// mapping and the no-store header.
import { NextResponse } from "next/server";

import { AnalysisError } from "@/lib/analysis/analysis.errors";
import {
  analysisErrorResponse,
  unexpectedErrorResponse,
} from "@/lib/analysis/analysis.http";
import { requireSession } from "@/lib/auth/session";
import {
  isUnauthorized,
  unauthorizedResponse,
} from "@/lib/ingestion/source-content/source-content.http";

import { FindingsError, type FindingsErrorCode } from "./findings.errors";

const STATUSES: Record<FindingsErrorCode, number> = {
  NOT_FOUND: 404,
  ANALYSIS_NOT_READY: 409,
  INVALID_INPUT: 400,
  INCOMPATIBLE_RUNS: 409,
};

export async function handleFindingsRequest(
  label: string,
  run: (userId: string) => Promise<unknown>,
  status = 200,
): Promise<Response> {
  try {
    const session = await requireSession();
    const body = await run(session.user.id);

    return NextResponse.json(body, {
      status,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof AnalysisError) return analysisErrorResponse(error);
    if (error instanceof FindingsError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUSES[error.code] },
      );
    }
    return unexpectedErrorResponse(label, error);
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function requireId(value: string, name: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new FindingsError(`${name} is invalid.`, "INVALID_INPUT");
  }
  return value;
}

/** Reads a JSON body of bounded size; anything malformed is INVALID_INPUT. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length === 0) return {};
  if (text.length > 4096) {
    throw new FindingsError("Request body is too large.", "INVALID_INPUT");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new FindingsError("Request body is not valid JSON.", "INVALID_INPUT");
  }
}
