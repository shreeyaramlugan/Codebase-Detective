// tests/fixtures/research/fakes.ts
import type { AIProvider } from "../../../features/ai/providers/ai-provider";
import type { SnapshotScope } from "../../../features/ai/assistant/contracts";
import { DEFAULT_RESEARCH_LIMITS } from "../../../features/research/engine/config";
import type {
  QueryPlan,
  ResearchLimits,
  SourceRecord,
} from "../../../features/research/engine/contracts";
import { emptyDiagnostic, type SourceProvider } from "../../../features/research/engine/providers/types";
import type { ResearchDeps } from "../../../lib/research/research.service";
import type {
  RecommendationRow,
  ResearchFinding,
  ResearchStore,
  RunRow,
  RunSourceRow,
  UsageCounter,
} from "../../../lib/research/research.store";
import { EmptyReader, ScriptedProvider, jsonReply, makeScope } from "../ai/fakes";

export { EmptyReader, ScriptedProvider, jsonReply, makeScope };

export function makeRecord(over: Partial<SourceRecord> = {}): SourceRecord {
  return {
    sourceKey: "src_a",
    kind: "OFFICIAL_DOCUMENTATION",
    sourceClass: "OFFICIAL",
    classificationBasis: "Published by the project that maintains the technology.",
    title: "Circular dependencies in modules",
    publisher: "MDN",
    authors: [],
    container: null,
    canonicalUrl: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules",
    doi: null,
    externalIds: {},
    publishedAt: null,
    updatedAt: "2026-06-01",
    contentLevel: "FULL_TEXT",
    availability: "AVAILABLE",
    doiFromProvider: false,
    provider: "official-docs",
    retrievedAt: "2026-11-09T10:00:00.000Z",
    excerpt: "Modules that import each other form a cycle. Cycles can leave bindings uninitialised.",
    contentHash: "h1",
    openAccess: null,
    license: null,
    citedByCount: null,
    ...over,
  };
}

export class FakeProvider implements SourceProvider {
  calls = 0;
  constructor(
    readonly name: SourceProvider["name"],
    private readonly records: SourceRecord[],
    private readonly fail = false,
  ) {}
  async discover(query: QueryPlan, ctx: Parameters<SourceProvider["discover"]>[1]) {
    this.calls += 1;
    await ctx.countRequest();
    if (this.fail) return { sources: [], diagnostic: emptyDiagnostic(this.name, query, "UNAVAILABLE", "down") };
    return {
      sources: this.records.map((record) => ({
        record,
        sections: [{ heading: "Cycles", text: record.excerpt }],
        reused: false,
      })),
      diagnostic: { provider: this.name, queryOrdinal: query.ordinal, status: "OK" as const, returned: this.records.length, durationMs: 1, note: null },
    };
  }
}

export const FINDING: ResearchFinding = {
  id: "fnd1",
  fingerprint: "fnd_" + "a".repeat(32),
  ruleId: "DEP003",
  severity: "MEDIUM",
  certainty: "CONFIRMED",
  title: "Circular dependency",
  description: "src/a.ts and src/b.ts import each other.",
  subjectPath: "src/a.ts",
  primaryLine: 1,
  measurements: null,
  evidence: [{ message: "a imports b", filePath: "src/a.ts", startLine: 1, endLine: 1 }],
  repositoryId: "repo1",
  analysisId: "an1",
  snapshotId: "snap1",
};

export class FakeResearchStore implements ResearchStore {
  runs: RunRow[] = [];
  sources: RunSourceRow[] = [];
  recs: RecommendationRow[] = [];
  cache = new Map<string, { record: SourceRecord; expiresAt: Date }>();
  usage = new Map<string, Record<string, number>>();
  audit: unknown[] = [];
  findings: ResearchFinding[] = [FINDING];
  /** repository id -> owner */
  owners = new Map<string, string>([["repo1", "u1"]]);
  scope: SnapshotScope | null = makeScope();
  private seq = 0;
  private next = (p: string) => `${p}${++this.seq}`;

