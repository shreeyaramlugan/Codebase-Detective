import { describe, it, expect } from "vitest";
import { parseTypeScript } from "../../../features/analysis/parsers";

describe("Source parser", () => {
  it("detects imports in valid TypeScript", () => {
    const source = `
      import { calculateTotal } from "./utils";

      export function total() {
        return calculateTotal([1, 2, 3]);
      }
    `;

    const result = parseTypeScript(source, "example.ts");

    expect(result.imports).toHaveLength(1);
    expect(result.imports[0].source).toBe("./utils");
  });

  it("reports invalid syntax", () => {
    const source = `
      export function broken( {
        return 10;
      }
    `;

    const result = parseTypeScript(source, "broken.txt");

    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("handles an empty file", () => {
    const result = parseTypeScript("", "empty.ts");

    expect(result.imports).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });
});
