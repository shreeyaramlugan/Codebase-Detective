import { describe, expect, it } from "vitest";
import type { GitHubTreeEntry } from "@/lib/github/github.type";
import { classifyGitHubTreeEntry } from "@/lib/ingestion/classification/file-classifier";
import { INGESTION_LIMITS } from "@/lib/ingestion/classification/ingestion-limits";

const VALID_SHA = "a".repeat(40);

function createEntry(
  overrides: Partial<GitHubTreeEntry> = {},
): GitHubTreeEntry {
  return {
    path: "src/index.ts",
    mode: "100644",
    type: "blob",
    sha: VALID_SHA,
    size: 100,
    ...overrides,
  };
}

describe("classifyGitHubTreeEntry", () => {
  describe("eligible files", () => {
    it("classifies TypeScript source files", () => {
      const result = classifyGitHubTreeEntry(createEntry());

      expect(result).toMatchObject({
        path: "src/index.ts",
        name: "index.ts",
        extension: ".ts",
        status: "ELIGIBLE",
        category: "SOURCE",
        reason: null,
        gitBlobSha: VALID_SHA,
        sizeBytes: 100,
      });
    });

    it("classifies TypeScript declaration files", () => {
      const result = classifyGitHubTreeEntry(
        createEntry({ path: "types/index.d.ts" }),
      );

      expect(result).toMatchObject({
        status: "ELIGIBLE",
        category: "SOURCE",
        extension: ".ts",
      });
    });

    it("classifies configuration files", () => {
      const result = classifyGitHubTreeEntry(
        createEntry({ path: "tsconfig.json" }),
      );

      expect(result).toMatchObject({
        status: "ELIGIBLE",
        category: "CONFIGURATION",
        extension: ".json",
      });
    });

    it("classifies documentation files", () => {
      const result = classifyGitHubTreeEntry(
        createEntry({ path: "README.md" }),
      );

      expect(result).toMatchObject({
        status: "ELIGIBLE",
        category: "DOCUMENTATION",
        extension: ".md",
      });
    });

    it("accepts files exactly at the individual file size limit", () => {
      const result = classifyGitHubTreeEntry(
        createEntry({ size: INGESTION_LIMITS.MAX_FILE_SIZE_BYTES }),
      );

      expect(result.status).toBe("ELIGIBLE");
    });

    it("accepts zero-byte files", () => {
      const result = classifyGitHubTreeEntry(createEntry({ size: 0 }));

      expect(result).toMatchObject({
        status: "ELIGIBLE",
        sizeBytes: 0,
      });
    });

    it("preserves executable Git blob entries", () => {
      const result = classifyGitHubTreeEntry(createEntry({ mode: "100755" }));

      expect(result.status).toBe("ELIGIBLE");
    });
  });

  describe("path validation", () => {
    it.each([
      "../outside.ts",
      "/absolute.ts",
      "src\\outside.ts",
      "src//index.ts",
      "src/./index.ts",
      "src/../index.ts",
    ])("rejects unsafe path %s", (path) => {
      const result = classifyGitHubTreeEntry(createEntry({ path }));

      expect(result).toMatchObject({
        status: "SKIPPED",
        reason: "UNSAFE_PATH",
        category: null,
      });
    });

    it("rejects paths exceeding the maximum length", () => {
      const path = `${Array.from({ length: 5 }, () => "a".repeat(205)).join("/")}/x.ts`;

      const result = classifyGitHubTreeEntry(createEntry({ path }));

      expect(result.reason).toBe("PATH_TOO_LONG");
    });
    it("rejects path segments exceeding the maximum length", () => {
      const path = `src/${"a".repeat(256)}.ts`;

      const result = classifyGitHubTreeEntry(createEntry({ path }));

      expect(result.reason).toBe("PATH_SEGMENT_TOO_LONG");
    });
  });

  describe("Git entry exclusions", () => {
    it("rejects symbolic links", () => {
      const result = classifyGitHubTreeEntry(createEntry({ mode: "120000" }));

      expect(result.reason).toBe("SYMLINK_NOT_SUPPORTED");
    });

    it("rejects submodules", () => {
      const result = classifyGitHubTreeEntry(
        createEntry({ mode: "160000", type: "commit" }),
      );

      expect(result.reason).toBe("SUBMODULE_NOT_SUPPORTED");
    });

    it("rejects tree entries", () => {
      const result = classifyGitHubTreeEntry(createEntry({ type: "tree" }));

      expect(result.reason).toBe("UNSUPPORTED_GIT_ENTRY");
    });
  });

  describe("sensitive and excluded files", () => {
    it.each([
      ".env",
      ".env.local",
      "config/credentials.json",
      "private/server.pem",
    ])("rejects sensitive file %s", (path) => {
      const result = classifyGitHubTreeEntry(createEntry({ path }));

      expect(result).toMatchObject({
        status: "SKIPPED",
        reason: "SENSITIVE_FILE",
      });
    });

    it.each([
      "node_modules/package/index.js",
      "vendor/library/index.ts",
      "dist/bundle.js",
      ".next/server/index.js",
      ".cache/output.json",
      ".git/config",
    ])("rejects excluded path %s", (path) => {
      const result = classifyGitHubTreeEntry(createEntry({ path }));

      expect(result.status).toBe("SKIPPED");
      expect(result.reason).not.toBeNull();
    });

    it("allows safe environment example files", () => {
      const result = classifyGitHubTreeEntry(
        createEntry({ path: ".env.example" }),
      );

      expect(result).toMatchObject({
        status: "ELIGIBLE",
        category: "CONFIGURATION",
      });
    });
  });

  describe("unsupported file types", () => {
    it.each(["image.png", "document.pdf", "archive.zip"])(
      "skips unsupported file %s",
      (path) => {
        const result = classifyGitHubTreeEntry(createEntry({ path }));

        expect(result).toMatchObject({
          status: "SKIPPED",
          reason: "UNSUPPORTED_FILE_TYPE",
          category: null,
        });
      },
    );
  });

  describe("file size validation", () => {
    it("rejects files exceeding the individual file size limit", () => {
      const result = classifyGitHubTreeEntry(
        createEntry({
          size: INGESTION_LIMITS.MAX_FILE_SIZE_BYTES + 1,
        }),
      );

      expect(result.reason).toBe("FILE_TOO_LARGE");
    });

    it.each([
      ["missing", undefined],
      ["negative", -1],
      ["fractional", 1.5],
      ["NaN", Number.NaN],
      ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ])("rejects %s file sizes", (_label, size) => {
      const result = classifyGitHubTreeEntry(
        createEntry({ size } as Partial<GitHubTreeEntry>),
      );

      expect(result).toMatchObject({
        status: "SKIPPED",
        reason: "INVALID_FILE_SIZE",
        category: null,
      });
    });
  });
});
