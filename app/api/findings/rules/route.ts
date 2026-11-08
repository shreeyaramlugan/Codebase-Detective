// app/api/findings/rules/route.ts
import { handleFindingsRequest } from "@/lib/findings/findings.http";
import { listRuleCatalogue } from "@/lib/findings/findings.service";

/** GET /api/findings/rules - the versioned rule catalogue. */
export async function GET() {
  return handleFindingsRequest("Rule catalogue failed", async () =>
    listRuleCatalogue(),
  );
}
