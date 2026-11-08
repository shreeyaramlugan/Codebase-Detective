// features/findings/facts/build-facts.ts
//
// Produces the source facts for an analysis from hash-verified file content.
// Content whose hash differs from the analysis record is NEVER used: the
// evidence of a finding must come from the exact snapshot that was analysed.
import { createHash } from "node:crypto";

import type {
  AnalysisRecords,
  SourceLocation,
} from "@/features/code-intelligence/contracts";

import type { FileFacts } from "../contracts";
import { extractFileFacts, FactsError } from "./source-facts";

export interface LoadedSource {
  content: string;
  contentHash: string;
}

export interface BuiltFacts {
  facts: Map<string, FileFacts>;
  /** path -> reason the facts could not be produced. */
  missing: Map<string, string>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function locationKey(location: SourceLocation): string {
  return `${location.startLine}:${location.startColumn}:${location.endLine}:${location.endColumn}`;
}

/**
 * Builds facts for every analysed file. `sources` maps path to the stored
 * content; a path absent from the map is reported as missing, never guessed.
 */
export function buildFacts(
  records: AnalysisRecords,
  sources: ReadonlyMap<string, LoadedSource>,
): BuiltFacts {
  const facts = new Map<string, FileFacts>();
  const missing = new Map<string, string>();

  // Function symbols by exact node location, per file. Sprint 03 records the
  // location of the whole function node, which is the same range the facts
  // pass reports, so linking never needs a heuristic.
  const symbolsByFile = new Map<string, Map<string, string>>();

  for (const symbol of records.symbols) {
    if (symbol.kind !== "FUNCTION" && symbol.kind !== "METHOD") continue;
    let byLocation = symbolsByFile.get(symbol.filePath);
    if (!byLocation) {
      byLocation = new Map();
      symbolsByFile.set(symbol.filePath, byLocation);
    }
    const key = locationKey(symbol.location);
    // An ambiguous location must not link to an arbitrary symbol.
    byLocation.set(key, byLocation.has(key) ? "" : symbol.key);
  }

  const files = [...records.files]
    .filter(
      (file) =>
        file.scriptKind !== null &&
        (file.status === "ANALYSED" || file.status === "ANALYSED_WITH_ERRORS"),
    )
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const file of files) {
    const source = sources.get(file.path);

    if (!source) {
      missing.set(file.path, "Source content is not available.");
      continue;
    }

    if (
      source.contentHash !== file.contentHash ||
      sha256(source.content) !== file.contentHash
    ) {
      missing.set(
        file.path,
        "Source content does not match the analysed content hash.",
      );
      continue;
    }

    try {
      const extracted = extractFileFacts(file.path, source.content);
      const byLocation = symbolsByFile.get(file.path);

      for (const fn of extracted.functions) {
        const linked = byLocation?.get(locationKey(fn.location)) ?? "";
        fn.symbolKey = linked === "" ? null : linked;
      }

      extracted.contentHash = file.contentHash;
      facts.set(file.path, extracted);
    } catch (error) {
      missing.set(
        file.path,
        error instanceof FactsError
          ? error.message
          : "Source facts could not be produced.",
      );
    }
  }

  return { facts, missing };
}
