// app/api/research/recommendations/[recommendationId]/route.ts
import { createResearchDeps } from "@/lib/research/research.runtime";
import { handleResearchRequest, readJsonObject } from "@/lib/research/research.http";
import { updateRecommendation } from "@/lib/research/research.service";

type RouteContext = { params: Promise<{ recommendationId: string }> };

/** PATCH - body: { status?, note? }. "Implemented" is set only by the user. */
export async function PATCH(request: Request, context: RouteContext) {
  return handleResearchRequest("Recommendation update failed", async (userId) => {
    const { recommendationId } = await context.params;
    return updateRecommendation(createResearchDeps(userId), userId, recommendationId, await readJsonObject(request));
  });
}
