import { describe, expect, it } from "vitest";

import { analyzeFile } from "../../../features/analysis/analyze-file";

describe("Codebase Detective analysis pipeline", () => {
  it("parses source and produces deterministic findings", () => {
    const source = `
      import Button from "./MissingButton";

      export function Home() {
        return Button;
      }
    `;

    const result = analyzeFile(
      source,
      "src/app/page.tsx",
      new Set(["src/app/page.tsx"]),
    );

    expect(result.parsed.isValid).toBe(true);

    expect(result.findings).toHaveLength(1);

    expect(result.findings[0]).toMatchObject({
      ruleId: "IMPORT001",
      severity: "medium",
      location: {
        path: "src/app/page.tsx",
        startLine: 2,
      },
    });
  });

  it("does not create findings for invalid source", () => {
    const result = analyzeFile(
      "function broken( {",
      "src/app/broken.txt",
      new Set(),
    );

    expect(result.parsed.isValid).toBe(false);
    expect(result.findings).toHaveLength(0);
  });
});
