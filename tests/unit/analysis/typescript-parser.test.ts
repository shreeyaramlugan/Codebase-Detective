import { describe, expect, it } from "vitest";

import { parseTypeScript } from "../../../features/analysis/parsers";

describe("TypeScript AST parser", () => {
  it("parses a valid TypeScript file", () => {
    const source = `
      function greet(name: string): string {
        return "Hello " + name;
      }
    `;

    const result = parseTypeScript(
      source,
      "src/greet.ts",
    );

    expect(result.isValid).toBe(true);
    expect(result.declarations).toContainEqual(
      expect.objectContaining({
        name: "greet",
        kind: "function",
      }),
    );
  });

  it("detects imports and exports", () => {
    const source = `
      import { calculate } from "./utils";

      export function run() {
        return calculate();
      }

      export default run;
    `;

    const result = parseTypeScript(
      source,
      "src/app.ts",
    );

    expect(result.imports).toHaveLength(1);
    expect(result.imports[0].source).toBe("./utils");

    expect(result.exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "run" }),
        expect.objectContaining({ name: "default" }),
      ]),
    );
  });

  it("reports invalid TypeScript syntax", () => {
    const source = `
      function broken( {
        return 10;
      }
    `;

    const result = parseTypeScript(
      source,
      "src/broken.ts",
    );

    expect(result.isValid).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("handles an empty file", () => {
    const result = parseTypeScript(
      "",
      "src/empty.ts",
    );

    expect(result.isValid).toBe(true);
    expect(result.lineCount).toBe(0);
    expect(result.imports).toHaveLength(0);
    expect(result.declarations).toHaveLength(0);
  });

  it("does not mistake comments and strings for imports", () => {
    const source = `
      // import fake from "./fake";

      const example = 'import another from "./another"';

      /*
        require("./commented")
      */
    `;

    const result = parseTypeScript(
      source,
      "src/comments.ts",
    );

    expect(result.imports).toHaveLength(0);
  });

  it("records the source file path", () => {
    const result = parseTypeScript(
      "const value = 10;",
      "src/example.ts",
    );

    expect(result.filePath).toBe("src/example.ts");
  });
});
