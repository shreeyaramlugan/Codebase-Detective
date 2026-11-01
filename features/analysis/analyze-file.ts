import { parseTypeScript } from "./parsers/typescript-parser";
import { checkUnresolvedImports } from "./rules/unresolved-import.rule";

export function analyzeFile(
  sourceText: string,
  filePath: string,
  knownFiles: ReadonlySet<string>,
) {
  const parsed = parseTypeScript(
    sourceText,
    filePath,
  );

  const findings = parsed.isValid
    ? checkUnresolvedImports({
        filePath,
        imports: parsed.imports,
        knownFiles,
      })
    : [];

  return {
    parsed,
    findings,
  };
}