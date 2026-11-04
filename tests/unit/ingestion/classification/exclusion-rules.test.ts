import { describe, expect, it } from "vitest";

import type { GitHubTreeEntry } from "@/lib/github/github.type";

import {
  getGitEntryExclusionReason,
  getPathExclusionReason,
} from "@/lib/ingestion/classification/exclusion-rules";

function createEntry(
  overrides: Partial<GitHubTreeEntry> = {},
): GitHubTreeEntry {
  return {
    path: "src/index.ts",
    mode: "100644",
    type: "blob",
    sha: "a".repeat(40),
    size: 100,
    ...overrides,
  };
}

describe("getGitEntryExclusionReason", () => {
  it("accepts a regular file entry", () => {
    expect(getGitEntryExclusionReason(createEntry())).toBeNull();
  });

  it("accepts an executable regular file entry", () => {
    expect(
      getGitEntryExclusionReason(createEntry({ mode: "100755" })),
    ).toBeNull();
  });

  it("excludes symbolic links", () => {
    expect(getGitEntryExclusionReason(createEntry({ mode: "120000" }))).toBe(
      "SYMLINK_NOT_SUPPORTED",
    );
  });

  it("excludes submodule entries by mode", () => {
    expect(getGitEntryExclusionReason(createEntry({ mode: "160000" }))).toBe(
      "SUBMODULE_NOT_SUPPORTED",
    );
  });

  it("excludes submodule entries by Git entry type", () => {
    expect(getGitEntryExclusionReason(createEntry({ type: "commit" }))).toBe(
      "SUBMODULE_NOT_SUPPORTED",
    );
  });

  it("excludes directory entries", () => {
    expect(
      getGitEntryExclusionReason(createEntry({ type: "tree", mode: "040000" })),
    ).toBe("UNSUPPORTED_GIT_ENTRY");
  });
});

describe("getPathExclusionReason", () => {
  describe("dependency directories", () => {
    it.each([
      "node_modules/react/index.js",
      "src/node_modules/package/index.js",
      "vendor/library/file.ts",
      "bower_components/jquery/jquery.js",
    ])("excludes dependency path: %s", (path) => {
      expect(getPathExclusionReason(path)).toBe("DEPENDENCY_DIRECTORY");
    });
  });

  describe("generated directories", () => {
    it.each([
      "dist/index.js",
      "build/output.js",
      "out/index.js",
      "coverage/report.js",
      ".next/server/app.js",
      ".nuxt/generated.ts",
      ".output/server/index.mjs",
      ".svelte-kit/generated.js",
      ".angular/cache/file.js",
      "target/classes/Main.java",
      "bin/output.js",
      "obj/generated.cs",
      "playwright-report/index.html",
      "test-results/output.json",
      "storybook-static/index.html",
    ])("excludes generated path: %s", (path) => {
      expect(getPathExclusionReason(path)).toBe("GENERATED_DIRECTORY");
    });
  });

  describe("cache directories", () => {
    it.each([
      ".cache/data.json",
      ".turbo/cache.json",
      ".vercel/output.json",
      ".parcel-cache/data.json",
      ".eslintcache/data.json",
      ".pytest_cache/state.json",
      "__pycache__/module.pyc",
    ])("excludes cache path: %s", (path) => {
      expect(getPathExclusionReason(path)).toBe("CACHE_DIRECTORY");
    });
  });

  describe("Git metadata", () => {
    it("excludes the .git directory", () => {
      expect(getPathExclusionReason(".git/config")).toBe("EXCLUDED_DIRECTORY");
    });

    it("excludes a file named .git", () => {
      expect(getPathExclusionReason("src/.git")).toBe("EXCLUDED_DIRECTORY");
    });
  });

  describe("sensitive paths", () => {
    it.each([
      ".env",
      ".env.local",
      "config/credentials.json",
      "certificates/private.pem",
      ".ssh/id_rsa",
      ".aws/credentials",
      "secrets/database.json",
    ])("excludes sensitive path: %s", (path) => {
      expect(getPathExclusionReason(path)).toBe("SENSITIVE_FILE");
    });
  });

  describe("allowed paths", () => {
    it.each([
      "src/index.ts",
      "package.json",
      "README.md",
      ".github/workflows/ci.yml",
      "src/components/Button.tsx",
      "docs/architecture.md",
      "config/.env.example",
    ])("does not exclude allowed path: %s", (path) => {
      expect(getPathExclusionReason(path)).toBeNull();
    });
  });
});
