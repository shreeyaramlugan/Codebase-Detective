// app/api/health/worker/route.ts
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { workerIsHealthy } from "@/lib/jobs/job-admin";

/**
 * GET - is a worker alive? Public and minimal on purpose: only a boolean-ish
 * status and counts, no job data, worker ids or hostnames.
 */
export async function GET() {
  try {
    const staleAfterMs = Number(process.env.WORKER_STALE_AFTER_MS) || 90_000;
    const [workers, queued] = await Promise.all([
      prisma.workerInstance.findMany({
        where: { status: { in: ["STARTING", "RUNNING"] } },
        select: { status: true, lastHeartbeatAt: true },
      }),
      prisma.indexingJob.count({ where: { status: "PENDING" } }),
    ]);
    const now = new Date();
    const healthy = workers.filter((w) => workerIsHealthy(w, now, staleAfterMs)).length;
    const ok = healthy > 0;
    return NextResponse.json(
      { worker: ok ? "running" : "unavailable", healthyWorkers: healthy, queuedJobs: queued },
      { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ worker: "unknown" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
