// lib/ai/ai.http.ts
//
// Shared request handling for the assistant routes: session check, error
// mapping and the no-store header. Responses never include stack traces,
// credentials or raw provider diagnostics.
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/session";
import { unexpectedErrorResponse } from "@/lib/analysis/analysis.http";
import {
  isUnauthorized,
  unauthorizedResponse,
} from "@/lib/ingestion/source-content/source-content.http";

import { AIError, type AIErrorCode } from "./ai.errors";

const STATUSES: Record<AIErrorCode, number> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  CONTEXT_UNAVAILABLE: 409,
  LIMIT_EXCEEDED: 429,
  BUSY: 409,
  PROVIDER_ERROR: 502,
  NOT_CONFIGURED: 503,
};

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function handleAIRequest(
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
    if (error instanceof AIError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          ...(error.options.retryable !== undefined
            ? { retryable: error.options.retryable }
            : {}),
          ...(error.options.resetsAt ? { resetsAt: error.options.resetsAt } : {}),
          ...(error.options.data ?? {}),
        },
        {
          status: error.options.status ?? STATUSES[error.code],
          headers: NO_STORE,
        },
      );
    }
    return unexpectedErrorResponse(label, error);
  }
}

const MAX_BODY = 16_384;

/** Reads a JSON object body of bounded size; anything else is INVALID_INPUT. */
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length === 0) return {};
  if (text.length > MAX_BODY) {
    throw new AIError("Request body is too large.", "INVALID_INPUT");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AIError("Request body is not valid JSON.", "INVALID_INPUT");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AIError("Request body must be a JSON object.", "INVALID_INPUT");
  }
  return parsed as Record<string, unknown>;
}
