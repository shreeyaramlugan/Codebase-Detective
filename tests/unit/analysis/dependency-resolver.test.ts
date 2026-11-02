import { describe, expect, it } from "vitest";

import { resolveRelativeDependency } from "../../../features/analysis/dependency-graph/dependency-resolver";

import type { DependencyReference } from "../../../features/analysis/contracts/dependency";

import type { ProjectContext } from "../../../features/analysis/contracts/project-context";

function createContext(
  overrides: Partial<ProjectContext> = {},
): ProjectContext {
  return {
    files: [],
    inventoryComplete: true,
    manifestAvailable: true,
    resolutionConfigAvailable: true,
    inaccessiblePaths: [],
    ...overrides,
  };
}

function createReference(
  overrides: Partial<DependencyReference> = {},
): DependencyReference {
  return {
    sourceFile: "src/index.ts",
    specifier: "./utils",
    kind: "relative",
    ...overrides,
  };
}

describe("resolveRelativeDependency", () => {
  describe("successful resolution", () => {
    it("resolves an existing TypeScript file", () => {
      const reference = createReference();

      const context = createContext({
        files: ["src/index.ts", "src/utils.ts"],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("resolved");
      expect(result.resolvedPath).toBe("src/utils.ts");
    });

    it("resolves an existing TSX file", () => {
      const reference = createReference({
        sourceFile: "src/components/App.tsx",
        specifier: "./Button",
      });

      const context = createContext({
        files: ["src/components/App.tsx", "src/components/Button.tsx"],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("resolved");
      expect(result.resolvedPath).toBe("src/components/Button.tsx");
    });

    it("resolves an existing JavaScript file", () => {
      const reference = createReference({
        specifier: "./helpers",
      });

      const context = createContext({
        files: ["src/helpers.js"],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("resolved");
      expect(result.resolvedPath).toBe("src/helpers.js");
    });

    it("resolves a nested relative import", () => {
      const reference = createReference({
        sourceFile: "src/features/auth/login.ts",
        specifier: "../../utils/validation",
      });

      const context = createContext({
        files: ["src/utils/validation.ts"],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("resolved");
      expect(result.resolvedPath).toBe("src/utils/validation.ts");
    });

    it("resolves a directory index file", () => {
      const reference = createReference({
        sourceFile: "src/index.ts",
        specifier: "./utils",
      });

      const context = createContext({
        files: ["src/utils/index.ts"],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("resolved");
      expect(result.resolvedPath).toBe("src/utils/index.ts");
    });

    it("resolves an explicitly specified extension", () => {
      const reference = createReference({
        specifier: "./utils.ts",
      });

      const context = createContext({
        files: ["src/utils.ts"],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("resolved");
      expect(result.resolvedPath).toBe("src/utils.ts");
    });

    it("resolves paths containing Windows separators", () => {
      const reference = createReference({
        sourceFile: "src\\features\\auth\\login.ts",
        specifier: "..\\..\\utils\\validation",
      });

      const context = createContext({
        files: ["src/utils/validation.ts"],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("resolved");
      expect(result.resolvedPath).toBe("src/utils/validation.ts");
    });

    it("resolves a dependency when the inventory is incomplete but the file is present", () => {
      const reference = createReference();

      const context = createContext({
        inventoryComplete: false,
        files: ["src/utils.ts"],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("resolved");
      expect(result.resolvedPath).toBe("src/utils.ts");
    });
    it("resolves an import from a root-level source file", () => {
      const reference = createReference({
        sourceFile: "index.ts",
        specifier: "./utils",
      });

      const context = createContext({
        files: ["utils.ts"],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("resolved");
      expect(result.resolvedPath).toBe("utils.ts");
    });
  });

  describe("missing dependencies", () => {
    it("reports missing when the inventory is complete", () => {
      const reference = createReference();

      const context = createContext({
        inventoryComplete: true,
        files: ["src/index.ts", "src/other.ts"],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("missing");
      expect(result.resolvedPath).toBeUndefined();
      expect(result.reason).toContain("complete project inventory");
      expect(result.evidence.length).toBeGreaterThan(0);
    });

    it("reports missing for an empty but complete inventory", () => {
      const reference = createReference();

      const context = createContext({
        files: [],
        inventoryComplete: true,
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("missing");
    });

    it("does not report missing when the inventory is incomplete", () => {
      const reference = createReference();

      const context = createContext({
        files: [],
        inventoryComplete: false,
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("unresolved");
      expect(result.reason).toContain("inventory is incomplete");
    });
  });

  describe("unresolved dependencies", () => {
    it("returns unresolved when a potential candidate is inaccessible", () => {
      const reference = createReference({
        sourceFile: "src/index.ts",
        specifier: "./utils/helper",
      });

      const context = createContext({
        inventoryComplete: true,
        files: [],
        inaccessiblePaths: ["src/utils"],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("unresolved");
      expect(result.reason).toContain("inaccessible");
    });

    it("returns unresolved when the source file path is empty", () => {
      const reference = createReference({
        sourceFile: "",
      });

      const result = resolveRelativeDependency(reference, createContext());

      expect(result.status).toBe("unresolved");
      expect(result.reason).toContain("source file");
    });

    it("returns unresolved when the dependency specifier is empty", () => {
      const reference = createReference({
        specifier: "",
      });

      const result = resolveRelativeDependency(reference, createContext());

      expect(result.status).toBe("unresolved");
      expect(result.reason).toContain("specifier is empty");
    });

    it("does not resolve package dependencies", () => {
      const reference = createReference({
        specifier: "react",
        kind: "package",
      });

      const result = resolveRelativeDependency(
        reference,
        createContext({
          files: ["node_modules/react/index.js"],
        }),
      );

      expect(result.status).toBe("unresolved");
      expect(result.reason).toContain("Unsupported dependency kind");
    });

    it("does not resolve aliases", () => {
      const reference = createReference({
        specifier: "@/utils",
        kind: "alias",
      });

      const result = resolveRelativeDependency(
        reference,
        createContext({
          files: ["src/utils.ts"],
        }),
      );

      expect(result.status).toBe("unresolved");
    });

    it("rejects a path that escapes the repository root", () => {
      const reference = createReference({
        sourceFile: "src/index.ts",
        specifier: "../../../outside",
      });

      const result = resolveRelativeDependency(
        reference,
        createContext({
          files: ["outside.ts"],
        }),
      );

      expect(result.status).toBe("unresolved");
      expect(result.reason).toContain("escapes the repository root");
      expect(result.resolvedPath).toBeUndefined();
    });

    it("rejects an absolute source file path", () => {
      const reference = createReference({
        sourceFile: "C:\\project\\src\\index.ts",
      });

      const result = resolveRelativeDependency(reference, createContext());

      expect(result.status).toBe("unresolved");
    });

    it("does not treat a similarly named inaccessible path as a match", () => {
      const reference = createReference({
        specifier: "./utils",
      });

      const context = createContext({
        files: [],
        inaccessiblePaths: ["src/utils-backup"],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("missing");
    });
    it("ignores inaccessible paths that escape the repository root", () => {
      const reference = createReference({
        specifier: "./utils",
      });

      const context = createContext({
        files: [],
        inventoryComplete: true,
        inaccessiblePaths: ["../outside"],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("missing");
    });

    it("ignores empty inaccessible paths", () => {
      const reference = createReference({
        specifier: "./utils",
      });

      const context = createContext({
        files: [],
        inventoryComplete: true,
        inaccessiblePaths: [""],
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("missing");
    });

    it("rejects a bare specifier even when the dependency kind is relative", () => {
      const reference = createReference({
        specifier: "utils",
        kind: "relative",
      });

      const result = resolveRelativeDependency(
        reference,
        createContext({
          files: ["src/utils.ts"],
        }),
      );

      expect(result.status).toBe("unresolved");
      expect(result.reason).toContain("is not a relative import");
    });
    it("ignores invalid paths in the project inventory", () => {
      const reference = createReference({
        sourceFile: "src/index.ts",
        specifier: "./utils",
      });

      const context = createContext({
        files: [
          "../outside/utils.ts",
          "/absolute/utils.ts",
          "C:\\outside\\utils.ts",
        ],
        inventoryComplete: true,
      });

      const result = resolveRelativeDependency(reference, context);

      expect(result.status).toBe("missing");
      expect(result.resolvedPath).toBeUndefined();
    });
  });

  describe("result consistency", () => {
    it("preserves the original dependency reference", () => {
      const reference = createReference({
        sourceFile: "src/index.ts",
        specifier: "./utils",
      });

      const result = resolveRelativeDependency(
        reference,
        createContext({
          files: ["src/utils.ts"],
        }),
      );

      expect(result.reference).toEqual(reference);
    });

    it("includes evidence for a resolved dependency", () => {
      const reference = createReference();

      const result = resolveRelativeDependency(
        reference,
        createContext({
          files: ["src/utils.ts"],
        }),
      );

      expect(result.evidence).toEqual(
        expect.arrayContaining(["Matched project file: src/utils.ts"]),
      );
    });

    it("does not return a resolved path for missing dependencies", () => {
      const result = resolveRelativeDependency(
        createReference(),
        createContext({
          files: [],
          inventoryComplete: true,
        }),
      );

      expect(result.status).toBe("missing");
      expect(result.resolvedPath).toBeUndefined();
    });
  });
});
