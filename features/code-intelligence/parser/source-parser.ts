// features/code-intelligence/parser/source-parser.ts
//
// Syntax-only parsing using the TypeScript Compiler API.
//
// IMPORTANT: this performs parsing only. It does not create a Program, does
// not type-check, does not load modules and never evaluates repository code.
// Diagnostics reported here are syntax diagnostics, not compiler errors.
import ts from "typescript";

import type { DiagnosticRecord, ScriptKindName } from "../contracts";
import { getScriptKindName, toTsScriptKind } from "./script-kind";

/** Version of the parser recorded against every analysis run. */
export const PARSER_VERSION = `typescript@${ts.version}`;

export interface ParsedSource {
  sourceFile: ts.SourceFile;
  scriptKind: ScriptKindName;
  lineCount: number;
  syntaxDiagnostics: DiagnosticRecord[];
}

export class UnsupportedSourceError extends Error {
  constructor(path: string) {
    super(`Unsupported source file extension: ${path}`);
    this.name = "UnsupportedSourceError";
  }
}

/** Removes a UTF-8 byte order mark so positions match what editors show. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseSource(path: string, rawText: string): ParsedSource {
  const scriptKind = getScriptKindName(path);

  if (!scriptKind) {
    throw new UnsupportedSourceError(path);
  }

  const text = stripBom(rawText);

  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    toTsScriptKind(scriptKind),
  );

  // `parseDiagnostics` is populated by the parser itself. It is not part of
  // the public typings but has been stable across TypeScript releases; if it
  // ever disappears we degrade to "no syntax diagnostics" rather than crash.
  const raw =
    (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? [];

  const syntaxDiagnostics: DiagnosticRecord[] = raw.map((diagnostic) => {
    const position = diagnostic.start ?? 0;
    const location = sourceFile.getLineAndCharacterOfPosition(position);

    return {
      severity: "ERROR",
      source: "PARSER",
      code: `TS${diagnostic.code}`,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      path,
      line: location.line + 1,
      column: location.character + 1,
      details: null,
    };
  });

  const lineCount = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;

  return { sourceFile, scriptKind, lineCount, syntaxDiagnostics };
}
