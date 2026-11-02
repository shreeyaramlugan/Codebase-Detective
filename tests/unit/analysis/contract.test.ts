import { describe, expect, it } from "vitest";
import type {
  AnalysisFinding,
  FindingSeverity,
} from "../../../features/analysis/contracts";

describe("Analysis contracts", () => {
  it("supports a valid analysis finding", () => {
    const severity: FindingSeverity = "medium";

    const finding: AnalysisFinding = {
      ruleId: "IMPORT001",
      title: "Unresolved relative import",
      description: "The imported module could not be resolved.",
      severity,
      location: {
        path: "src/app/page.tsx",
        startLine: 10,
        endLine: 10,
      },
      evidence: ["import Button from './Button';"],
      recommendation: "Verify the import path.",
    };

    expect(finding.ruleId).toBe("IMPORT001");
    expect(finding.location.startLine).toBe(10);
  });
});
