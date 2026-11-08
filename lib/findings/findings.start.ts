// lib/findings/findings.start.ts
//
// The one place the production runner is wired to Prisma and the source
// storage adapter. Kept apart from findings.service.ts so the read/query
// service has no storage or driver dependency and is testable with a fake db.
import type { SourceStorage } from "@/lib/ingestion/storage/storage.types";
import { createSourceStorageAdapter } from "@/lib/ingestion/storage/storage.factory";

import {
  prismaFindingsReader,
  prismaFindingsStore,
} from "./findings.prisma-store";
import {
  runFindingsForAnalysis,
  type FindingsRunResult,
} from "./findings.runner";

/** Starts a new immutable findings run for an owned, finished analysis. */
export async function startFindingsRun(
  userId: string,
  analysisId: string,
  thresholds?: unknown,
  storage?: SourceStorage,
): Promise<FindingsRunResult> {
  return runFindingsForAnalysis(
    {
      reader: prismaFindingsReader,
      storage: storage ?? createSourceStorageAdapter(),
      store: prismaFindingsStore,
    },
    { userId, analysisId, thresholds },
  );
}
