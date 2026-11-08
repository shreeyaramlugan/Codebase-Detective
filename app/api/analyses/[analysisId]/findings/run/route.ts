// app/api/analyses/[analysisId]/findings/run/route.ts
import {
  handleFindingsRequest,
  readJsonBody,
  requireId,
} from "@/lib/findings/findings.http";
import { startFindingsRun } from "@/lib/findings/findings.start";

type RouteContext = { params: Promise<{ analysisId: string }> };

/**
 * POST /api/analyses/[analysisId]/findings/run
 * Body (optional): { "thresholds": { "cyclomaticMedium": 20, ... } }
 * Creates a new immutable findings run for an owned, finished analysis.
 */
export async function POST(request: Request, context: RouteContext) {
  return handleFindingsRequest(
    "Findings run failed",
    async (userId) => {
      const { analysisId } = await context.params;
      const body = (await readJsonBody(request)) as { thresholds?: unknown };
      return startFindingsRun(
        userId,
        requireId(analysisId, "analysisId"),
        body?.thresholds,
      );
    },
    201,
  );
}
