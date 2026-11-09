// app/api/ai/conversations/[conversationId]/route.ts
import { handleAIRequest, readJsonObject } from "@/lib/ai/ai.http";
import { createAIDeps } from "@/lib/ai/ai.runtime";
import {
  deleteConversation,
  getConversation,
  updateConversation,
} from "@/lib/ai/ai.service";

type RouteContext = { params: Promise<{ conversationId: string }> };

/** GET - conversation details and its current snapshot context. */
export async function GET(_request: Request, context: RouteContext) {
  return handleAIRequest("AI conversation read failed", async (userId) => {
    const { conversationId } = await context.params;
    return getConversation(createAIDeps(userId), userId, conversationId);
  });
}

/**
 * PATCH - body: { title?, archived?: boolean, snapshotId? }
 * `snapshotId` is the explicit snapshot switch; it is recorded as a system
 * message and never changes the provenance of earlier messages.
 */
export async function PATCH(request: Request, context: RouteContext) {
  return handleAIRequest("AI conversation update failed", async (userId) => {
    const { conversationId } = await context.params;
    const body = await readJsonObject(request);
    return updateConversation(createAIDeps(userId), userId, conversationId, body);
  });
}

/** DELETE - permanently removes the conversation and its messages. */
export async function DELETE(_request: Request, context: RouteContext) {
  return handleAIRequest("AI conversation delete failed", async (userId) => {
    const { conversationId } = await context.params;
    return deleteConversation(createAIDeps(userId), userId, conversationId);
  });
}
