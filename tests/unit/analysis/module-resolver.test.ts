import { describe, expect, it } from "vitest";
import { resolveRelativeImport } from "@/features/analysis/dependency-graph/module-resolver";

describe("resolveRelativeImport", () => {
  describe("basic resolution", () => {
    it("resolves an exact extensionless file path", () => {
      const result = resolveRelativeImport(
        "src/index.ts",
        "./utils",
        new Set(["src/utils"]),
      );

      expect(result).toBe("src/utils");
    });

    it("resolves an explicitly specified extension", () => {
      const result = resolveRelativeImport(
        "src/index.ts",
        "./utils.ts",
        new Set(["src/utils.ts"]),
      );

      expect(result).toBe("src/utils.ts");
    });

    it("returns null when the import does not exist", () => {
      const result = resolveRelativeImport(
        "src/index.ts",
        "./missing",
        new Set(["src/utils.ts"]),
      );

      expect(result).toBeNull();
    });

    it("returns null for an empty import specifier", () => {
      const result = resolveRelativeImport(
        "src/index.ts",
        "",
        new Set(["src/index.ts"]),
      );

      expect(result).toBeNull();
    });

    it("does not resolve package imports", () => {
      const result = resolveRelativeImport(
        "src/index.ts",
        "react",
        new Set(["node_modules/react/index.js"]),
      );

      expect(result).toBeNull();
    });

    it("does not resolve absolute import specifiers", () => {
      const result = resolveRelativeImport(
        "src/index.ts",
        "/src/utils",
        new Set(["src/utils.ts"]),
      );

      expect(result).toBeNull();
    });
  });

  describe("extension resolution", () => {
    it.each([".ts", ".tsx", ".js", ".jsx"])(
      "resolves files with the %s extension",
      (extension) => {
        const expected = `src/utils${extension}`;

        const result = resolveRelativeImport(
          "src/index.ts",
          "./utils",
          new Set([expected]),
        );

        expect(result).toBe(expected);
      },
    );

    it("prefers TypeScript files when multiple extensions exist", () => {
      const result = resolveRelativeImport(
        "src/index.ts",
        "./utils",
        new Set(["src/utils.js", "src/utils.tsx", "src/utils.ts"]),
      );

      expect(result).toBe("src/utils.ts");
    });

    it("prefers an exact path before trying extensions", () => {
      const result = resolveRelativeImport(
        "src/index.ts",
        "./utils",
        new Set(["src/utils", "src/utils.ts"]),
      );

      expect(result).toBe("src/utils");
    });
  });

  describe("directory index resolution", () => {
    it.each([".ts", ".tsx", ".js", ".jsx"])(
      "resolves directory index files with the %s extension",
      (extension) => {
        const expected = `src/utils/index${extension}`;

        const result = resolveRelativeImport(
          "src/index.ts",
          "./utils",
          new Set([expected]),
        );

        expect(result).toBe(expected);
      },
    );

    it("prefers a direct file over a directory index", () => {
      const result = resolveRelativeImport(
        "src/index.ts",
        "./utils",
        new Set(["src/utils/index.ts", "src/utils.ts"]),
      );

      expect(result).toBe("src/utils.ts");
    });
  });

  describe("path normalization", () => {
    it("resolves nested parent-directory imports", () => {
      const result = resolveRelativeImport(
        "src/features/auth/login.ts",
        "../../utils/validation",
        new Set(["src/utils/validation.ts"]),
      );

      expect(result).toBe("src/utils/validation.ts");
    });

    it("resolves paths containing Windows separators", () => {
      const result = resolveRelativeImport(
        "src\\features\\auth\\login.ts",
        "..\\..\\utils\\validation",
        new Set(["src/utils/validation.ts"]),
      );

      expect(result).toBe("src/utils/validation.ts");
    });

    it("normalizes current-directory segments", () => {
      const result = resolveRelativeImport(
        "src/./index.ts",
        "./utils",
        new Set(["src/utils.ts"]),
      );

      expect(result).toBe("src/utils.ts");
    });

    it("normalizes duplicate path separators", () => {
      const result = resolveRelativeImport(
        "src//features//index.ts",
        "../utils",
        new Set(["src/utils.ts"]),
      );

      expect(result).toBe("src/utils.ts");
    });

    it("resolves imports from a root-level file", () => {
      const result = resolveRelativeImport(
        "index.ts",
        "./utils",
        new Set(["utils.ts"]),
      );

      expect(result).toBe("utils.ts");
    });
  });
});
