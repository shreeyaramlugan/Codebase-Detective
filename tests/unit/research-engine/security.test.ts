// tests/unit/research-engine/security.test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => f.slice(root.length + 1).split("\\").join("/");

describe("research security guards", () => {
  it("never reads the signed-in user's email or session in research code", () => {
    const files = [...walk(join(root, "features/research/engine")), ...walk(join(root, "lib/research"))];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text.includes("user.email") || text.includes("session.user.email")).toBe(false);
    }
  });

  it("sends the contact email only from RESEARCH_CONTACT_EMAIL", () => {
    const users = walk(join(root, "features/research/engine"))
      .filter((f) => readFileSync(f, "utf8").includes("RESEARCH_CONTACT_EMAIL"))
      .map(rel);
    expect(users).toEqual(["features/research/engine/config.ts"]);
  });

  it("keeps the AI provider key out of the research code", () => {
    const files = [...walk(join(root, "features/research")), ...walk(join(root, "lib/research"))];
    for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(/GEMINI_API_KEY|x-goog-api-key/);
  });

  it("does not import Prisma or the AI provider implementation into the pure engine", () => {
    for (const f of walk(join(root, "features/research/engine"))) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toMatch(/from "@prisma\/client"/);
      expect(text).not.toMatch(/gemini-provider|provider-factory/);
    }
  });

  it("keeps client components away from research providers and server modules", () => {
    const dirs = [join(root, "components/research")];
    for (const dir of dirs) {
      let files: string[] = [];
      try { files = walk(dir); } catch { continue; }
      for (const f of files) {
        const text = readFileSync(f, "utf8");
        expect(text).not.toMatch(/features\/research\/engine\/providers|research\.prisma-store|research\.runtime|@prisma\/client/);
      }
    }
  });

  it("routes use the shared handler, which maps errors without leaking internals", () => {
    const routes = walk(join(root, "app/api/research")).concat(walk(join(root, "app/api/repositories")).filter((f) => rel(f).includes("/research/")));
    expect(routes.length).toBeGreaterThan(4);
    for (const f of routes) expect(readFileSync(f, "utf8")).toContain("handleResearchRequest");
  });
});
