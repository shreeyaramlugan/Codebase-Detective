// app/api/research/runs/[runId]/sources/route.ts
import { createResearchDeps } from "@/lib/research/research.runtime";
import { handleResearchRequest, readJsonObject } from "@/lib/research/research.http";
import { reviewSources } from "@/lib/research/research.service";

type RouteContext = { params: Promise<{ runId: string }> };

/** PATCH - source review before synthesis. Body: { included: { [sourceKey]: boolean } } */
export async function PATCH(request: Request, context: RouteContext) {
  return handleResearchRequest("Research source review failed", async (userId) => {
    const { runId } = await context.params;
    return reviewSources(createResearchDeps(userId), userId, runId, await readJsonObject(request));
  });
}
