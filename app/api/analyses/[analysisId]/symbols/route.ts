// app/api/analyses/[analysisId]/symbols/route.ts
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/session";
import { AnalysisError } from "@/lib/analysis/analysis.errors";
import {
  analysisErrorResponse,
  unexpectedErrorResponse,
  readEnumParam,
  readPagination,
} from "@/lib/analysis/analysis.http";
import {
  isUnauthorized,
  unauthorizedResponse,
} from "@/lib/ingestion/source-content/source-content.http";
import { listAnalysisSymbols } from "@/lib/analysis/analysis.service";

type RouteContext = { params: Promise<{ analysisId: string }> };

const SYMBOL_KINDS = [
  "FUNCTION",
  "CLASS",
  "METHOD",
  "INTERFACE",
  "TYPE",
  "VARIABLE",
  "ENUM",
] as const;

/** GET /api/analyses/[analysisId]/symbols?kind=&path=&name=&exported=&limit=&cursor= */
export async function GET(request: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    const { analysisId } = await context.params;
    const url = new URL(request.url);

    const exported = url.searchParams.get("exported");
    if (exported !== null && exported !== "true" && exported !== "false") {
      throw new AnalysisError(
        "exported must be true or false.",
        "INVALID_QUERY",
      );
    }

    const page = await listAnalysisSymbols(session.user.id, analysisId, {
      ...readPagination(url),
      kind: readEnumParam(url, "kind", SYMBOL_KINDS),
      path: url.searchParams.get("path") ?? undefined,
      name: url.searchParams.get("name") ?? undefined,
      exported: exported === null ? undefined : exported === "true",
    });

    return NextResponse.json(page, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (isUnauthorized(error)) return unauthorizedResponse();
    if (error instanceof AnalysisError) return analysisErrorResponse(error);
    return unexpectedErrorResponse("Analysis symbols failed", error);
  }
}
