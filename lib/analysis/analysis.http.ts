// lib/analysis/analysis.http.ts
import { NextResponse } from "next/server";

import { AnalysisError } from "./analysis.errors";

export function analysisErrorResponse(error: AnalysisError) {
  const statuses: Record<AnalysisError["code"], number> = {
    NOT_FOUND: 404,
    SNAPSHOT_NOT_READY: 409,
    GRAPH_UNAVAILABLE: 409,
    INVALID_QUERY: 400,
  };

  return NextResponse.json(
    { error: error.message, code: error.code },
    { status: statuses[error.code] },
  );
}

export function unexpectedErrorResponse(label: string, error: unknown) {
  console.error(`${label}:`, error);
  return NextResponse.json(
    { error: "An unexpected error occurred." },
    { status: 500 },
  );
}

/** Parses ?limit= and ?cursor= for list endpoints. */
export function readPagination(url: URL): {
  limit?: number;
  cursor: string | null;
} {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new AnalysisError(
      "limit must be a positive integer.",
      "INVALID_QUERY",
    );
  }

  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && (cursor.length === 0 || cursor.length > 128)) {
    throw new AnalysisError("cursor is invalid.", "INVALID_QUERY");
  }

  return { limit, cursor };
}

/** Allow-list for enum-like filters so arbitrary text never reaches queries. */
export function readEnumParam(
  url: URL,
  name: string,
  allowed: readonly string[],
): string | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (!allowed.includes(value)) {
    throw new AnalysisError(`${name} is invalid.`, "INVALID_QUERY");
  }
  return value;
}
