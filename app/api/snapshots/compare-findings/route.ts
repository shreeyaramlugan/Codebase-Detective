// app/api/snapshots/compare-findings/route.ts
import { FindingsError } from "@/lib/findings/findings.errors";
import {
  handleFindingsRequest,
  readJsonBody,
  requireId,
} from "@/lib/findings/findings.http";
import { compareSnapshotFindings } from "@/lib/findings/findings.service";

/**
 * POST /api/snapshots/compare-findings
 * Body: { "baseSnapshotId": string, "headSnapshotId": string }
 * Compares the latest finished findings run of each (owned) snapshot.
 */
export async function POST(request: Request) {
  return handleFindingsRequest("Snapshot comparison failed", async (userId) => {
    const body = (await readJsonBody(request)) as {
      baseSnapshotId?: unknown;
      headSnapshotId?: unknown;
    };

    if (
      typeof body?.baseSnapshotId !== "string" ||
      typeof body?.headSnapshotId !== "string"
    ) {
      throw new FindingsError(
        "baseSnapshotId and headSnapshotId are required.",
        "INVALID_INPUT",
      );
    }

    return compareSnapshotFindings(
      userId,
      requireId(body.baseSnapshotId, "baseSnapshotId"),
      requireId(body.headSnapshotId, "headSnapshotId"),
    );
  });
}
