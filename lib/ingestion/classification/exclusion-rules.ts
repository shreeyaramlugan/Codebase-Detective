import type { GitHubTreeEntry } from "@/lib/github/github.type";
import type { FileSkipReason } from "./classification.types";
import { isSensitiveFile } from "./sensitive-file-rules";

const DEPENDENCY_DIRECTORIES = new Set([
  "node_modules",
  "vendor",
  "bower_components",
]);

const GENERATED_DIRECTORIES = new Set([
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".angular",
  "target",
  "bin",
  "obj",
  "playwright-report",
  "test-results",
  "storybook-static",
]);

const CACHE_DIRECTORIES = new Set([
  ".cache",
  ".turbo",
  ".vercel",
  ".parcel-cache",
  ".eslintcache",
  ".pytest_cache",
  "__pycache__",
]);

export function getGitEntryExclusionReason(
  entry: GitHubTreeEntry,
): FileSkipReason | null {
  // Git symbolic links use mode 120000.
  if (entry.mode === "120000") {
    return "SYMLINK_NOT_SUPPORTED";
  }

  // Git submodules use mode 160000 and type "commit".
  if (entry.mode === "160000" || entry.type === "commit") {
    return "SUBMODULE_NOT_SUPPORTED";
  }

  // Only blobs represent ordinary files.
  if (entry.type !== "blob") {
    return "UNSUPPORTED_GIT_ENTRY";
  }

  return null;
}

export function getPathExclusionReason(path: string): FileSkipReason | null {
  const segments = path.split("/");
  const filename = segments[segments.length - 1].toLowerCase();

  // Sensitive files must be excluded before other classification.
  if (isSensitiveFile(path)) {
    return "SENSITIVE_FILE";
  }

  for (const rawSegment of segments.slice(0, -1)) {
    const segment = rawSegment.toLowerCase();

    if (segment === ".git") {
      return "EXCLUDED_DIRECTORY";
    }

    if (DEPENDENCY_DIRECTORIES.has(segment)) {
      return "DEPENDENCY_DIRECTORY";
    }

    if (GENERATED_DIRECTORIES.has(segment)) {
      return "GENERATED_DIRECTORY";
    }

    if (CACHE_DIRECTORIES.has(segment)) {
      return "CACHE_DIRECTORY";
    }
  }

  // Also exclude Git metadata files at the repository root.
  if (filename === ".git") {
    return "EXCLUDED_DIRECTORY";
  }

  return null;
}
