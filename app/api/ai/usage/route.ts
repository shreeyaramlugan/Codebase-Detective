// app/api/ai/usage/route.ts
import { handleAIRequest } from "@/lib/ai/ai.http";
import { createAIDeps } from "@/lib/ai/ai.runtime";
import { getUsage } from "@/lib/ai/ai.service";

/** GET - today's usage and the configured limits for the signed-in user. */
export async function GET() {
  return handleAIRequest("AI usage read failed", async (userId) =>
    getUsage(createAIDeps(userId), userId),
  );
}
