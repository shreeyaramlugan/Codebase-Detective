// lib/ai/ai.runtime.ts
//
// The one place the assistant is wired to Prisma, the source storage adapter
// and the configured provider. Kept apart from ai.service.ts so the service has
// no storage or driver dependency and is testable with fakes.
import { resolveLimits } from "@/features/ai/assistant/config";
import { createAIProvider } from "@/features/ai/providers/provider-factory";
import { createSourceStorageAdapter } from "@/lib/ingestion/storage/storage.factory";

import { createPrismaReader } from "./ai.prisma-reader";
import { prismaAIStore } from "./ai.prisma-store";
import type { AIDeps } from "./ai.service";

export function createAIDeps(userId: string): AIDeps {
  return {
    store: prismaAIStore,
    reader: createPrismaReader(userId, createSourceStorageAdapter()),
    provider: createAIProvider,
    limits: resolveLimits(),
  };
}
