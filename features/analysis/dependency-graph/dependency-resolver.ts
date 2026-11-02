import type {
  DependencyReference,
  DependencyResolution,
} from "../contracts/dependency";

import type { ProjectContext } from "../contracts/project-context";

const SUPPORTED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
] as const;

interface NormalisedPath {
  path: string;
  escapedRoot: boolean;
}

/**
 * Converts Windows separators to Unix-style separators and
 * removes redundant "." segments.
 *
 * Returns escapedRoot=true if ".." attempts to move above
 * the repository root.
 */
function normaliseRepoPath(input: string): NormalisedPath {
  const converted = input.replace(/\\/g, "/");

  // Reject absolute paths and Windows drive paths.
  if (converted.startsWith("/") || /^[a-zA-Z]:/.test(converted)) {
    return {
      path: "",
      escapedRoot: true,
    };
  }

  const segments: string[] = [];

  for (const segment of converted.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length === 0) {
        return {
          path: "",
          escapedRoot: true,
        };
      }

      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return {
    path: segments.join("/"),
    escapedRoot: false,
  };
}

/**
 * Returns the directory portion of a repository-relative path.
 */
function getDirectory(filePath: string): string {
  const separatorIndex = filePath.lastIndexOf("/");

  if (separatorIndex === -1) {
    return "";
  }

  return filePath.slice(0, separatorIndex);
}

/**
 * Combines a source directory and a relative import specifier.
 *
 * This is intentionally repository-relative. It does not use
 * the machine's filesystem or current working directory.
 */
function resolveBasePath(
  sourceFile: string,
  specifier: string,
): NormalisedPath {
  const sourceDirectory = getDirectory(sourceFile);

  return normaliseRepoPath(
    sourceDirectory ? `${sourceDirectory}/${specifier}` : specifier,
  );
}

/**
 * Generates candidate paths for a relative import.
 *
 * Extensionless imports are checked against common source
 * extensions and directory index files.
 *
 * Imports with an explicit extension are checked as written.
 * TypeScript's special .js-to-.ts substitution rules are
 * intentionally not implemented in this first version.
 */
function generateCandidates(basePath: string): string[] {
  const hasExtension = /\.[^/]+$/.test(basePath);

  if (hasExtension) {
    return [basePath];
  }

  const candidates: string[] = [];

  for (const extension of SUPPORTED_EXTENSIONS) {
    candidates.push(`${basePath}${extension}`);
  }

  for (const extension of SUPPORTED_EXTENSIONS) {
    candidates.push(`${basePath}/index${extension}`);
  }

  // Remove duplicates while preserving candidate order.
  return [...new Set(candidates)];
}

/**
 * Checks whether a candidate is equal to or beneath an
 * inaccessible file/directory.
 */
function isInaccessible(candidate: string, inaccessiblePath: string): boolean {
  const normalised = normaliseRepoPath(inaccessiblePath);

  if (normalised.escapedRoot || !normalised.path) {
    return false;
  }

  return (
    candidate === normalised.path || candidate.startsWith(`${normalised.path}/`)
  );
}

/**
 * Resolves a relative dependency using the supplied project
 * inventory.
 *
 * Important:
 * - This function does not read files from disk.
 * - It does not resolve npm packages.
 * - It does not resolve tsconfig aliases.
 * - It does not claim a dependency is missing when the
 *   available project inventory is incomplete.
 */

export function resolveRelativeDependency(
  reference: DependencyReference,
  context: ProjectContext,
): DependencyResolution {
  const evidence: string[] = [];

  const unresolved = (
    reason: string,
    additionalEvidence: string[] = [],
  ): DependencyResolution => ({
    status: "unresolved",
    reference,
    reason,
    evidence: [...evidence, ...additionalEvidence],
  });

  const missing = (
    reason: string,
    additionalEvidence: string[] = [],
  ): DependencyResolution => ({
    status: "missing",
    reference,
    reason,
    evidence: [...evidence, ...additionalEvidence],
  });

  // Normalise Windows separators before checking the import.
  const normalisedSpecifier = reference.specifier.replace(/\\/g, "/");

  if (reference.kind !== "relative") {
    return unresolved(`Unsupported dependency kind: "${reference.kind}".`, [
      "This resolver only handles relative imports.",
    ]);
  }

  if (!reference.sourceFile.trim()) {
    return unresolved("The source file path is empty.");
  }

  if (!normalisedSpecifier.trim()) {
    return unresolved("The dependency specifier is empty.");
  }

  if (
    !normalisedSpecifier.startsWith("./") &&
    !normalisedSpecifier.startsWith("../") &&
    normalisedSpecifier !== "." &&
    normalisedSpecifier !== ".."
  ) {
    return unresolved(
      `The specifier "${reference.specifier}" is not a relative import.`,
    );
  }

  const normalisedSource = normaliseRepoPath(reference.sourceFile);

  if (normalisedSource.escapedRoot || !normalisedSource.path) {
    return unresolved(
      "The source file path is invalid or escapes the repository root.",
    );
  }

  const normalisedBase = resolveBasePath(
    normalisedSource.path,
    normalisedSpecifier,
  );

  if (normalisedBase.escapedRoot || !normalisedBase.path) {
    return unresolved("The dependency path escapes the repository root.", [
      `Source file: ${normalisedSource.path}`,
      `Specifier: ${reference.specifier}`,
    ]);
  }

  evidence.push(
    `Source file: ${normalisedSource.path}`,
    `Import specifier: ${reference.specifier}`,
    `Resolved base path: ${normalisedBase.path}`,
  );

  const candidates = generateCandidates(normalisedBase.path);

  evidence.push(`Checked ${candidates.length} candidate path(s).`);

  const inventory = new Set<string>();

  for (const file of context.files) {
    const normalised = normaliseRepoPath(file);

    if (!normalised.escapedRoot && normalised.path) {
      inventory.add(normalised.path);
    }
  }

  const resolvedCandidate = candidates.find((candidate) =>
    inventory.has(candidate),
  );

  if (resolvedCandidate) {
    return {
      status: "resolved",
      reference,
      resolvedPath: resolvedCandidate,
      reason: "The dependency was found in the project file inventory.",
      evidence: [...evidence, `Matched project file: ${resolvedCandidate}`],
    };
  }

  const inaccessibleCandidate = candidates.find((candidate) =>
    context.inaccessiblePaths.some((inaccessiblePath) =>
      isInaccessible(candidate, inaccessiblePath),
    ),
  );

  if (inaccessibleCandidate) {
    return unresolved(
      "The dependency could not be verified because a relevant project path is inaccessible.",
      [
        `Potential candidate: ${inaccessibleCandidate}`,
        "At least one relevant file or directory could not be inspected.",
      ],
    );
  }

  if (!context.inventoryComplete) {
    return unresolved(
      "The dependency was not found, but the project file inventory is incomplete.",
      [
        "Absence cannot be confirmed until the relevant project inventory is complete.",
      ],
    );
  }

  return missing(
    "No supported candidate file was found in the complete project inventory.",
    candidates.map((candidate) => `Not found: ${candidate}`),
  );
}
