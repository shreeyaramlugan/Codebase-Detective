// features/findings/facts/source-facts.ts
//
// Syntax-only facts used by the complexity, structure and security rules.
//
// Sprint 03 stores relationships (symbols, imports, calls) but not
// per-function metrics or statement-level patterns, so this module derives
// them from the same syntax tree (same parser, same BOM handling, same
// line/column conventions). It performs NO type checking, loads no modules
// and never evaluates repository code. It does not discover relationships;
// those always come from the Sprint 03 records.
//
// METRIC DEFINITIONS (documented in docs/sprint-05-findings.md)
//  - cyclomatic complexity of a function = 1 + the number of decision points
//    directly inside it (nested functions are measured separately):
//    if, for, for-in, for-of, while, do-while, `case` clauses, catch clauses,
//    `?:`, and the operators && || ?? &&= ||= ??=.
//  - max nesting depth = deepest nesting of if / for / while / do / switch /
//    try / with statements inside the function (an `else if` does not add a
//    level).
//  - parameter count excludes a TypeScript `this` parameter.
//  - line span = last line - first line + 1.
import { createHash } from "node:crypto";

import ts from "typescript";

import {
  ANALYSIS_LIMITS,
  type SourceLocation,
} from "@/features/code-intelligence/contracts";
import { parseSource } from "@/features/code-intelligence/parser/source-parser";

import type {
  FileFacts,
  FunctionFacts,
  JsonPrimitive,
  SecurityIndicatorKind,
  SecuritySite,
} from "../contracts";

export const MAX_FUNCTIONS_PER_FILE = 20_000;
export const MAX_SECURITY_SITES_PER_FILE = 2_000;
/** Functions smaller than this are never structurally fingerprinted. */
export const MIN_HASHED_NODES = 20;

const EXCERPT_LENGTH = 160;

export class FactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactsError";
  }
}

// ---------------------------------------------------------------------------
// Credential patterns (also used to redact excerpts)
// ---------------------------------------------------------------------------

const CREDENTIAL_FORMATS: Array<{ name: string; pattern: RegExp }> = [
  { name: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "stripe-live-key", pattern: /\bsk_live_[0-9A-Za-z]{24,}\b/ },
  { name: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
];

const CREDENTIAL_NAME =
  /(^|[_-])(password|passwd|secret|api_?key|access_?key|secret_?key|private_?key|auth_?token|access_?token|client_?secret)$/i;

const CAMEL_CREDENTIAL_NAME =
  /(password|passwd|secret|apikey|accesskey|secretkey|privatekey|authtoken|accesstoken|clientsecret)$/i;

const PLACEHOLDER_VALUE =
  /^(x{3,}|\*{3,}|\.{3,}|<.*>|\$\{.*\}|\{\{.*\}\}|your[_-]|change[_-]?me|example|placeholder|todo|dummy|undefined|null|password|secret|test)/i;

export function looksLikeCredentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(name) || CAMEL_CREDENTIAL_NAME.test(name);
}

export function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length < 8 || /\s/.test(trimmed) || PLACEHOLDER_VALUE.test(trimmed)
  );
}

export function matchCredentialFormat(value: string): string | null {
  for (const format of CREDENTIAL_FORMATS) {
    if (format.pattern.test(value)) return format.name;
  }
  return null;
}

/** Collapses whitespace, truncates, and removes recognisable credentials. */
export function normaliseExcerpt(text: string): string {
  let result = text.replace(/\s+/g, " ").trim();

  for (const format of CREDENTIAL_FORMATS) {
    const global = new RegExp(format.pattern.source, "g");
    result = result.replace(global, `<redacted ${format.name}>`);
  }

  return result.length > EXCERPT_LENGTH
    ? `${result.slice(0, EXCERPT_LENGTH - 1)}…`
    : result;
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

interface FunctionContext {
  node: ts.Node;
  cyclomatic: number;
  depth: number;
  maxDepth: number;
  nodeCount: number;
  kinds: string[];
}

const NESTING_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.WithStatement,
]);

const DECISION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);

const DECISION_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function isFunctionWithBody(
  node: ts.Node,
): node is
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body !== undefined
  );
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): SourceLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function excerptOf(sourceFile: ts.SourceFile, node: ts.Node): string {
  const start = node.getStart(sourceFile);
  const { line } = sourceFile.getLineAndCharacterOfPosition(start);
  const lineStarts = sourceFile.getLineStarts();
  const from = lineStarts[line];
  const to =
    line + 1 < lineStarts.length
      ? lineStarts[line + 1]
      : sourceFile.text.length;

  return normaliseExcerpt(sourceFile.text.slice(from, to));
}

