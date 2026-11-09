// tests/unit/ai/security.test.ts
//
// Static guards: provider credentials and provider code must stay server-side,
// and no route may accept a storage path or key from the client.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const root = process.cwd();

describe("assistant security boundaries", () => {
  it("client components never reference provider code or credentials", () => {
    for (const file of walk(join(root, "components"))) {
      const text = readFileSync(file, "utf8");
      expect(text.includes("GEMINI_API_KEY")).toBe(false);
      expect(text.includes("gemini-provider")).toBe(false);
      expect(text.includes("provider-factory")).toBe(false);
      expect(text.includes("process.env")).toBe(false);
    }
  });

  it("the key is only read in the provider factory", () => {
    const users = [...walk(join(root, "features")), ...walk(join(root, "lib")), ...walk(join(root, "app"))].filter(
      (f) => readFileSync(f, "utf8").includes("GEMINI_API_KEY"),
    );
    expect(users.map((f) => f.slice(root.length + 1)).sort()).toEqual([
      "features/ai/providers/provider-factory.ts",
    ]);
  });

  it("assistant routes take no storage path or key from the client", () => {
    const files = walk(join(root, "app/api/ai")).concat(
      walk(join(root, "app/api/repositories/[repositoryId]/ai")),
    );
    expect(files.length >= 4).toBe(true);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(/storageKey|storagePath|searchParams\.get\("path"\)/.test(text)).toBe(false);
    }
  });

  it("every assistant route goes through the authenticated handler", () => {
    const files = walk(join(root, "app/api/ai")).concat(
      walk(join(root, "app/api/repositories/[repositoryId]/ai")),
    );
    for (const file of files) {
      expect(readFileSync(file, "utf8").includes("handleAIRequest")).toBe(true);
    }
  });
});
