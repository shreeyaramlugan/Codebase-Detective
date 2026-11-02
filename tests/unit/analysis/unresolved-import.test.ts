import { describe, expect, it } from "vitest";

import { checkUnresolvedImports } from "../../../features/analysis/rules";

describe("IMPORT001: unresolved relative imports", () => {
  it("detects an unresolved import", () => {
    const findings = checkUnresolvedImports({
      filePath: "src/app/page.tsx",
      imports: [
        {
          source: "./missing",
          kind: "es",
          line: 5,
          column: 1,
        },
      ],
      knownFiles: new Set(["src/app/page.tsx"]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("IMPORT001");
    expect(findings[0].location.startLine).toBe(5);
  });

  it("does not flag an existing TypeScript module", () => {
    const findings = checkUnresolvedImports({
      filePath: "src/app/page.tsx",
      imports: [
        {
          source: "./Button",
          kind: "es",
          line: 3,
          column: 1,
        },
      ],
      knownFiles: new Set(["src/app/page.tsx", "src/app/Button.tsx"]),
    });

    expect(findings).toHaveLength(0);
  });

  it("does not flag external packages", () => {
    const findings = checkUnresolvedImports({
      filePath: "src/app/page.tsx",
      imports: [
        {
          source: "react",
          kind: "es",
          line: 1,
          column: 1,
        },
      ],
      knownFiles: new Set(),
    });

    expect(findings).toHaveLength(0);
  });

  it("does not flag aliases", () => {
    const findings = checkUnresolvedImports({
      filePath: "src/app/page.tsx",
      imports: [
        {
          source: "@/components/Button",
          kind: "es",
          line: 1,
          column: 1,
        },
      ],
      knownFiles: new Set(),
    });

    expect(findings).toHaveLength(0);
  });

  it("resolves index files", () => {
    const findings = checkUnresolvedImports({
      filePath: "src/app/page.tsx",
      imports: [
        {
          source: "./components",
          kind: "es",
          line: 1,
          column: 1,
        },
      ],
      knownFiles: new Set(["src/app/components/index.tsx"]),
    });

    expect(findings).toHaveLength(0);
  });

  it("produces identical findings for identical inputs", () => {
    const input = {
      filePath: "src/app/page.tsx",
      imports: [
        {
          source: "./missing",
          kind: "es" as const,
          line: 5,
          column: 1,
        },
      ],
      knownFiles: new Set(["src/app/page.tsx"]),
    };

    expect(checkUnresolvedImports(input)).toEqual(
      checkUnresolvedImports(input),
    );
  });
});
