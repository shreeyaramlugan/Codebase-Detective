import type { AnalysisFinding } from "../contracts/finding";
import type { ParsedImport } from "../contracts/parser";

import { resolveRelativeImport } from "../dependency-graph/module-resolver";

export interface UnresolvedImportInput {
  filePath: string;
  imports: ParsedImport[];
  knownFiles: ReadonlySet<string>;
}

export function checkUnresolvedImports(
  input: UnresolvedImportInput,
): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];

  for (const imported of input.imports) {
    if (!imported.source.startsWith(".")) {
      continue;
    }

    const resolved = resolveRelativeImport(
      input.filePath,
      imported.source,
      input.knownFiles,
    );

    if (resolved) {
      continue;
    }

    findings.push({
      ruleId: "IMPORT001",
      title: "Unresolved relative import",
      description:
        `The relative import "${imported.source}" could not be matched ` +
        "against the supplied project file inventory.",
      severity: "medium",
      location: {
        path: input.filePath,
        startLine: imported.line,
        endLine: imported.line,
      },
      evidence: [
        `Import source: ${imported.source}`,
        `Importer: ${input.filePath}`,
        "No matching candidate was found in the supplied file inventory.",
      ],
      recommendation:
        "Verify the import path, file name, extension, and directory structure.",
    });
  }

  return findings;
}
