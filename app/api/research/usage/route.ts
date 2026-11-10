// app/api/research/usage/route.ts
import { createResearchDeps } from "@/lib/research/research.runtime";
import { handleResearchRequest } from "@/lib/research/research.http";
import { getResearchUsage } from "@/lib/research/research.service";

/** GET - today's research usage and limits for the signed-in user. */
export async function GET() {
  return handleResearchRequest("Research usage read failed", async (userId) =>
    getResearchUsage(createResearchDeps(userId), userId),
  );
}
