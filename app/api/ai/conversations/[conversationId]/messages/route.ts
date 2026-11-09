// app/api/ai/conversations/[conversationId]/messages/route.ts
import { handleAIRequest, readJsonObject } from "@/lib/ai/ai.http";
import { AIError } from "@/lib/ai/ai.errors";
import { createAIDeps } from "@/lib/ai/ai.runtime";
import { listMessages, sendMessage } from "@/lib/ai/ai.service";

type RouteContext = { params: Promise<{ conversationId: string }> };

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new AIError(`${name} is invalid.`, "INVALID_INPUT");
  }
  return value;
}

/** GET - messages in order. ?limit= and ?after=<sequence> page through them. */
export async function GET(request: Request, context: RouteContext) {
  return handleAIRequest("AI messages list failed", async (userId) => {
    const { conversationId } = await context.params;
    const url = new URL(request.url);
    return listMessages(createAIDeps(userId), userId, conversationId, {
      limit: intParam(url, "limit"),
      after: intParam(url, "after"),
    });
  });
}

/**
 * POST - body: { question: string }. Responds only after the answer has been
 * generated and its citations validated (no streaming).
 */
export async function POST(request: Request, context: RouteContext) {
  return handleAIRequest(
    "AI message failed",
    async (userId) => {
      const { conversationId } = await context.params;
      const body = await readJsonObject(request);
      return sendMessage(createAIDeps(userId), userId, conversationId, body);
    },
    201,
  );
}
