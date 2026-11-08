// tests/unit/findings/view.test.ts
import { describe, expect, it } from "vitest";

import {
  parseExplorerState,
  explorerSearchParams,
  DEFAULT_STATE,
} from "@/features/explorer/navigation/explorer-url";
import {
  EMPTY_FILTERS,
  describeRun,
  findingsQuery,
  formatLocation,
  hasActiveFilters,
  severityTone,
  sourceNavigation,
  toggle,
} from "@/features/findings/view/findings-view";

describe("findingsQuery", () => {
  it("serialises only allow-listed values", () => {
    const q = new URLSearchParams(
      findingsQuery({
        severities: ["HIGH", "DROP TABLE"],
        categories: ["SECURITY", "x"],
        certainties: ["INDICATOR", "nope"],
        review: "OPEN",
        q: "  eval  ",
      }),
    );
    expect(q.get("severity")).toBe("HIGH");
    expect(q.get("category")).toBe("SECURITY");
    expect(q.get("certainty")).toBe("INDICATOR");
    expect(q.get("review")).toBe("OPEN");
    expect(q.get("q")).toBe("eval");
    expect(q.get("limit")).toBe("50");
  });

  it("drops an invalid review filter and bounds the search text", () => {
    const q = new URLSearchParams(
      findingsQuery(
        { ...EMPTY_FILTERS, review: "HACK", q: "x".repeat(500) },
        "cur1",
      ),
    );
    expect(q.get("review")).toBeNull();
    expect(q.get("q")?.length).toBe(100);
    expect(q.get("cursor")).toBe("cur1");
  });

  it("detects active filters and toggles values", () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, q: " " })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, severities: ["LOW"] })).toBe(
      true,
    );
    expect(toggle(["A"], "B")).toEqual(["A", "B"]);
    expect(toggle(["A", "B"], "A")).toEqual(["B"]);
  });
});

describe("source navigation", () => {
  it("opens the file at the evidence line", () => {
    expect(sourceNavigation({ filePath: "src/a.ts", startLine: 12 })).toEqual({
      view: "files",
      file: "src/a.ts",
      line: 12,
      finding: null,
    });
    expect(
      sourceNavigation({ filePath: "src/a.ts", startLine: null })?.line,
    ).toBeNull();
  });

  it("refuses unsafe paths", () => {
    for (const filePath of ["../etc/passwd", "/abs", "a/../b", "a\\b", ""]) {
      expect(sourceNavigation({ filePath, startLine: 1 })).toBeNull();
    }
  });

  it("formats locations", () => {
    expect(
      formatLocation({ filePath: "a.ts", startLine: null, endLine: null }),
    ).toBe("a.ts");
    expect(formatLocation({ filePath: "a.ts", startLine: 3, endLine: 3 })).toBe(
      "a.ts:3",
    );
    expect(formatLocation({ filePath: "a.ts", startLine: 3, endLine: 9 })).toBe(
      "a.ts:3-9",
    );
  });
});

describe("run headline", () => {
  const base = { limitations: [] as string[], errorMessage: null };
  it("never presents a partial run as a clean result", () => {
    const r = describeRun(
      { ...base, status: "PARTIAL", limitations: ["Analysis is partial."] },
      0,
    );
    expect(r.tone).toBe("warn");
    expect(r.title).toMatch(/incomplete/);
    expect(r.message).toBe("Analysis is partial.");
  });

  it("qualifies an empty complete run and reports failures", () => {
    const ok = describeRun({ ...base, status: "COMPLETED" }, 0);
    expect(ok.message).toMatch(/does not prove/);
    expect(
      describeRun({ ...base, status: "FAILED", errorMessage: "x" }, 0).tone,
    ).toBe("bad");
    expect(describeRun({ ...base, status: "PROCESSING" }, 0).tone).toBe("info");
  });

  it("maps severity to tones", () => {
    expect(severityTone("HIGH")).toBe("bad");
    expect(severityTone("INFO")).toBe("neutral");
  });
});

describe("explorer URL state", () => {
  it("round-trips run and finding and rejects unsafe ids", () => {
    const state = {
      ...DEFAULT_STATE,
      view: "findings" as const,
      run: "run_1",
      finding: "fr_abc",
    };
    const parsed = parseExplorerState(explorerSearchParams(state));
    expect(parsed.view).toBe("findings");
    expect(parsed.run).toBe("run_1");
    expect(parsed.finding).toBe("fr_abc");

    const bad = parseExplorerState(
      new URLSearchParams("view=findings&run=a/b&finding=../x"),
    );
    expect(bad.run).toBeNull();
    expect(bad.finding).toBeNull();
  });

  it("omits findings params when unset, keeping existing URLs unchanged", () => {
    expect(explorerSearchParams(DEFAULT_STATE).toString()).toBe("");
  });
});