  async repositoryExists(userId: string, repositoryId: string) {
    return this.owners.get(repositoryId) === userId;
  }
  async resolveScope(userId: string, repositoryId: string) {
    return this.owners.get(repositoryId) === userId ? this.scope : null;
  }
  async findFinding(userId: string, findingId: string) {
    const f = this.findings.find((x) => x.id === findingId);
    return f && this.owners.get(f.repositoryId) === userId ? f : null;
  }
  async createRun(draft: Parameters<ResearchStore["createRun"]>[0], lockUntil: Date) {
    const row: RunRow = {
      ...draft,
      id: this.next("run"),
      status: "DISCOVERING",
      diagnostics: null,
      discarded: null,
      partial: false,
      synthesis: null,
      provider: null,
      model: null,
      totalTokens: null,
      errorCode: null,
      busyUntil: lockUntil,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    };
    this.runs.push(row);
    return row;
  }
  async findRun(userId: string, runId: string) {
    return this.runs.find((r) => r.id === runId && r.userId === userId) ?? null;
  }
  async listRuns(userId: string, repositoryId: string, opts: { archived: boolean; findingFingerprint?: string; limit: number }) {
    return this.runs
      .filter((r) => r.userId === userId && r.repositoryId === repositoryId && (r.archivedAt !== null) === opts.archived)
      .filter((r) => !opts.findingFingerprint || r.findingFingerprint === opts.findingFingerprint)
      .slice(0, opts.limit);
  }
  async updateRun(userId: string, runId: string, patch: { title?: string; archivedAt?: Date | null }) {
    const r = await this.findRun(userId, runId);
    if (!r) return null;
    Object.assign(r, patch);
    return r;
  }
  async deleteRun(userId: string, runId: string) {
    const r = await this.findRun(userId, runId);
    if (!r) return false;
    this.runs = this.runs.filter((x) => x !== r);
    this.sources = this.sources.filter((s) => s.runId !== runId);
    this.recs = this.recs.filter((s) => s.runId !== runId);
    return true;
  }
  async acquireLock(runId: string, now: Date, until: Date, requireStatus?: RunRow["status"]) {
    const r = this.runs.find((x) => x.id === runId);
    if (!r || (requireStatus && r.status !== requireStatus)) return false;
    if (r.busyUntil && r.busyUntil > now) return false;
    r.busyUntil = until;
    return true;
  }
  async releaseLock(runId: string) {
    const r = this.runs.find((x) => x.id === runId);
    if (r) r.busyUntil = null;
  }
  async saveDiscovery(runId: string, data: Parameters<ResearchStore["saveDiscovery"]>[1]) {
    for (const s of data.sources) {
      this.sources.push({
        ...s,
        runId,
        included: s.record.availability !== "UNAVAILABLE" && s.record.contentLevel !== "METADATA_ONLY",
      });
    }
    const r = this.runs.find((x) => x.id === runId)!;
    r.status = "AWAITING_REVIEW";
    r.diagnostics = data.diagnostics;
    r.discarded = data.discarded;
    r.partial = data.partial;
  }
  async failRun(runId: string, errorCode: string) {
    const r = this.runs.find((x) => x.id === runId)!;
    r.status = "FAILED";
    r.errorCode = errorCode;
  }
  async listRunSources(userId: string, runId: string) {
    const r = await this.findRun(userId, runId);
    return r ? this.sources.filter((s) => s.runId === runId).sort((a, b) => a.position - b.position) : [];
  }
  async setIncluded(userId: string, runId: string, included: Record<string, boolean>) {
    const r = await this.findRun(userId, runId);
    if (!r || r.status !== "AWAITING_REVIEW") return false;
    for (const s of this.sources) if (s.runId === runId && s.sourceKey in included) s.included = included[s.sourceKey];
    return true;
  }
  async saveSynthesis(runId: string, data: Parameters<ResearchStore["saveSynthesis"]>[1]) {
    const r = this.runs.find((x) => x.id === runId)!;
    r.status = "COMPLETED";
    r.synthesis = data.synthesis;
    r.provider = data.provider;
    r.model = data.model;
    r.totalTokens = data.totalTokens;
    r.completedAt = new Date();
    for (const rec of data.recommendations) {
      this.recs.push({ ...rec, id: this.next("rec"), runId, status: "PROPOSED", note: null, statusChangedAt: null, updatedAt: new Date() });
    }
  }
  async listRecommendations(userId: string, runId: string) {
    const r = await this.findRun(userId, runId);
    return r ? this.recs.filter((x) => x.runId === runId) : [];
  }
  async findRecommendation(userId: string, id: string) {
    const rec = this.recs.find((x) => x.id === id);
    if (!rec) return null;
    return (await this.findRun(userId, rec.runId)) ? rec : null;
  }
  async updateRecommendation(userId: string, id: string, patch: { status?: RecommendationRow["status"]; note?: string | null }, now: Date) {
    const rec = await this.findRecommendation(userId, id);
    if (!rec) return null;
    if (patch.status) {
      rec.status = patch.status;
      rec.statusChangedAt = now;
    }
    if (patch.note !== undefined) rec.note = patch.note;
    return rec;
  }
  async findCachedSource(userId: string, canonicalUrl: string, now: Date) {
    const e = this.cache.get(`${userId}|${canonicalUrl}`);
    return e && e.expiresAt > now ? e.record : null;
  }
  async cacheSources(userId: string, entries: Array<{ record: SourceRecord; expiresAt: Date }>) {
    for (const e of entries) this.cache.set(`${userId}|${e.record.canonicalUrl}`, e);
  }
  async getUsage(userId: string, day: string) {
    const u = this.usage.get(`${userId}|${day}`) ?? {};
    return {
      runCount: u.runCount ?? 0,
      synthesisCount: u.synthesisCount ?? 0,
      tokenCount: u.tokenCount ?? 0,
      providerRequestCount: u.providerRequestCount ?? 0,
    };
  }
  async reserve(userId: string, day: string, counter: UsageCounter, limit: number, tokenLimit?: number) {
    const key = `${userId}|${day}`;
    const u = this.usage.get(key) ?? {};
    if ((u[counter] ?? 0) >= limit) return false;
    if (tokenLimit !== undefined && (u.tokenCount ?? 0) >= tokenLimit) return false;
    u[counter] = (u[counter] ?? 0) + 1;
    this.usage.set(key, u);
    return true;
  }
  async recordUsage(userId: string, day: string, record: Parameters<ResearchStore["recordUsage"]>[2]) {
    this.audit.push(record);
    const u = this.usage.get(`${userId}|${day}`) ?? {};
    u.tokenCount = (u.tokenCount ?? 0) + (record.totalTokens ?? 0);
    this.usage.set(`${userId}|${day}`, u);
  }
}

export function makeResearchDeps(
  over: Partial<Omit<ResearchDeps, "provider">> & { provider?: AIProvider; store?: FakeResearchStore } = {},
  limits: Partial<ResearchLimits> = {},
): ResearchDeps & { store: FakeResearchStore } {
  const store = over.store ?? new FakeResearchStore();
  const provider = over.provider ?? new ScriptedProvider(() => jsonReply({ answerable: false, recommendations: [] }));
  return {
    store,
    reader: over.reader ?? new EmptyReader(),
    providers: over.providers ?? [new FakeProvider("official-docs", [makeRecord()])],
    provider: () => provider,
    limits: { ...DEFAULT_RESEARCH_LIMITS, ...limits },
    now: over.now ?? (() => new Date("2026-11-09T12:00:00.000Z")),
  };
}
