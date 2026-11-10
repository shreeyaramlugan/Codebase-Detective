// app/api/research/runs/[runId]/synthesize/route.ts
import { createResearchDeps } from "@/lib/research/research.runtime";
import { handleResearchRequest } from "@/lib/research/research.http";
import { synthesiseRun } from "@/lib/research/research.service";

type RouteContext = { params: Promise<{ runId: string }> };

/** POST - synthesise recommendations from the sources the user kept. */
export async function POST(_request: Request, context: RouteContext) {
  return handleResearchRequest("Research synthesis failed", async (userId) => {
    const { runId } = await context.params;
    return synthesiseRun(createResearchDeps(userId), userId, runId);
  });
}
