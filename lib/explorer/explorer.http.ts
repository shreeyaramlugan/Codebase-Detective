// lib/explorer/explorer.http.ts
//
// Shared request handling for the explorer routes: session check, error
// mapping and the no-store header. Reuses the Sprint 03 error responses so
// explorer routes behave exactly like the existing analysis routes.
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

export async function handleExplorerRequest(
  label: string,
  run: (userId: string) => Promise<unknown>,
): Promise<Response> {
  try {
    const session = await requireSession();
    const body = await run(session.user.id);

    return NextResponse.json(body, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof AnalysisError) return analysisErrorResponse(error);
    return unexpectedErrorResponse(label, error);
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function readIdParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return undefined;
  if (!ID_PATTERN.test(value)) {
    throw new AnalysisError(`${name} is invalid.`, "INVALID_QUERY");
  }
  return value;
}

export function readTextParam(
  url: URL,
  name: string,
  maxLength: number,
): string | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return undefined;
  if (value.length > maxLength || value.includes("\0")) {
    throw new AnalysisError(`${name} is invalid.`, "INVALID_QUERY");
  }
  return value;
}

/** Comma-separated allow-listed values, e.g. `?kinds=FUNCTION,CLASS`. */
export function readListParam(
  url: URL,
  name: string,
  allowed: readonly string[],
): string[] | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return undefined;

  const items = value.split(",").map((item) => item.trim());
  for (const item of items) {
    if (!allowed.includes(item)) {
      throw new AnalysisError(`${name} is invalid.`, "INVALID_QUERY");
    }
  }
  return [...new Set(items)];
}

export function readBooleanParam(url: URL, name: string): boolean | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (value !== "true" && value !== "false") {
    throw new AnalysisError(`${name} must be true or false.`, "INVALID_QUERY");
  }
  return value === "true";
}
