// app/api/findings/[findingId]/review/route.ts
import { FindingsError } from "@/lib/findings/findings.errors";
import {
  handleFindingsRequest,
  readJsonBody,
  requireId,
} from "@/lib/findings/findings.http";
import { setFindingReview } from "@/lib/findings/findings.service";

type RouteContext = { params: Promise<{ findingId: string }> };

/**
 * PUT /api/findings/[findingId]/review
 * Body: { "status": "ACKNOWLEDGED" | "DISMISSED" | null, "reason"?: string }
 * Triage only; it never changes what the engine detected.
 */
export async function PUT(request: Request, context: RouteContext) {
  return handleFindingsRequest("Finding review failed", async (userId) => {
    const { findingId } = await context.params;
    const body = (await readJsonBody(request)) as {
      status?: unknown;
      reason?: unknown;
    };

    if (
      body === null ||
      typeof body !== "object" ||
      !("status" in body) ||
      (body.status !== null && typeof body.status !== "string") ||
      (body.reason !== undefined &&
        body.reason !== null &&
        typeof body.reason !== "string")
    ) {
      throw new FindingsError("Request body is invalid.", "INVALID_INPUT");
    }

    return setFindingReview(userId, requireId(findingId, "findingId"), {
      status: body.status as "ACKNOWLEDGED" | "DISMISSED" | null,
      reason: (body.reason as string | null | undefined) ?? null,
    });
  });
}
