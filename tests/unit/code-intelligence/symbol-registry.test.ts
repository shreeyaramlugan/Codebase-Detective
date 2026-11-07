// tests/unit/code-intelligence/symbol-registry.test.ts
import { describe, expect, it } from "vitest";

import type { SymbolRecord } from "@/features/code-intelligence/contracts";
import {
  createSymbolKey,
  createSymbolRowId,
  isSymbolKey,
} from "@/features/code-intelligence/registry/symbol-identity";
import {
  SymbolRegistry,
  SymbolRegistryError,
} from "@/features/code-intelligence/registry/symbol-registry";
import { analyze, fixtures } from "../../fixtures/code-intelligence/projects";

const base = {
  filePath: "a.ts",
  parentKey: null,
  kind: "FUNCTION" as const,
  name: "f",
  ordinal: 0,
};

function symbol(
  key: string,
  overrides: Partial<SymbolRecord> = {},
): SymbolRecord {
  return {
    key,
    filePath: "a.ts",
    name: "f",
    kind: "FUNCTION",
    qualifiedName: "f",
    parentKey: null,
    isExported: false,
    isDefaultExport: false,
    exportNames: [],
    location: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
    details: {},
    ...overrides,
  };
}

describe("symbol identity", () => {
  it("is deterministic and well formed", () => {
    expect(createSymbolKey(base)).toBe(createSymbolKey(base));
    expect(isSymbolKey(createSymbolKey(base))).toBe(true);
  });

  it("separates the same name across files, scopes, kinds and ordinals", () => {
    const keys = new Set([
      createSymbolKey(base),
      createSymbolKey({ ...base, filePath: "b.ts" }),
      createSymbolKey({ ...base, parentKey: "sym_" + "0".repeat(32) }),
      createSymbolKey({ ...base, kind: "CLASS" }),
      createSymbolKey({ ...base, ordinal: 1 }),
    ]);
    expect(keys.size).toBe(5);
  });

  it("does not depend on line numbers, so moving code keeps identity", () => {
    const a = analyze({ "a.ts": `export function f() {}` }).records.symbols[0]
      .key;
    const b = analyze({ "a.ts": `\n\n\nexport function f() {}` }).records
      .symbols[0].key;
    expect(a).toBe(b);
  });

  it("gives the same identities for identical analysis inputs", () => {
    const first = analyze(fixtures.duplicateNames).records.symbols.map(
      (s) => s.key,
    );
    const second = analyze(fixtures.duplicateNames).records.symbols.map(
      (s) => s.key,
    );
    expect(first).toEqual(second);
  });

  it("keeps duplicate names distinguishable in real analysis output", () => {
    const { records } = analyze(fixtures.duplicateNames);
    const helpers = records.symbols.filter((s) => s.name === "helper");
    expect(helpers).toHaveLength(3);
    expect(new Set(helpers.map((s) => s.key)).size).toBe(3);
  });

  it("scopes row ids to the analysis run so runs cannot be mixed", () => {
    const key = createSymbolKey(base);
    expect(createSymbolRowId("run-1", key)).not.toBe(
      createSymbolRowId("run-2", key),
    );
    expect(createSymbolRowId("run-1", key)).toBe(
      createSymbolRowId("run-1", key),
    );
  });
});

describe("SymbolRegistry", () => {
  const k1 = createSymbolKey(base);
  const k2 = createSymbolKey({ ...base, name: "g" });

  it("supports lookup by key, file, parent and scope", () => {
    const parent = symbol(k1);
    const child = symbol(k2, { name: "g", parentKey: k1 });
    const registry = new SymbolRegistry([parent, child]);

    expect(registry.getByKey(k1)).toBe(parent);
    expect(registry.getByFile("a.ts")).toHaveLength(2);
    expect(registry.getChildren(null, "a.ts")).toEqual([parent]);
    expect(registry.getChildren(k1)).toEqual([child]);
    expect(registry.lookupInScope("g", k1, "a.ts")).toEqual([child]);
    expect(registry.lookupInScope("g", null, "a.ts")).toEqual([]);
  });

  it("rejects invalid and duplicate keys", () => {
    expect(() => new SymbolRegistry([symbol("nope")])).toThrow(
      SymbolRegistryError,
    );
    expect(() => new SymbolRegistry([symbol(k1), symbol(k1)])).toThrow(
      SymbolRegistryError,
    );
  });

  it("validates parents and file references", () => {
    const orphan = symbol(k2, {
      parentKey: createSymbolKey({ ...base, name: "ghost" }),
    });
    expect(
      new SymbolRegistry([orphan]).validate(new Set(["a.ts"])),
    ).toHaveLength(1);

    const otherFile = symbol(k2, { parentKey: k1, filePath: "b.ts" });
    const problems = new SymbolRegistry([symbol(k1), otherFile]).validate(
      new Set(["a.ts", "b.ts"]),
    );
    expect(problems.some((p) => p.includes("different file"))).toBe(true);

    expect(new SymbolRegistry([symbol(k1)]).validate(new Set())).toHaveLength(
      1,
    );
  });
});
