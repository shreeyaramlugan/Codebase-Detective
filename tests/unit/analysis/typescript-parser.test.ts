import { describe, expect, it } from "vitest";

import { parseTypeScript } from "../../../features/analysis/parsers";

describe("TypeScript AST parser", () => {
  describe("Basic parsing", () => {
    it("parses a valid TypeScript file", () => {
      const source = `
        function greet(name: string): string {
          return "Hello " + name;
        }
      `;

      const result = parseTypeScript(source, "src/greet.ts");

      expect(result.isValid).toBe(true);
      expect(result.declarations).toContainEqual(
        expect.objectContaining({
          name: "greet",
          kind: "function",
        }),
      );
    });

    it("records the source file path", () => {
      const result = parseTypeScript("const value = 10;", "src/example.ts");

      expect(result.filePath).toBe("src/example.ts");
    });

    it("handles an empty file", () => {
      const result = parseTypeScript("", "src/empty.ts");

      expect(result.isValid).toBe(true);
      expect(result.lineCount).toBe(0);
      expect(result.imports).toHaveLength(0);
      expect(result.exports).toHaveLength(0);
      expect(result.declarations).toHaveLength(0);
      expect(result.diagnostics).toHaveLength(0);
    });

    it("handles whitespace-only files", () => {
      const result = parseTypeScript("   \n  \n   ", "src/whitespace.ts");

      expect(result.isValid).toBe(true);
      expect(result.imports).toHaveLength(0);
      expect(result.declarations).toHaveLength(0);
    });
  });

  describe("Declaration parsing", () => {
    it("detects exported and non-exported declarations", () => {
      const source = `
        export function greet() {}
        function helper() {}

        export class User {}
        class InternalUser {}

        export interface Profile {}
        interface InternalProfile {}

        export type Status = string;
        type InternalStatus = number;

        export enum Role {
          ADMIN,
          USER
        }

        enum InternalRole {
          GUEST
        }

        export const version = "1.0";
        const internalVersion = "0.1";
      `;

      const result = parseTypeScript(source, "src/declarations.ts");

      expect(result.isValid).toBe(true);

      expect(result.declarations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "greet", kind: "function" }),
          expect.objectContaining({ name: "helper", kind: "function" }),
          expect.objectContaining({ name: "User", kind: "class" }),
          expect.objectContaining({ name: "InternalUser", kind: "class" }),
          expect.objectContaining({ name: "Profile", kind: "interface" }),
          expect.objectContaining({
            name: "InternalProfile",
            kind: "interface",
          }),
          expect.objectContaining({ name: "Status", kind: "type" }),
          expect.objectContaining({ name: "InternalStatus", kind: "type" }),
          expect.objectContaining({ name: "Role", kind: "enum" }),
          expect.objectContaining({ name: "InternalRole", kind: "enum" }),
          expect.objectContaining({ name: "version", kind: "variable" }),
          expect.objectContaining({
            name: "internalVersion",
            kind: "variable",
          }),
        ]),
      );
    });

    it("extracts multiple identifier names from variable statements", () => {
      const source = `
        export const first = 1, second = 2;
      `;

      const result = parseTypeScript(source, "src/variables.ts");

      expect(result.declarations).toContainEqual(
        expect.objectContaining({
          name: "first, second",
          kind: "variable",
        }),
      );
    });

    it("ignores destructured variable declarations", () => {
      const source = `
        export const { name, age } = user;
        export const [first, second] = values;
      `;

      const result = parseTypeScript(source, "src/destructuring.ts");

      expect(result.declarations).toHaveLength(0);
    });

    it("records declaration line ranges", () => {
      const source = `export function greet() {
  return "Hello";
}`;

      const result = parseTypeScript(source, "src/lines.ts");

      expect(result.declarations).toContainEqual(
        expect.objectContaining({
          name: "greet",
          line: 1,
          endLine: 3,
        }),
      );
    });
  });

  describe("Import parsing", () => {
    it("detects standard ES imports", () => {
      const result = parseTypeScript(
        'import { calculate } from "./utils";',
        "src/app.ts",
      );

      expect(result.imports).toContainEqual(
        expect.objectContaining({
          source: "./utils",
          kind: "es",
        }),
      );
    });

    it("detects default imports", () => {
      const result = parseTypeScript(
        'import React from "react";',
        "src/app.ts",
      );

      expect(result.imports).toContainEqual(
        expect.objectContaining({
          source: "react",
          kind: "es",
        }),
      );
    });

    it("detects namespace imports", () => {
      const result = parseTypeScript(
        'import * as utilities from "./utils";',
        "src/app.ts",
      );

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe("./utils");
    });

    it("detects type-only imports", () => {
      const result = parseTypeScript(
        'import type { User } from "./types";',
        "src/app.ts",
      );

      expect(result.imports).toContainEqual(
        expect.objectContaining({
          source: "./types",
          kind: "type",
        }),
      );
    });

    it("detects inline type-only imports", () => {
      const result = parseTypeScript(
        'import { type User } from "./types";',
        "src/app.ts",
      );

      expect(result.imports).toContainEqual(
        expect.objectContaining({
          source: "./types",
          kind: "es",
        }),
      );
    });

    it("detects dynamic imports", () => {
      const result = parseTypeScript(
        'const module = import("./feature");',
        "src/app.ts",
      );

      expect(result.imports).toContainEqual(
        expect.objectContaining({
          source: "./feature",
          kind: "dynamic",
        }),
      );
    });

    it("detects CommonJS require calls", () => {
      const result = parseTypeScript(
        'const utilities = require("./utils");',
        "src/app.ts",
      );

      expect(result.imports).toContainEqual(
        expect.objectContaining({
          source: "./utils",
          kind: "require",
        }),
      );
    });

    it("ignores dynamic imports with non-literal arguments", () => {
      const result = parseTypeScript(
        "const module = import(modulePath);",
        "src/app.ts",
      );

      expect(result.imports).toHaveLength(0);
    });

    it("ignores require calls with non-literal arguments", () => {
      const result = parseTypeScript(
        "const module = require(modulePath);",
        "src/app.ts",
      );

      expect(result.imports).toHaveLength(0);
    });

    it("ignores require calls with multiple arguments", () => {
      const result = parseTypeScript(
        'const module = require("./utils", "extra");',
        "src/app.ts",
      );

      expect(result.imports).toHaveLength(0);
    });

    it("does not mistake comments and strings for imports", () => {
      const source = `
        // import fake from "./fake";

        const example = 'import another from "./another"';

        /*
          require("./commented")
        */
      `;

      const result = parseTypeScript(source, "src/comments.ts");

      expect(result.imports).toHaveLength(0);
    });
  });

  describe("Export parsing", () => {
    it("detects named exports", () => {
      const result = parseTypeScript(
        "export { greet, calculate };",
        "src/app.ts",
      );

      expect(result.exports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "greet", kind: "named" }),
          expect.objectContaining({ name: "calculate", kind: "named" }),
        ]),
      );
    });

    it("detects named re-exports", () => {
      const result = parseTypeScript(
        'export { greet } from "./greetings";',
        "src/app.ts",
      );

      expect(result.exports).toContainEqual(
        expect.objectContaining({
          name: "*",
          kind: "all",
        }),
      );
    });

    it("detects wildcard re-exports", () => {
      const result = parseTypeScript('export * from "./utils";', "src/app.ts");

      expect(result.exports).toContainEqual(
        expect.objectContaining({
          name: "*",
          kind: "all",
        }),
      );
    });

    it("detects default export assignments", () => {
      const result = parseTypeScript(
        "const app = {}; export default app;",
        "src/app.ts",
      );

      expect(result.exports).toContainEqual(
        expect.objectContaining({
          name: "default",
          kind: "default",
        }),
      );
    });

    it("detects exported default declarations", () => {
      const result = parseTypeScript(
        "export default function greet() {}",
        "src/app.ts",
      );

      expect(result.declarations).toContainEqual(
        expect.objectContaining({
          name: "greet",
          kind: "function",
        }),
      );

      expect(result.exports).toContainEqual(
        expect.objectContaining({
          name: "greet",
          kind: "default",
        }),
      );
    });
  });

  describe("Syntax diagnostics", () => {
    it("reports invalid TypeScript syntax", () => {
      const result = parseTypeScript(
        "function broken( { return 10; }",
        "src/broken.txt",
      );

      expect(result.isValid).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it("includes diagnostic messages and error codes", () => {
      const result = parseTypeScript("const = ;", "src/invalid.ts");

      expect(result.isValid).toBe(false);
      expect(result.diagnostics[0]).toEqual(
        expect.objectContaining({
          message: expect.any(String),
          line: expect.any(Number),
          column: expect.any(Number),
          code: expect.any(Number),
        }),
      );
    });

    it("reports diagnostic positions on later lines", () => {
      const result = parseTypeScript(
        "const valid = 1;\nconst = ;",
        "src/invalid.ts",
      );

      expect(result.isValid).toBe(false);
      expect(result.diagnostics.some((item) => item.line === 2)).toBe(true);
    });
  });

  describe("File formats and positions", () => {
    it("parses TSX files", () => {
      const result = parseTypeScript(
        "export const App = () => <div>Hello</div>;",
        "src/App.tsx",
      );

      expect(result.isValid).toBe(true);
      expect(result.declarations).toContainEqual(
        expect.objectContaining({
          name: "App",
          kind: "variable",
        }),
      );
    });

    it("parses JSX files", () => {
      const result = parseTypeScript(
        "const App = () => <div>Hello</div>;",
        "src/App.jsx",
      );

      expect(result.isValid).toBe(true);
    });

    it("records import line and column positions", () => {
      const result = parseTypeScript(
        '\n  import { value } from "./utils";',
        "src/app.ts",
      );

      expect(result.imports[0]).toEqual(
        expect.objectContaining({
          source: "./utils",
          line: 2,
          column: 3,
        }),
      );
    });

    it("counts Windows-style line endings", () => {
      const result = parseTypeScript(
        "const first = 1;\r\nconst second = 2;\r\n",
        "src/windows.ts",
      );

      expect(result.lineCount).toBe(3);
    });
  });
});
