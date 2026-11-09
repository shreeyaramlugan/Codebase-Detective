// tests/unit/ai/assistant-retrieval.test.ts
import { describe, expect, it } from "vitest";

import { assembleContext } from "../../../features/ai/assistant/context";
import { retrieveEvidence } from "../../../lib/ai/ai.retrieval";
import type { SnapshotScope } from "../../../features/ai/assistant/contracts";
import type { EvidenceReader } from "../../../lib/ai/ai.reader";

import { EmptyReader, makeScope } from "../../fixtures/ai/fakes";

class Reader extends EmptyReader implements EvidenceReader {
  reads: string[] = [];
  async findFiles(): ReturnType<EvidenceReader["findFiles"]> {
    return [
      { path: "src/auth/login.ts", lineCount: 20, status: "ANALYSED" },
      { path: ".env", lineCount: 2, status: "ANALYSED" },
    ];
  }
  async findSymbols(): ReturnType<EvidenceReader["findSymbols"]> {
    return [
      {
        id: "s1", stableKey: "k1", name: "login", kind: "FUNCTION", qualifiedName: "login",
        path: "src/auth/login.ts", parentName: null, isExported: true, isDefaultExport: false,
        startLine: 3, endLine: 9,
      },
    ];
  }
  async fileDependencies(_s: SnapshotScope, path: string): ReturnType<EvidenceReader["fileDependencies"]> {
    if (path !== "src/auth/login.ts") return { imports: [], importers: [] };
    const base = { kind: "IMPORT", isTypeOnly: false, names: [], startLine: 1, endLine: 1, externalPackage: null };
    return {
      imports: [
        { ...base, path: "src/auth/login.ts", specifier: "./session", status: "RESOLVED" as const, targetPath: "src/auth/session.ts", reason: "" },
        { ...base, path: "src/auth/login.ts", specifier: "./ghost", status: "UNRESOLVED" as const, targetPath: null, reason: "no such file" },
        { ...base, path: "src/auth/login.ts", specifier: "./either", status: "AMBIGUOUS" as const, targetPath: null, reason: "two candidates" },
      ],
      importers: [],
    };
  }
  async symbolCalls(): ReturnType<EvidenceReader["symbolCalls"]> {
    return [
      { path: "src/auth/login.ts", callerName: "login", calleeText: "check", resolution: "POSSIBLE" as const, targetName: null, targetPath: null, reason: "dynamic", startLine: 5, endLine: 5 },
      { path: "src/auth/login.ts", callerName: "login", calleeText: "hash", resolution: "CONFIRMED" as const, targetName: "hash", targetPath: "src/crypto.ts", reason: "", startLine: 6, endLine: 6 },
    ];
  }
  async readSource(_s: SnapshotScope, path: string): ReturnType<EvidenceReader["readSource"]> {
    this.reads.push(path);
    return path === "src/auth/login.ts" ? Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n") : null;
  }
}

describe("retrieveEvidence", () => {
  const scope = makeScope();

  it("keeps confirmed, possible, ambiguous and unresolved distinct", async () => {
    const out = await retrieveEvidence(new Reader(), { scope, terms: ["login"], category: "flow" });
    const by = (kind: string) => out.filter((c) => c.kind === kind);
    expect(by("dependency").map((d) => d.certainty).sort()).toEqual(["AMBIGUOUS", "CONFIRMED", "UNRESOLVED"]);
    expect(by("call").map((c) => c.certainty).sort()).toEqual(["CONFIRMED", "POSSIBLE"]);
    expect(by("call").find((c) => c.certainty === "POSSIBLE")!.text.includes("[POSSIBLE]")).toBe(true);
  });

  it("never reads sensitive files and never invents unavailable source", async () => {
    const reader = new Reader();
    const out = await retrieveEvidence(reader, { scope, terms: ["login", "env"], category: "file" });
    expect(reader.reads.includes(".env")).toBe(false);
    expect(out.some((c) => c.kind === "source" && c.path === ".env")).toBe(false);
  });

  it("attaches exact source line ranges for symbols", async () => {
    const out = await retrieveEvidence(new Reader(), { scope, terms: ["login"], category: "symbol" });
    const src = out.find((c) => c.kind === "source" && c.symbolKey === "k1")!;
    expect([src.startLine, src.endLine]).toEqual([3, 9]);
    expect(src.text.split("\n")[0]).toBe("line3");
  });

  it("with no matches only repository metadata is available (insufficient)", async () => {
    const out = await retrieveEvidence(new EmptyReader(), { scope, terms: ["zzz"], category: "general" });
    expect(assembleContext(out, 10_000).substantive).toBe(false);
  });
});
