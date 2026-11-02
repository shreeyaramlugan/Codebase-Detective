import ts from "typescript";

import type {
  ImportKind,
  ParsedDeclaration,
  ParsedExport,
  ParsedImport,
  ParsedSourceFile,
} from "../contracts/parser";

const SCRIPT_KIND = ts.ScriptKind.TSX;

function getLine(sourceFile: ts.SourceFile, position: number) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function getColumn(sourceFile: ts.SourceFile, position: number) {
  return sourceFile.getLineAndCharacterOfPosition(position).character + 1;
}

function getDeclarationKind(node: ts.Node): ParsedDeclaration["kind"] | null {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";

  if (ts.isVariableStatement(node)) return "variable";

  return null;
}

function getDeclarationName(node: ts.Node): string | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return node.name?.text ?? null;
  }

  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations
      .map((declaration) => {
        return ts.isIdentifier(declaration.name) ? declaration.name.text : null;
      })
      .filter((name): name is string => name !== null)
      .join(", ");
  }

  return null;
}

function getImportKind(node: ts.ImportDeclaration): ImportKind {
  if (node.importClause?.isTypeOnly) {
    return "type";
  }

  return "es";
}

export function parseTypeScript(
  sourceText: string,
  filePath: string,
): ParsedSourceFile {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : filePath.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : SCRIPT_KIND,
  );

  const imports: ParsedImport[] = [];
  const exports: ParsedExport[] = [];
  const declarations: ParsedDeclaration[] = [];

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        const position = node.getStart(sourceFile);

        imports.push({
          source: node.moduleSpecifier.text,
          kind: getImportKind(node),
          line: getLine(sourceFile, position),
          column: getColumn(sourceFile, position),
        });
      }
    }

    if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const position = node.getStart(sourceFile);

        imports.push({
          source: node.arguments[0].text,
          kind: "dynamic",
          line: getLine(sourceFile, position),
          column: getColumn(sourceFile, position),
        });
      }

      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const position = node.getStart(sourceFile);

        imports.push({
          source: node.arguments[0].text,
          kind: "require",
          line: getLine(sourceFile, position),
          column: getColumn(sourceFile, position),
        });
      }
    }

    if (
      ts.isExportDeclaration(node) &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        exports.push({
          name: element.name.text,
          kind: "named",
          line: getLine(sourceFile, node.getStart(sourceFile)),
        });
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      exports.push({
        name: "*",
        kind: "all",
        line: getLine(sourceFile, node.getStart(sourceFile)),
      });
    }

    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      exports.push({
        name: "default",
        kind: "default",
        line: getLine(sourceFile, node.getStart(sourceFile)),
      });
    }

    if (ts.canHaveModifiers(node)) {
      const modifiers = ts.getModifiers(node);

      if (
        modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        const name = getDeclarationName(node);
        const kind = getDeclarationKind(node);

        if (name && kind) {
          declarations.push({
            name,
            kind,
            line: getLine(sourceFile, node.getStart(sourceFile)),
            endLine: getLine(sourceFile, node.end),
          });

          if (
            modifiers.some(
              (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
            )
          ) {
            exports.push({
              name,
              kind: "default",
              line: getLine(sourceFile, node.getStart(sourceFile)),
            });
          } else {
            exports.push({
              name,
              kind: "named",
              line: getLine(sourceFile, node.getStart(sourceFile)),
            });
          }
        }
      } else {
        const kind = getDeclarationKind(node);
        const name = getDeclarationName(node);

        if (kind && name) {
          declarations.push({
            name,
            kind,
            line: getLine(sourceFile, node.getStart(sourceFile)),
            endLine: getLine(sourceFile, node.end),
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const diagnostics = (
    sourceFile as ts.SourceFile & {
      parseDiagnostics: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics.map((diagnostic: ts.Diagnostic) => {
    const position = diagnostic.start ?? 0;

    const location = sourceFile.getLineAndCharacterOfPosition(position);

    return {
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      line: location.line + 1,
      column: location.character + 1,
      code: diagnostic.code,
    };
  });
  const lineCount =
    sourceText.length === 0 ? 0 : sourceText.split(/\r\n|\r|\n/).length;

  return {
    filePath,
    imports,
    exports,
    declarations,
    diagnostics,
    lineCount,
    isValid: diagnostics.length === 0,
  };
}