function isStaticString(
  node: ts.Node | undefined,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return (
    node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(
  name: ts.PropertyName | ts.BindingName,
): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const SHELL_BY_DEFAULT = new Set(["exec", "execSync"]);
const SHELL_OPTIONAL = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
]);

interface ChildProcessBindings {
  /** local name -> imported function name */
  functions: Map<string, string>;
  /** local names bound to the whole module */
  namespaces: Set<string>;
}

function collectChildProcessBindings(
  sourceFile: ts.SourceFile,
): ChildProcessBindings {
  const functions = new Map<string, string>();
  const namespaces = new Set<string>();

  const bindRequire = (declaration: ts.VariableDeclaration) => {
    const init = declaration.initializer && unwrap(declaration.initializer);
    if (
      !init ||
      !ts.isCallExpression(init) ||
      !ts.isIdentifier(init.expression) ||
      init.expression.text !== "require" ||
      !isStaticString(init.arguments[0]) ||
      !CHILD_PROCESS_MODULES.has(init.arguments[0].text)
    ) {
      return;
    }

    if (ts.isIdentifier(declaration.name)) {
      namespaces.add(declaration.name.text);
    } else if (ts.isObjectBindingPattern(declaration.name)) {
      for (const element of declaration.name.elements) {
        const imported =
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : ts.isIdentifier(element.name)
              ? element.name.text
              : null;
        if (imported && ts.isIdentifier(element.name)) {
          functions.set(element.name.text, imported);
        }
      }
    }
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      CHILD_PROCESS_MODULES.has(statement.moduleSpecifier.text)
    ) {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) namespaces.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          functions.set(
            element.name.text,
            (element.propertyName ?? element.name).text,
          );
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      statement.declarationList.declarations.forEach(bindRequire);
    }
  }

  return { functions, namespaces };
}

function isFalseKeyword(node: ts.Node | undefined): boolean {
  return node !== undefined && node.kind === ts.SyntaxKind.FalseKeyword;
}

