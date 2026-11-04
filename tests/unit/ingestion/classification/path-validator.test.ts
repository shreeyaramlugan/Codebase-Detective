import { describe, expect, it } from "vitest";

import { validateRepositoryPath } from "@/lib/ingestion/classification/path-validator";

describe("validateRepositoryPath", () => {
  describe("valid paths", () => {
    it.each([
      "src/index.ts",
      "src/components/Button.tsx",
      "package.json",
      ".github/workflows/ci.yml",
      "README.md",
    ])("accepts a valid repository path: %s", (path) => {
      expect(validateRepositoryPath(path)).toEqual({
        valid: true,
        normalizedPath: path,
        error: null,
      });
    });

    it("accepts a path with a segment exactly 255 characters long", () => {
      const path = `${"a".repeat(255)}.ts`;

      // The extension makes this segment longer than 255 characters.
      expect(validateRepositoryPath("a".repeat(255))).toMatchObject({
        valid: true,
        error: null,
      });

      expect(validateRepositoryPath(path)).toMatchObject({
        valid: false,
        error: "PATH_SEGMENT_TOO_LONG",
      });
    });

    it("accepts a path exactly 1024 characters long", () => {
      const segment = "a".repeat(204);
      const path = [segment, segment, segment, segment, segment].join("/");

      expect(path).toHaveLength(1024);
      expect(validateRepositoryPath(path)).toMatchObject({
        valid: true,
        normalizedPath: path,
        error: null,
      });
    });
  });

  describe("unsafe paths", () => {
    it.each([
      "",
      "/etc/passwd",
      "/src/index.ts",
      "../secret.txt",
      "src/../secret.txt",
      "src/./index.ts",
      "src//index.ts",
      "src\\index.ts",
      "\\\\server\\share\\file.ts",
      "C:\\Users\\secret.txt",
      "C:/Users/secret.txt",
      "src/\u0000index.ts",
      "src/\u001Findex.ts",
      "src/\u007Findex.ts",
    ])("rejects unsafe path: %s", (path) => {
      expect(validateRepositoryPath(path)).toMatchObject({
        valid: false,
        normalizedPath: null,
        error: "UNSAFE_PATH",
      });
    });
  });

  describe("path length limits", () => {
    it("rejects paths longer than 1024 characters", () => {
      const path = "a".repeat(1025);

      expect(validateRepositoryPath(path)).toMatchObject({
        valid: false,
        normalizedPath: null,
        error: "PATH_TOO_LONG",
      });
    });

    it("rejects a path segment longer than 255 characters", () => {
      const path = `${"a".repeat(256)}/index.ts`;

      expect(validateRepositoryPath(path)).toMatchObject({
        valid: false,
        normalizedPath: null,
        error: "PATH_SEGMENT_TOO_LONG",
      });
    });
  });

  describe("input validation", () => {
    it("rejects a non-string input at runtime", () => {
      expect(validateRepositoryPath(null as unknown as string)).toMatchObject({
        valid: false,
        normalizedPath: null,
        error: "UNSAFE_PATH",
      });
    });
  });
});
