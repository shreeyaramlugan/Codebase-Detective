// lib/research/research.runtime.ts
//
// The one place research is wired to Prisma, storage, the source providers and
// the configured AI provider. The contact email for Crossref/OpenAlex comes only
// from the optional RESEARCH_CONTACT_EMAIL variable; the signed-in user's email
// is never sent to third parties.
import { createAIProvider } from "@/features/ai/providers/provider-factory";
import { resolveResearchLimits, resolveRuntimeOptions } from "@/features/research/engine/config";
import { CrossrefProvider } from "@/features/research/engine/providers/crossref";
import { OfficialDocsProvider } from "@/features/research/engine/providers/official-docs";
import { OpenAlexProvider } from "@/features/research/engine/providers/openalex";
import { createPrismaReader } from "@/lib/ai/ai.prisma-reader";
import { createSourceStorageAdapter } from "@/lib/ingestion/storage/storage.factory";

import type { ResearchDeps } from "./research.service";
import { prismaResearchStore } from "./research.prisma-store";

// Provider instances are module scoped so their rate limiters are shared by
// every request handled by this process.
const options = resolveRuntimeOptions(process.env);
const providers = [
  new OfficialDocsProvider({ fetchImpl: (url, init) => fetch(url, init) }),
  new CrossrefProvider({ contactEmail: options.contactEmail, fetchImpl: (url, init) => fetch(url, init) }),
  new OpenAlexProvider({ contactEmail: options.contactEmail, fetchImpl: (url, init) => fetch(url, init) }),
];

export function createResearchDeps(userId: string): ResearchDeps {
  return {
    store: prismaResearchStore,
    reader: createPrismaReader(userId, createSourceStorageAdapter()),
    providers,
    provider: createAIProvider,
    limits: resolveResearchLimits(process.env),
  };
}