function hasShellTrue(args: readonly ts.Expression[]): boolean {
  for (const argument of args) {
    const expression = unwrap(argument);
    if (!ts.isObjectLiteralExpression(expression)) continue;
    for (const property of expression.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        propertyNameText(property.name) === "shell"
      ) {
        const value = unwrap(property.initializer);
        if (
          value.kind === ts.SyntaxKind.TrueKeyword ||
          ts.isStringLiteral(value)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function accessChain(node: ts.Expression): string | null {
  const expression = unwrap(node);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const left = accessChain(expression.expression);
    return left === null ? null : `${left}.${expression.name.text}`;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    isStaticString(expression.argumentExpression)
  ) {
    const left = accessChain(expression.expression);
    return left === null
      ? null
      : `${left}.${expression.argumentExpression.text}`;
  }
  return null;
}

export function extractFileFacts(path: string, content: string): FileFacts {
  const parsed = parseSource(path, content);
  const { sourceFile } = parsed;

  const functions: FunctionFacts[] = [];
  const sites: SecuritySite[] = [];
  const stack: FunctionContext[] = [];
  const childProcess = collectChildProcessBindings(sourceFile);

  const addSite = (
    indicator: SecurityIndicatorKind,
    node: ts.Node,
    detail: Record<string, JsonPrimitive>,
    excerpt?: string,
  ) => {
    if (sites.length >= MAX_SECURITY_SITES_PER_FILE) return;
    sites.push({
      indicator,
      location: locationOf(sourceFile, node),
      excerpt: excerpt ?? excerptOf(sourceFile, node),
      detail,
    });
  };

  // --- security pattern checks -------------------------------------------

  const checkCall = (node: ts.CallExpression | ts.NewExpression) => {
    const callee = unwrap(node.expression);
    const args = node.arguments ?? [];
    const first = args[0] && unwrap(args[0]);
    const dynamic = first !== undefined && !isStaticString(first);

    // eval(...), Function(...), new Function(...)
    if (ts.isIdentifier(callee)) {
      if (callee.text === "eval" && ts.isCallExpression(node)) {
        addSite("DYNAMIC_CODE_EVALUATION", node, {
          callee: "eval",
          dynamicArgument: dynamic || args.length === 0,
        });
      } else if (callee.text === "Function") {
        const body =
          args.length > 0 ? unwrap(args[args.length - 1]) : undefined;
        addSite("DYNAMIC_CODE_EVALUATION", node, {
          callee: "Function",
          dynamicArgument: body !== undefined && !isStaticString(body),
        });
      } else if (
        (callee.text === "setTimeout" || callee.text === "setInterval") &&
        isStaticString(first)
      ) {
        addSite("DYNAMIC_CODE_EVALUATION", node, {
          callee: callee.text,
          dynamicArgument: false,
          stringHandler: true,
        });
      }
    }

    // child_process execution
    let childFunction: string | null = null;
    if (ts.isIdentifier(callee)) {
      childFunction = childProcess.functions.get(callee.text) ?? null;
    } else if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      childProcess.namespaces.has(callee.expression.text)
    ) {
      childFunction = callee.name.text;
    }

    if (childFunction && ts.isCallExpression(node)) {
      const viaShell =
        SHELL_BY_DEFAULT.has(childFunction) ||
        (SHELL_OPTIONAL.has(childFunction) && hasShellTrue(args));

      if (viaShell) {
        addSite("SHELL_COMMAND_EXECUTION", node, {
          function: childFunction,
          dynamicCommand: dynamic || args.length === 0,
          shellOption: !SHELL_BY_DEFAULT.has(childFunction),
        });
      }
    }

    // createHash("md5" | "sha1")
    const hashCallee = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : null;

    if (
      hashCallee === "createHash" &&
      isStaticString(first) &&
      ["md5", "md4", "sha1", "sha-1"].includes(first.text.toLowerCase())
    ) {
      addSite("WEAK_HASH_ALGORITHM", node, {
        algorithm: first.text.toLowerCase(),
      });
    }

    // HTML sinks as calls
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      const target = accessChain(callee.expression);

      if (
        method === "insertAdjacentHTML" ||
        (target === "document" && (method === "write" || method === "writeln"))
      ) {
        const value = args[args.length - 1] && unwrap(args[args.length - 1]);
        addSite("HTML_INJECTION_SINK", node, {
          sink: target === "document" ? `document.${method}` : method,
          dynamicValue: value !== undefined && !isStaticString(value),
        });
      }
    }
  };

  const checkAssignment = (node: ts.BinaryExpression) => {
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;

    const left = unwrap(node.left);
    const right = unwrap(node.right);

    if (
      ts.isPropertyAccessExpression(left) &&
      (left.name.text === "innerHTML" || left.name.text === "outerHTML")
    ) {
      addSite("HTML_INJECTION_SINK", node, {
        sink: left.name.text,
        dynamicValue: !isStaticString(right),
      });
    }

    const chain = accessChain(left);
    if (
      chain === "process.env.NODE_TLS_REJECT_UNAUTHORIZED" &&
      isStaticString(right) &&
      right.text === "0"
    ) {
      addSite("TLS_VERIFICATION_DISABLED", node, {
        setting: "NODE_TLS_REJECT_UNAUTHORIZED",
      });
    }
  };

  const checkCredential = (
    node: ts.Node,
    name: string | null,
    value: ts.Expression | undefined,
  ) => {
    if (!value) return;
    const literal = unwrap(value);
    if (!isStaticString(literal)) return;

    const format = matchCredentialFormat(literal.text);
    if (format) {
      addSite(
        "HARDCODED_CREDENTIAL",
        node,
        { match: "known-format", format, length: literal.text.length },
        `<redacted ${format} literal, ${literal.text.length} characters>`,
      );
      return;
    }

    if (
      name &&
      looksLikeCredentialName(name) &&
      !isPlaceholderValue(literal.text)
    ) {
      addSite(
        "HARDCODED_CREDENTIAL",
        node,
        { match: "credential-name", name, length: literal.text.length },
        `${name} = <redacted string literal, ${literal.text.length} characters>`,
      );
    }
  };

  const checkNode = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      checkCall(node);
    } else if (ts.isBinaryExpression(node)) {
      checkAssignment(node);
      // obj.password = "..." / password = "..."
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = unwrap(node.left);
        const name = ts.isIdentifier(left)
          ? left.text
          : ts.isPropertyAccessExpression(left)
            ? left.name.text
            : null;
        checkCredential(node, name, node.right);
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyNameText(node.name);
      if (
        name === "rejectUnauthorized" &&
        isFalseKeyword(unwrap(node.initializer))
      ) {
        addSite("TLS_VERIFICATION_DISABLED", node, {
          setting: "rejectUnauthorized",
        });
      }
      checkCredential(node, name, node.initializer);
    } else if (ts.isVariableDeclaration(node)) {
      checkCredential(node, propertyNameText(node.name), node.initializer);
    } else if (ts.isPropertyDeclaration(node)) {
      checkCredential(node, propertyNameText(node.name), node.initializer);
    } else if (ts.isJsxAttribute(node)) {
      const attributeName = ts.isIdentifier(node.name) ? node.name.text : null;
      if (attributeName === "dangerouslySetInnerHTML") {
        let dynamicValue = true;
        const initializer = node.initializer;
        if (
          initializer &&
          ts.isJsxExpression(initializer) &&
          initializer.expression
        ) {
          const object = unwrap(initializer.expression);
          if (ts.isObjectLiteralExpression(object)) {
            const html = object.properties.find(
              (property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) &&
                propertyNameText(property.name) === "__html",
            );
            if (html && isStaticString(unwrap(html.initializer))) {
              dynamicValue = false;
            }
          }
        }
        addSite("HTML_INJECTION_SINK", node, {
          sink: "dangerouslySetInnerHTML",
          dynamicValue,
        });
      }
    }
  };

  // --- single traversal ----------------------------------------------------

  let truncated = false;

  const visit = (node: ts.Node, depth: number) => {
    if (depth > ANALYSIS_LIMITS.MAX_AST_DEPTH) {
      truncated = true;
      return;
    }

    for (const context of stack) {
      context.nodeCount += 1;
      context.kinds.push(ts.SyntaxKind[node.kind]);
    }

    const top = stack[stack.length - 1];

    if (top) {
      if (DECISION_KINDS.has(node.kind)) top.cyclomatic += 1;
      if (
        ts.isBinaryExpression(node) &&
        DECISION_OPERATORS.has(node.operatorToken.kind)
      ) {
        top.cyclomatic += 1;
      }
    }

    checkNode(node);

    const isFunction = isFunctionWithBody(node);
    if (isFunction) {
      stack.push({
        node,
        cyclomatic: 1,
        depth: 0,
        maxDepth: 0,
        nodeCount: 0,
        kinds: [],
      });
    }

    const isElseIf =
      ts.isIfStatement(node) &&
      node.parent !== undefined &&
      ts.isIfStatement(node.parent) &&
      node.parent.elseStatement === node;

    const nests =
      stack.length > 0 &&
      NESTING_KINDS.has(node.kind) &&
      !isElseIf &&
      !isFunction;
    const context = stack[stack.length - 1];

    if (nests && context) {
      context.depth += 1;
      context.maxDepth = Math.max(context.maxDepth, context.depth);
    }

    ts.forEachChild(node, (child) => visit(child, depth + 1));

    if (nests && context) context.depth -= 1;

    if (isFunction) {
      const finished = stack.pop()!;
      if (functions.length < MAX_FUNCTIONS_PER_FILE) {
        const location = locationOf(sourceFile, node);
        const parameters = (
          node as ts.FunctionLikeDeclaration
        ).parameters.filter(
          (parameter) =>
            !(
              ts.isIdentifier(parameter.name) && parameter.name.text === "this"
            ),
        );

        functions.push({
          symbolKey: null,
          location,
          cyclomatic: finished.cyclomatic,
          maxNesting: finished.maxDepth,
          parameterCount: parameters.length,
          lineSpan: location.endLine - location.startLine + 1,
          nodeCount: finished.nodeCount,
          structureHash:
            finished.nodeCount >= MIN_HASHED_NODES
              ? createHash("sha256")
                  .update(finished.kinds.join(","))
                  .digest("hex")
                  .slice(0, 32)
              : null,
        });
      }
    }
  };

  visit(sourceFile, 0);

  if (truncated) {
    throw new FactsError("The syntax tree is too deeply nested to measure.");
  }

  functions.sort(
    (a, b) =>
      a.location.startLine - b.location.startLine ||
      a.location.startColumn - b.location.startColumn ||
      b.location.endLine - a.location.endLine,
  );
  sites.sort(
    (a, b) =>
      a.location.startLine - b.location.startLine ||
      a.location.startColumn - b.location.startColumn ||
      a.indicator.localeCompare(b.indicator),
  );

  return {
    path,
    contentHash: "",
    lineCount: parsed.lineCount,
    statementCount: sourceFile.statements.length,
    syntaxErrorCount: parsed.syntaxDiagnostics.length,
    functions,
    securitySites: sites,
  };
}
