// app/api/research/runs/[runId]/route.ts
import { createResearchDeps } from "@/lib/research/research.runtime";
import { handleResearchRequest, readJsonObject } from "@/lib/research/research.http";
import { deleteRun, getRun, updateRun } from "@/lib/research/research.service";

type RouteContext = { params: Promise<{ runId: string }> };

/** GET - run, its sources (with passages) and recommendations. */
export async function GET(_request: Request, context: RouteContext) {
  return handleResearchRequest("Research run read failed", async (userId) => {
    const { runId } = await context.params;
    return getRun(createResearchDeps(userId), userId, runId);
  });
}

/** PATCH - body: { title?, archived?: boolean }. Evidence and results never change. */
export async function PATCH(request: Request, context: RouteContext) {
  return handleResearchRequest("Research run update failed", async (userId) => {
    const { runId } = await context.params;
    return updateRun(createResearchDeps(userId), userId, runId, await readJsonObject(request));
  });
}

/** DELETE - permanently removes the run, its source links and recommendations. */
export async function DELETE(_request: Request, context: RouteContext) {
  return handleResearchRequest("Research run delete failed", async (userId) => {
    const { runId } = await context.params;
    return deleteRun(createResearchDeps(userId), userId, runId);
  });
}
