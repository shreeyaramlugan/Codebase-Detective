// app/api/repositories/[repositoryId]/ai/conversations/route.ts
import { handleAIRequest, readJsonObject } from "@/lib/ai/ai.http";
import { createAIDeps } from "@/lib/ai/ai.runtime";
import { createConversation, listConversations } from "@/lib/ai/ai.service";

type RouteContext = { params: Promise<{ repositoryId: string }> };

/**
 * GET /api/repositories/[repositoryId]/ai/conversations
 * Active conversations (?archived=true for the archive) plus the snapshots the
 * user can explicitly switch between.
 */
export async function GET(request: Request, context: RouteContext) {
  return handleAIRequest("AI conversations list failed", async (userId) => {
    const { repositoryId } = await context.params;
    const archived =
      new URL(request.url).searchParams.get("archived") === "true";
    return listConversations(createAIDeps(userId), userId, repositoryId, archived);
  });
}

/** POST - body: { snapshotId?: string, title?: string } */
export async function POST(request: Request, context: RouteContext) {
  return handleAIRequest(
    "AI conversation create failed",
    async (userId) => {
      const { repositoryId } = await context.params;
      const body = await readJsonObject(request);
      return createConversation(createAIDeps(userId), userId, repositoryId, body);
    },
    201,
  );
}
