// features/code-intelligence/extraction/extract-file.ts
//
// Converts one parsed AST into structured, source-located code entities:
// symbols, dependencies (imports/exports/CommonJS), call evidence and
// relationship evidence (extends/implements/type references).
//
// The extractor reports only what the syntax states. Anything it cannot
// establish from syntax alone (a computed callee, a dynamic require, an
// exotic default export) is recorded as a diagnostic or an explicitly
// "dynamic" call shape - it is never presented as a confirmed finding.
// Resolution of names to targets happens later, in the linker.
import ts from "typescript";

import {
  ANALYSIS_LIMITS,
  type CallKind,
  type DependencyBinding,
  type DependencyKind,
  type DiagnosticRecord,
  type ModuleSyntax,
  type ModuleSystem,
  type RelationKind,
  type SourceLocation,
  type SymbolKind,
  type SymbolRecord,
} from "../contracts";
import { getDeclaredModuleSyntax } from "../parser/script-kind";
import type { ParsedSource } from "../parser/source-parser";
import { createSymbolKey } from "../registry/symbol-identity";

export type CalleeShape =
  | { type: "identifier"; name: string }
  | {
      type: "member";
      base: "identifier" | "this" | "super";
      baseName: string | null;
      path: string[];
      invoker: "call" | "apply" | null;
    }
  | { type: "direct" }
  | { type: "super-constructor" }
  | { type: "dynamic"; reason: string };

export interface RawDependency {
  kind: DependencyKind;
  specifier: string;
  isTypeOnly: boolean;
  moduleSystem: ModuleSystem;
  bindings: DependencyBinding[];
  location: SourceLocation;
  /** Enclosing symbol, used for lexical binding visibility. */
  scopeKey: string | null;
}

export interface RawCall {
  callerKey: string | null;
  classKey: string | null;
  kind: CallKind;
  calleeText: string;
  shape: CalleeShape;
  optional: boolean;
  location: SourceLocation;
  /** For immediately-invoked function expressions. */
  directTargetKey: string | null;
}

export interface RawRelation {
  kind: RelationKind;
  sourceKey: string | null;
  scopeKey: string | null;
  /** Qualified name parts, or null when the expression is not a plain name. */
  targetPath: string[] | null;
  targetName: string;
  location: SourceLocation;
}

export interface ExtractedFile {
  path: string;
  moduleSyntax: ModuleSyntax;
  symbols: SymbolRecord[];
  dependencies: RawDependency[];
  calls: RawCall[];
  relations: RawRelation[];
  /** Names bound locally per scope key ("" = file level) that shadow outer names. */
  shadows: Record<string, string[]>;
  diagnostics: DiagnosticRecord[];
}

interface Scope {
  symbolKey: string | null;
  classKey: string | null;
}

interface FunctionOptions {
  name: string;
  kind: "FUNCTION" | "METHOD";
  /** For METHOD symbols: the class key `this` refers to inside the body. */
  classKey?: string | null;
  exportNames?: string[];
  isDefault?: boolean;
  details?: Record<string, unknown>;
  lexicallyVisible: boolean;
}

type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

const ROOT = "";

function truncate(text: string): string {
  return text.length > ANALYSIS_LIMITS.MAX_TEXT_LENGTH
    ? `${text.slice(0, ANALYSIS_LIMITS.MAX_TEXT_LENGTH)}…`
    : text;
}

export function extractFile(parsed: ParsedSource, path: string): ExtractedFile {
  const sf = parsed.sourceFile;
  const symbols: SymbolRecord[] = [];
  const dependencies: RawDependency[] = [];
  const calls: RawCall[] = [];
  const relations: RawRelation[] = [];
  const diagnostics: DiagnosticRecord[] = [];
  const shadows = new Map<string, Set<string>>();
  const qualifiedNames = new Map<string, string>();
  const ordinals = new Map<string, number>();
  const nodeKeys = new Map<ts.Node, string>();
  const pendingCalls: Array<{ call: RawCall; node: ts.Node | null }> = [];
  const pendingAliases: Array<{
    exportName: string;
    localName: string;
    location: SourceLocation;
    isTypeOnly: boolean;
  }> = [];

  let sawEsm = false;
  let sawCjs = false;
  let depthReported = false;
  let symbolLimitReported = false;
  let callLimitReported = false;

  const root: Scope = { symbolKey: null, classKey: null };

  // ---------- helpers ----------

  function locOf(node: ts.Node): SourceLocation {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(node.getEnd());
    return {
      startLine: start.line + 1,
      startColumn: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
    };
  }

  function diag(
    severity: DiagnosticRecord["severity"],
    code: string,
    message: string,
    node: ts.Node | null,
    details: Record<string, unknown> | null = null,
  ) {
    const location = node ? locOf(node) : null;
    diagnostics.push({
      severity,
      source: "EXTRACTOR",
      code,
      message,
      path,
      line: location?.startLine ?? null,
      column: location?.startColumn ?? null,
      details,
    });
  }

  function addShadow(scopeKey: string | null, name: string) {
    const key = scopeKey ?? ROOT;
    const set = shadows.get(key);
    if (set) set.add(name);
    else shadows.set(key, new Set([name]));
  }

  function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return (
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false)
    );
  }

  function unwrap(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  }

  function isFunctionLikeExpression(
    node: ts.Node,
  ): node is ts.FunctionExpression | ts.ArrowFunction {
    return ts.isFunctionExpression(node) || ts.isArrowFunction(node);
  }

  function propertyNameText(
    name: ts.PropertyName | ts.BindingName | undefined,
  ): {
    text: string;
    computed: boolean;
  } {
    if (!name) return { text: "<anonymous>", computed: false };
    if (
      ts.isIdentifier(name) ||
      ts.isStringLiteral(name) ||
      ts.isNumericLiteral(name) ||
      ts.isPrivateIdentifier(name) ||
      ts.isNoSubstitutionTemplateLiteral(name)
    ) {
      return { text: name.text, computed: false };
    }
    return { text: `[${truncate(name.getText(sf))}]`, computed: true };
  }

  function bindingNames(name: ts.BindingName): string[] {
    if (ts.isIdentifier(name)) return [name.text];
    const names: string[] = [];
    for (const element of name.elements) {
      if (ts.isBindingElement(element))
        names.push(...bindingNames(element.name));
    }
    return names;
  }

  /** `a.b.c` / `A.B` as parts, or null when it is not a plain name. */
  function entityPath(node: ts.Node): string[] | null {
    if (ts.isIdentifier(node)) return [node.text];
    if (ts.isQualifiedName(node)) {
      const left = entityPath(node.left);
      return left ? [...left, node.right.text] : null;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const left = entityPath(node.expression);
      return left ? [...left, node.name.text] : null;
    }
    if (ts.isParenthesizedExpression(node)) return entityPath(node.expression);
    return null;
  }

  function typeParameterNames(
    list: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  ): string[] {
    return list ? list.map((parameter) => parameter.name.text) : [];
  }

  function topLevelExport(
    node: ts.Node,
  ): { exportNames: string[]; isDefault: boolean } | null {
    if (node.parent !== sf) return null;
    if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) return null;
    sawEsm = true;
    return hasModifier(node, ts.SyntaxKind.DefaultKeyword)
      ? { exportNames: ["default"], isDefault: true }
      : { exportNames: [], isDefault: false }; // caller adds its own name
  }

  function createSymbol(input: {
    name: string;
    kind: SymbolKind;
    node: ts.Node;
    scope: Scope;
    exportNames?: string[];
    isDefault?: boolean;
    details?: Record<string, unknown>;
  }): SymbolRecord | null {
    if (symbols.length >= ANALYSIS_LIMITS.MAX_SYMBOLS_PER_FILE) {
      if (!symbolLimitReported) {
        symbolLimitReported = true;
        diag(
          "WARNING",
          "SYMBOL_LIMIT_EXCEEDED",
          `More than ${ANALYSIS_LIMITS.MAX_SYMBOLS_PER_FILE} symbols in one file; further symbols were not recorded.`,
          input.node,
        );
      }
      return null;
    }

    const parentKey = input.scope.symbolKey;
    const ordinalKey = `${parentKey ?? ""}|${input.kind}|${input.name}`;
    const ordinal = ordinals.get(ordinalKey) ?? 0;
    ordinals.set(ordinalKey, ordinal + 1);

    const key = createSymbolKey({
      filePath: path,
      parentKey,
      kind: input.kind,
      name: input.name,
      ordinal,
    });

    const parentQualified = parentKey ? qualifiedNames.get(parentKey) : null;
    const qualifiedName = parentQualified
      ? `${parentQualified}.${input.name}`
      : input.name;
    qualifiedNames.set(key, qualifiedName);
    nodeKeys.set(input.node, key);

    const exportNames = [...(input.exportNames ?? [])];

    const symbol: SymbolRecord = {
      key,
      filePath: path,
      name: input.name,
      kind: input.kind,
      qualifiedName,
      parentKey,
      isExported: exportNames.length > 0,
      isDefaultExport: input.isDefault ?? false,
      exportNames,
      location: locOf(input.node),
      details: { ordinal, ...(input.details ?? {}) },
    };

    symbols.push(symbol);
    return symbol;
  }

  function addExport(symbol: SymbolRecord, exportName: string) {
    if (!symbol.exportNames.includes(exportName)) {
      symbol.exportNames.push(exportName);
    }
    symbol.isExported = true;
    if (exportName === "default") symbol.isDefaultExport = true;
  }

  function describeParameters(
    parameters: ts.NodeArray<ts.ParameterDeclaration>,
  ) {
    const details = parameters.map((parameter) => {
      const { text } = propertyNameText(parameter.name);
      return {
        name: ts.isIdentifier(parameter.name)
          ? parameter.name.text
          : truncate(text),
        optional: parameter.questionToken !== undefined,
        rest: parameter.dotDotDotToken !== undefined,
        hasDefault: parameter.initializer !== undefined,
        type: parameter.type ? truncate(parameter.type.getText(sf)) : null,
      };
    });
    const names = parameters.flatMap((parameter) =>
      bindingNames(parameter.name),
    );
    return { details, names };
  }

  // ---------- calls ----------

  function describeCallee(
    expression: ts.Expression,
    isSuperCall: boolean,
  ): { shape: CalleeShape; direct: ts.Node | null } {
    if (isSuperCall)
      return { shape: { type: "super-constructor" }, direct: null };

    const callee = unwrap(expression);

    if (ts.isIdentifier(callee)) {
      return { shape: { type: "identifier", name: callee.text }, direct: null };
    }

    if (isFunctionLikeExpression(callee)) {
      return { shape: { type: "direct" }, direct: callee };
    }

    if (
      ts.isPropertyAccessExpression(callee) ||
      ts.isElementAccessExpression(callee)
    ) {
      const path: string[] = [];
      let current: ts.Expression = callee;

      while (true) {
        current = unwrap(current);
        if (ts.isPropertyAccessExpression(current)) {
          path.unshift(current.name.text);
          current = current.expression;
        } else if (
          ts.isElementAccessExpression(current) &&
          ts.isStringLiteralLike(current.argumentExpression)
        ) {
          path.unshift(current.argumentExpression.text);
          current = current.expression;
        } else if (ts.isElementAccessExpression(current)) {
          return {
            shape: { type: "dynamic", reason: "computed member access" },
            direct: null,
          };
        } else {
          break;
        }
      }

      let base: "identifier" | "this" | "super";
      let baseName: string | null = null;

      if (ts.isIdentifier(current)) {
        base = "identifier";
        baseName = current.text;
      } else if (current.kind === ts.SyntaxKind.ThisKeyword) {
        base = "this";
      } else if (current.kind === ts.SyntaxKind.SuperKeyword) {
        base = "super";
      } else {
        return {
          shape: {
            type: "dynamic",
            reason: "callee is a member of a computed expression",
          },
          direct: null,
        };
      }

      let invoker: "call" | "apply" | null = null;
      const last = path[path.length - 1];
      if (path.length >= 1 && (last === "call" || last === "apply")) {
        invoker = last;
        path.pop();
      }

      return {
        shape: { type: "member", base, baseName, path, invoker },
        direct: null,
      };
    }

    if (ts.isCallExpression(callee)) {
      return {
        shape: {
          type: "dynamic",
          reason: "callee is the result of another call",
        },
        direct: null,
      };
    }

    return {
      shape: { type: "dynamic", reason: "callee is a computed expression" },
      direct: null,
    };
  }

  function recordCall(
    node: ts.CallExpression | ts.NewExpression,
    scope: Scope,
  ) {
    if (
      calls.length + pendingCalls.length >=
      ANALYSIS_LIMITS.MAX_CALLS_PER_FILE
    ) {
      if (!callLimitReported) {
        callLimitReported = true;
        diag(
          "WARNING",
          "CALL_LIMIT_EXCEEDED",
          `More than ${ANALYSIS_LIMITS.MAX_CALLS_PER_FILE} calls in one file; further calls were not recorded.`,
          node,
        );
      }
      return;
    }

    const isNew = ts.isNewExpression(node);
    const isSuperCall =
      !isNew && node.expression.kind === ts.SyntaxKind.SuperKeyword;
    const { shape, direct } = describeCallee(node.expression, isSuperCall);

    const call: RawCall = {
      callerKey: scope.symbolKey,
      classKey: scope.classKey,
      kind: isNew ? "NEW" : isSuperCall ? "SUPER" : "CALL",
      calleeText: truncate(node.expression.getText(sf)),
      shape,
      optional: !isNew && ts.isOptionalChain(node),
      location: locOf(node),
      directTargetKey: null,
    };

    pendingCalls.push({ call, node: direct });
  }

  // ---------- imports / requires ----------

  function addDependency(dep: RawDependency) {
    dependencies.push(dep);
  }

  function isRequireCall(node: ts.Node): boolean {
    return (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    );
  }

  function isLiteralDynamicImport(node: ts.Node): boolean {
    return (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    );
  }

  /**
   * For `const x = require("m")`, `const {a, b: c} = require("m")` and
   * `const a = require("m").a`, derives the local bindings of the module.
   */
  function bindingsFromContext(
    call: ts.CallExpression,
    wholeKind: "whole" | "namespace",
  ): DependencyBinding[] {
    const climb = (node: ts.Node): ts.Node => {
      let current = node;
      while (
        current.parent &&
        (ts.isParenthesizedExpression(current.parent) ||
          ts.isAwaitExpression(current.parent) ||
          ts.isAsExpression(current.parent) ||
          ts.isNonNullExpression(current.parent) ||
          ts.isSatisfiesExpression(current.parent))
      ) {
        current = current.parent;
      }
      return current;
    };

    let current = climb(call);
    let property: string | null = null;

    if (
      current.parent &&
      ts.isPropertyAccessExpression(current.parent) &&
      current.parent.expression === current
    ) {
      property = current.parent.name.text;
      current = climb(current.parent);
    }

    const declaration = current.parent;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer !== current
    ) {
      return [];
    }

    if (property !== null) {
      return ts.isIdentifier(declaration.name)
        ? [
            {
              imported: property,
              local: declaration.name.text,
              kind: "named",
              isTypeOnly: false,
            },
          ]
        : [];
    }

    if (ts.isIdentifier(declaration.name)) {
      return [
        {
          imported: null,
          local: declaration.name.text,
          kind: wholeKind,
          isTypeOnly: false,
        },
      ];
    }

    if (ts.isObjectBindingPattern(declaration.name)) {
      const bindings: DependencyBinding[] = [];
      for (const element of declaration.name.elements) {
        if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
        const imported = element.propertyName
          ? propertyNameText(element.propertyName)
          : { text: element.name.text, computed: false };
        if (imported.computed) continue;
        bindings.push({
          imported: imported.text,
          local: element.name.text,
          kind: "named",
          isTypeOnly: false,
        });
      }
      return bindings;
    }

    return [];
  }

  function visitImportDeclaration(node: ts.ImportDeclaration, scope: Scope) {
    sawEsm = true;
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;

    const clause = node.importClause;
    const bindings: DependencyBinding[] = [];
    const clauseTypeOnly = clause?.isTypeOnly ?? false;

    if (clause?.name) {
      bindings.push({
        imported: null,
        local: clause.name.text,
        kind: "default",
        isTypeOnly: clauseTypeOnly,
      });
    }

    const named = clause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) {
      bindings.push({
        imported: null,
        local: named.name.text,
        kind: "namespace",
        isTypeOnly: clauseTypeOnly,
      });
    } else if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.push({
          imported: (element.propertyName ?? element.name).text,
          local: element.name.text,
          kind: "named",
          isTypeOnly: clauseTypeOnly || element.isTypeOnly,
        });
      }
    }

    addDependency({
      kind: bindings.length === 0 ? "SIDE_EFFECT_IMPORT" : "IMPORT",
      specifier: node.moduleSpecifier.text,
      isTypeOnly:
        clauseTypeOnly ||
        (bindings.length > 0 &&
          bindings.every((binding) => binding.isTypeOnly)),
      moduleSystem: "ESM",
      bindings,
      location: locOf(node),
      scopeKey: scope.symbolKey,
    });
  }

  function visitExportDeclaration(node: ts.ExportDeclaration) {
    sawEsm = true;

    if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.exportClause;

      if (!clause) {
        addDependency({
          kind: "EXPORT_ALL",
          specifier,
          isTypeOnly: node.isTypeOnly,
          moduleSystem: "ESM",
          bindings: [],
          location: locOf(node),
          scopeKey: null,
        });
        return;
      }

      const bindings: DependencyBinding[] = [];

      if (ts.isNamespaceExport(clause)) {
        bindings.push({
          imported: null,
          local: clause.name.text,
          kind: "namespace",
          isTypeOnly: node.isTypeOnly,
        });
      } else {
        for (const element of clause.elements) {
          bindings.push({
            imported: (element.propertyName ?? element.name).text,
            local: element.name.text,
            kind: "named",
            isTypeOnly: node.isTypeOnly || element.isTypeOnly,
          });
        }
      }

      addDependency({
        kind: "RE_EXPORT",
        specifier,
        isTypeOnly: node.isTypeOnly,
        moduleSystem: "ESM",
        bindings,
        location: locOf(node),
        scopeKey: null,
      });
      return;
    }

    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        pendingAliases.push({
          exportName: element.name.text,
          localName: (element.propertyName ?? element.name).text,
          location: locOf(element),
          isTypeOnly: node.isTypeOnly || element.isTypeOnly,
        });
      }
    }
  }

  // ---------- functions and classes ----------

  function visitFunctionLike(
    node: FunctionLikeNode,
    scope: Scope,
    options: FunctionOptions,
    depth: number,
  ) {
    const { details: parameterDetails, names } = describeParameters(
      node.parameters,
    );
    const isArrow = ts.isArrowFunction(node);

    const symbol = createSymbol({
      name: options.name,
      kind: options.kind,
      node,
      scope,
      exportNames: options.exportNames,
      isDefault: options.isDefault,
      details: {
        parameters: parameterDetails,
        parameterNames: names,
        isAsync: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
        isGenerator: node.asteriskToken !== undefined,
        returnType: node.type ? truncate(node.type.getText(sf)) : null,
        typeParameters: typeParameterNames(node.typeParameters),
        lexicallyVisible: options.lexicallyVisible,
        form: isArrow
          ? "arrow"
          : ts.isFunctionExpression(node)
            ? "function-expression"
            : ts.isFunctionDeclaration(node)
              ? "declaration"
              : "method",
        ...(options.details ?? {}),
      },
    });

    if (!symbol) {
      ts.forEachChild(node, (child) => visit(child, scope, depth + 1));
      return;
    }

    for (const name of names) addShadow(symbol.key, name);

    const bodyScope: Scope = {
      symbolKey: symbol.key,
      classKey:
        options.kind === "METHOD"
          ? (options.classKey ?? null)
          : isArrow
            ? scope.classKey
            : null,
    };

    ts.forEachChild(node, (child) => visit(child, bodyScope, depth + 1));
  }

  function visitClass(
    node: ts.ClassDeclaration | ts.ClassExpression,
    scope: Scope,
    options: {
      name: string;
      exportNames?: string[];
      isDefault?: boolean;
      lexicallyVisible: boolean;
      details?: Record<string, unknown>;
    },
    depth: number,
  ) {
    const properties: Array<Record<string, unknown>> = [];
    const heritage: { extends: string[]; implements: string[] } = {
      extends: [],
      implements: [],
    };

    const symbol = createSymbol({
      name: options.name,
      kind: "CLASS",
      node,
      scope,
      exportNames: options.exportNames,
      isDefault: options.isDefault,
      details: {
        isAbstract: hasModifier(node, ts.SyntaxKind.AbstractKeyword),
        typeParameters: typeParameterNames(node.typeParameters),
        properties,
        extends: heritage.extends,
        implements: heritage.implements,
        lexicallyVisible: options.lexicallyVisible,
        ...(options.details ?? {}),
      },
    });

    if (!symbol) {
      ts.forEachChild(node, (child) => visit(child, scope, depth + 1));
      return;
    }

    const classScope: Scope = { symbolKey: symbol.key, classKey: symbol.key };

    for (const parameter of node.typeParameters ?? []) {
      addShadow(symbol.key, parameter.name.text);
      visit(parameter, classScope, depth + 1);
    }

    for (const decorator of ts.getDecorators(node) ?? []) {
      visit(decorator, scope, depth + 1);
    }

    for (const clause of node.heritageClauses ?? []) {
      const kind: RelationKind =
        clause.token === ts.SyntaxKind.ExtendsKeyword
          ? "EXTENDS"
          : "IMPLEMENTS";

      for (const type of clause.types) {
        const targetPath = entityPath(type.expression);
        const targetName = truncate(type.expression.getText(sf));

        heritage[kind === "EXTENDS" ? "extends" : "implements"].push(
          targetName,
        );
        relations.push({
          kind,
          sourceKey: symbol.key,
          scopeKey: scope.symbolKey,
          targetPath,
          targetName,
          location: locOf(type),
        });

        if (!targetPath) visit(type.expression, classScope, depth + 1);
        for (const argument of type.typeArguments ?? []) {
          visit(argument, classScope, depth + 1);
        }
      }
    }

    for (const member of node.members) {
      visitClassMember(member, classScope, symbol, properties, depth + 1);
    }
  }

  function visitClassMember(
    member: ts.ClassElement,
    classScope: Scope,
    classSymbol: SymbolRecord,
    properties: Array<Record<string, unknown>>,
    depth: number,
  ) {
    const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
    const visibility = hasModifier(member, ts.SyntaxKind.PrivateKeyword)
      ? "private"
      : hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
        ? "protected"
        : "public";

    for (const decorator of ts.canHaveDecorators(member)
      ? (ts.getDecorators(member) ?? [])
      : []) {
      visit(decorator, classScope, depth + 1);
    }

    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        if (
          ts.isIdentifier(parameter.name) &&
          parameter.modifiers?.some(
            (m) =>
              m.kind === ts.SyntaxKind.PublicKeyword ||
              m.kind === ts.SyntaxKind.PrivateKeyword ||
              m.kind === ts.SyntaxKind.ProtectedKeyword ||
              m.kind === ts.SyntaxKind.ReadonlyKeyword,
          )
        ) {
          properties.push({
            name: parameter.name.text,
            optional: parameter.questionToken !== undefined,
            static: false,
            readonly: hasModifier(parameter, ts.SyntaxKind.ReadonlyKeyword),
            type: parameter.type ? truncate(parameter.type.getText(sf)) : null,
            parameterProperty: true,
          });
        }
      }

      visitFunctionLike(
        member,
        classScope,
        {
          name: "constructor",
          kind: "METHOD",
          classKey: classSymbol.key,
          lexicallyVisible: false,
          details: { isConstructor: true, visibility },
        },
        depth,
      );
      return;
    }

    if (
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      const { text, computed } = propertyNameText(member.name);
      visitFunctionLike(
        member,
        classScope,
        {
          name: text,
          kind: "METHOD",
          classKey: classSymbol.key,
          lexicallyVisible: false,
          details: {
            static: isStatic,
            visibility,
            isAbstract: hasModifier(member, ts.SyntaxKind.AbstractKeyword),
            computedName: computed,
            accessor: ts.isGetAccessorDeclaration(member)
              ? "get"
              : ts.isSetAccessorDeclaration(member)
                ? "set"
                : null,
          },
        },
        depth,
      );
      return;
    }

    if (ts.isPropertyDeclaration(member)) {
      const { text, computed } = propertyNameText(member.name);
      const initializer = member.initializer
        ? unwrap(member.initializer)
        : null;

      properties.push({
        name: text,
        optional: member.questionToken !== undefined,
        static: isStatic,
        readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
        type: member.type ? truncate(member.type.getText(sf)) : null,
        computedName: computed,
      });

      if (member.type) visit(member.type, classScope, depth + 1);

      if (initializer && isFunctionLikeExpression(initializer)) {
        visitFunctionLike(
          initializer,
          classScope,
          {
            name: text,
            kind: "METHOD",
            classKey: classSymbol.key,
            lexicallyVisible: false,
            details: { static: isStatic, visibility, viaProperty: true },
          },
          depth + 1,
        );
      } else if (member.initializer) {
        visit(member.initializer, classScope, depth + 1);
      }
      return;
    }

    ts.forEachChild(member, (child) => visit(child, classScope, depth + 1));
  }

  function visitInterface(
    node: ts.InterfaceDeclaration,
    scope: Scope,
    depth: number,
  ) {
    const exportInfo = topLevelExport(node);
    const members = node.members.map((member) => {
      const { text } = member.name
        ? propertyNameText(member.name as ts.PropertyName)
        : { text: "" };
      return {
        name: text,
        kind: ts.isPropertySignature(member)
          ? "property"
          : ts.isMethodSignature(member)
            ? "method"
            : ts.isCallSignatureDeclaration(member)
              ? "call"
              : ts.isConstructSignatureDeclaration(member)
                ? "construct"
                : ts.isIndexSignatureDeclaration(member)
                  ? "index"
                  : "other",
        optional:
          (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
          member.questionToken !== undefined,
        readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
      };
    });

    const extendsNames: string[] = [];
    const symbol = createSymbol({
      name: node.name.text,
      kind: "INTERFACE",
      node,
      scope,
      exportNames: exportInfo
        ? exportInfo.isDefault
          ? ["default"]
          : [node.name.text]
        : [],
      isDefault: exportInfo?.isDefault,
      details: {
        members,
        typeParameters: typeParameterNames(node.typeParameters),
        extends: extendsNames,
        lexicallyVisible: true,
      },
    });

    const interfaceScope: Scope = symbol
      ? { symbolKey: symbol.key, classKey: null }
      : scope;

    for (const clause of node.heritageClauses ?? []) {
      for (const type of clause.types) {
        const targetName = truncate(type.expression.getText(sf));
        extendsNames.push(targetName);
        relations.push({
          kind: "EXTENDS",
          sourceKey: symbol?.key ?? null,
          scopeKey: scope.symbolKey,
          targetPath: entityPath(type.expression),
          targetName,
          location: locOf(type),
        });
        for (const argument of type.typeArguments ?? []) {
          visit(argument, interfaceScope, depth + 1);
        }
      }
    }

    for (const parameter of node.typeParameters ?? []) {
      visit(parameter, interfaceScope, depth + 1);
    }
    for (const member of node.members) visit(member, interfaceScope, depth + 1);
  }

  function visitTypeAlias(
    node: ts.TypeAliasDeclaration,
    scope: Scope,
    depth: number,
  ) {
    const exportInfo = topLevelExport(node);
    const typeKind = ts.isUnionTypeNode(node.type)
      ? "union"
      : ts.isIntersectionTypeNode(node.type)
        ? "intersection"
        : ts.isTypeLiteralNode(node.type)
          ? "object"
          : ts.isFunctionTypeNode(node.type)
            ? "function"
            : ts.isConditionalTypeNode(node.type)
              ? "conditional"
              : ts.isMappedTypeNode(node.type)
                ? "mapped"
                : ts.isTypeReferenceNode(node.type)
                  ? "reference"
                  : ts.isArrayTypeNode(node.type)
                    ? "array"
                    : ts.isTupleTypeNode(node.type)
                      ? "tuple"
                      : ts.isLiteralTypeNode(node.type)
                        ? "literal"
                        : "other";

    const symbol = createSymbol({
      name: node.name.text,
      kind: "TYPE",
      node,
      scope,
      exportNames: exportInfo
        ? exportInfo.isDefault
          ? ["default"]
          : [node.name.text]
        : [],
      isDefault: exportInfo?.isDefault,
      details: {
        typeKind,
        typeParameters: typeParameterNames(node.typeParameters),
        declaredType: truncate(node.type.getText(sf)),
        lexicallyVisible: true,
      },
    });

    const typeScope: Scope = symbol
      ? { symbolKey: symbol.key, classKey: null }
      : scope;
    ts.forEachChild(node, (child) => visit(child, typeScope, depth + 1));
  }

  function visitEnum(node: ts.EnumDeclaration, scope: Scope, depth: number) {
    const exportInfo = topLevelExport(node);
    const symbol = createSymbol({
      name: node.name.text,
      kind: "ENUM",
      node,
      scope,
      exportNames: exportInfo
        ? exportInfo.isDefault
          ? ["default"]
          : [node.name.text]
        : [],
      isDefault: exportInfo?.isDefault,
      details: {
        isConst: hasModifier(node, ts.SyntaxKind.ConstKeyword),
        members: node.members.map((member) => ({
          name: propertyNameText(member.name).text,
          hasInitializer: member.initializer !== undefined,
        })),
        lexicallyVisible: true,
      },
    });

    const enumScope: Scope = symbol
      ? { symbolKey: symbol.key, classKey: null }
      : scope;
    for (const member of node.members) {
      if (member.initializer) visit(member.initializer, enumScope, depth + 1);
    }
  }

  // ---------- variables ----------

  function isRequireLikeInitializer(initializer: ts.Expression): boolean {
    const expression = unwrap(initializer);
    const inner = ts.isAwaitExpression(expression)
      ? unwrap(expression.expression)
      : expression;
    const base = ts.isPropertyAccessExpression(inner)
      ? unwrap(inner.expression)
      : inner;
    return isRequireCall(base) || isLiteralDynamicImport(base);
  }

  function visitVariableDeclaration(
    node: ts.VariableDeclaration,
    scope: Scope,
    depth: number,
  ) {
    const list = node.parent;

    if (
      !ts.isVariableDeclarationList(list) ||
      !ts.isVariableStatement(list.parent)
    ) {
      // Loop variables, catch variables: local bindings, not symbols.
      for (const name of bindingNames(node.name))
        addShadow(scope.symbolKey, name);
      ts.forEachChild(node, (child) => visit(child, scope, depth + 1));
      return;
    }

    const statement = list.parent;
    const declarationKind =
      list.flags & ts.NodeFlags.Const
        ? "const"
        : list.flags & ts.NodeFlags.Let
          ? "let"
          : "var";
    const exportInfo = topLevelExport(statement);
    const initializer = node.initializer ? unwrap(node.initializer) : null;

    if (initializer && isRequireLikeInitializer(initializer)) {
      // The bindings are described by the import record, not as symbols.
      ts.forEachChild(node, (child) => visit(child, scope, depth + 1));
      return;
    }

    if (ts.isIdentifier(node.name) && initializer) {
      const exportNames = exportInfo
        ? exportInfo.isDefault
          ? ["default"]
          : [node.name.text]
        : [];

      if (isFunctionLikeExpression(initializer)) {
        if (node.type) visit(node.type, scope, depth + 1);
        visitFunctionLike(
          initializer,
          scope,
          {
            name: node.name.text,
            kind: "FUNCTION",
            exportNames,
            isDefault: exportInfo?.isDefault,
            lexicallyVisible: true,
            details: {
              viaVariable: true,
              declarationKind,
              reassignable: declarationKind !== "const",
            },
          },
          depth + 1,
        );
        return;
      }

      if (ts.isClassExpression(initializer)) {
        visitClass(
          initializer,
          scope,
          {
            name: node.name.text,
            exportNames,
            isDefault: exportInfo?.isDefault,
            lexicallyVisible: true,
            details: { viaVariable: true, declarationKind },
          },
          depth + 1,
        );
        return;
      }
    }

    const names = bindingNames(node.name);
    const destructured = !ts.isIdentifier(node.name);
    const instanceOf =
      initializer && ts.isNewExpression(initializer)
        ? entityPath(initializer.expression)
        : null;

    const created: SymbolRecord[] = [];
    for (const name of names) {
      const symbol = createSymbol({
        name,
        kind: "VARIABLE",
        node: destructured ? node : node,
        scope,
        exportNames: exportInfo ? [name] : [],
        isDefault: false,
        details: {
          declarationKind,
          destructured,
          annotation: node.type ? truncate(node.type.getText(sf)) : null,
          initializerKind: initializer ? ts.SyntaxKind[initializer.kind] : null,
          instanceOf,
          lexicallyVisible: true,
        },
      });
      if (symbol) created.push(symbol);
    }

    const initScope: Scope =
      created.length === 1 && !destructured
        ? { symbolKey: created[0].key, classKey: scope.classKey }
        : scope;

    ts.forEachChild(node, (child) => visit(child, initScope, depth + 1));
  }

  // ---------- CommonJS ----------

  function cjsTarget(
    left: ts.Expression,
  ): { whole: true } | { whole: false; name: string } | null {
    if (!ts.isPropertyAccessExpression(left)) return null;

    const isModuleExports = (node: ts.Expression) =>
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "module" &&
      node.name.text === "exports";

    if (isModuleExports(left)) return { whole: true };

    if (
      (ts.isIdentifier(left.expression) &&
        left.expression.text === "exports") ||
      isModuleExports(left.expression)
    ) {
      return { whole: false, name: left.name.text };
    }

    return null;
  }

  function exportValue(
    value: ts.Expression,
    exportName: string,
    scope: Scope,
    depth: number,
  ) {
    const expression = unwrap(value);

    if (isFunctionLikeExpression(expression)) {
      visitFunctionLike(
        expression,
        scope,
        {
          name: exportName,
          kind: "FUNCTION",
          exportNames: [exportName],
          lexicallyVisible: false,
          details: { viaCommonJs: true },
        },
        depth,
      );
    } else if (ts.isClassExpression(expression)) {
      visitClass(
        expression,
        scope,
        {
          name: exportName,
          exportNames: [exportName],
          lexicallyVisible: false,
          details: { viaCommonJs: true },
        },
        depth,
      );
    } else if (ts.isIdentifier(expression)) {
      pendingAliases.push({
        exportName,
        localName: expression.text,
        location: locOf(expression),
        isTypeOnly: false,
      });
    } else {
      visit(value, scope, depth + 1);
    }
  }

  function visitCommonJsAssignment(
    node: ts.BinaryExpression,
    scope: Scope,
    depth: number,
  ): boolean {
    const target = cjsTarget(node.left);
    if (!target) return false;

    sawCjs = true;

    if (!target.whole) {
      exportValue(node.right, target.name, scope, depth + 1);
      return true;
    }

    const right = unwrap(node.right);

    if (ts.isObjectLiteralExpression(right)) {
      for (const property of right.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          pendingAliases.push({
            exportName: property.name.text,
            localName: property.name.text,
            location: locOf(property),
            isTypeOnly: false,
          });
        } else if (ts.isPropertyAssignment(property)) {
          const { text, computed } = propertyNameText(property.name);
          if (computed) {
            visit(property.initializer, scope, depth + 1);
            continue;
          }
          exportValue(property.initializer, text, scope, depth + 1);
        } else if (ts.isMethodDeclaration(property)) {
          const { text } = propertyNameText(property.name);
          visitFunctionLike(
            property,
            scope,
            {
              name: text,
              kind: "METHOD",
              exportNames: [text],
              lexicallyVisible: false,
              details: { container: "module.exports" },
            },
            depth + 1,
          );
        } else {
          ts.forEachChild(property, (child) => visit(child, scope, depth + 1));
        }
      }
      return true;
    }

    exportValue(node.right, "module.exports", scope, depth + 1);
    return true;
  }

  // ---------- main traversal ----------

  function visit(node: ts.Node, scope: Scope, depth: number): void {
    if (depth > ANALYSIS_LIMITS.MAX_AST_DEPTH) {
      if (!depthReported) {
        depthReported = true;
        diag(
          "WARNING",
          "AST_DEPTH_LIMIT_EXCEEDED",
          `Nesting deeper than ${ANALYSIS_LIMITS.MAX_AST_DEPTH} levels; deeper code was not analysed.`,
          node,
        );
      }
      return;
    }

    if (ts.isImportDeclaration(node)) {
      visitImportDeclaration(node, scope);
      return;
    }

    if (ts.isImportEqualsDeclaration(node)) {
      sawEsm = true;
      if (
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteralLike(node.moduleReference.expression)
      ) {
        addDependency({
          kind: "REQUIRE",
          specifier: node.moduleReference.expression.text,
          isTypeOnly: node.isTypeOnly,
          moduleSystem: "CJS",
          bindings: [
            {
              imported: null,
              local: node.name.text,
              kind: "whole",
              isTypeOnly: node.isTypeOnly,
            },
          ],
          location: locOf(node),
          scopeKey: scope.symbolKey,
        });
      }
      return;
    }

    if (ts.isExportDeclaration(node)) {
      visitExportDeclaration(node);
      return;
    }

    if (ts.isExportAssignment(node)) {
      sawEsm = true;
      const exportName = node.isExportEquals ? "module.exports" : "default";
      const expression = unwrap(node.expression);

      if (isFunctionLikeExpression(expression)) {
        visitFunctionLike(
          expression,
          scope,
          {
            name: exportName === "default" ? "default" : "module.exports",
            kind: "FUNCTION",
            exportNames: [exportName],
            isDefault: !node.isExportEquals,
            lexicallyVisible: false,
          },
          depth + 1,
        );
      } else if (ts.isClassExpression(expression)) {
        visitClass(
          expression,
          scope,
          {
            name: expression.name?.text ?? "default",
            exportNames: [exportName],
            isDefault: !node.isExportEquals,
            lexicallyVisible: false,
          },
          depth + 1,
        );
      } else if (ts.isIdentifier(expression)) {
        pendingAliases.push({
          exportName,
          localName: expression.text,
          location: locOf(node),
          isTypeOnly: false,
        });
      } else {
        diag(
          "INFO",
          "EXPORT_EXPRESSION_NOT_MODELLED",
          `The ${exportName} export is an expression, not a declaration; it is not modelled as a symbol.`,
          node,
        );
        visit(node.expression, scope, depth + 1);
      }
      return;
    }

    if (ts.isFunctionDeclaration(node)) {
      const exportInfo = topLevelExport(node);
      const name = node.name?.text ?? "default";
      if (!node.body) return; // overload signature or ambient declaration
      visitFunctionLike(
        node,
        scope,
        {
          name,
          kind: "FUNCTION",
          exportNames: exportInfo
            ? exportInfo.isDefault
              ? ["default"]
              : [name]
            : [],
          isDefault: exportInfo?.isDefault,
          lexicallyVisible: node.name !== undefined,
          details: node.name ? {} : { anonymous: true },
        },
        depth + 1,
      );
      return;
    }

    if (ts.isClassDeclaration(node)) {
      const exportInfo = topLevelExport(node);
      const name = node.name?.text ?? "default";
      visitClass(
        node,
        scope,
        {
          name,
          exportNames: exportInfo
            ? exportInfo.isDefault
              ? ["default"]
              : [name]
            : [],
          isDefault: exportInfo?.isDefault,
          lexicallyVisible: node.name !== undefined,
          details: node.name ? {} : { anonymous: true },
        },
        depth + 1,
      );
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      visitInterface(node, scope, depth + 1);
      return;
    }

    if (ts.isTypeAliasDeclaration(node)) {
      visitTypeAlias(node, scope, depth + 1);
      return;
    }

    if (ts.isEnumDeclaration(node)) {
      visitEnum(node, scope, depth + 1);
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      visitVariableDeclaration(node, scope, depth + 1);
      return;
    }

    if (ts.isClassExpression(node)) {
      visitClass(
        node,
        scope,
        {
          name: node.name?.text ?? "<anonymous>",
          lexicallyVisible: false,
          details: { anonymous: node.name === undefined },
        },
        depth + 1,
      );
      return;
    }

    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      visitFunctionLike(
        node,
        scope,
        {
          name:
            ts.isFunctionExpression(node) && node.name
              ? node.name.text
              : "<anonymous>",
          kind: "FUNCTION",
          lexicallyVisible: false,
          details: { anonymous: !(ts.isFunctionExpression(node) && node.name) },
        },
        depth + 1,
      );
      return;
    }

    if (
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      // Reached only for object literal members; class members are handled
      // by the class visitor.
      const { text, computed } = propertyNameText(node.name);
      visitFunctionLike(
        node,
        scope,
        {
          name: text,
          kind: "METHOD",
          lexicallyVisible: false,
          details: { container: "object-literal", computedName: computed },
        },
        depth + 1,
      );
      return;
    }

    if (ts.isPropertyAssignment(node)) {
      const initializer = unwrap(node.initializer);
      const { text, computed } = propertyNameText(node.name);
      if (computed) visit(node.name, scope, depth + 1);

      if (isFunctionLikeExpression(initializer)) {
        visitFunctionLike(
          initializer,
          scope,
          {
            name: text,
            kind: "METHOD",
            lexicallyVisible: false,
            details: { container: "object-literal", computedName: computed },
          },
          depth + 1,
        );
      } else {
        visit(node.initializer, scope, depth + 1);
      }
      return;
    }

    if (ts.isTypeParameterDeclaration(node)) {
      addShadow(scope.symbolKey, node.name.text);
      ts.forEachChild(node, (child) => visit(child, scope, depth + 1));
      return;
    }

    if (ts.isTypeReferenceNode(node)) {
      const targetPath = entityPath(node.typeName);
      if (targetPath) {
        relations.push({
          kind: "REFERENCES",
          sourceKey: scope.symbolKey,
          scopeKey: scope.symbolKey,
          targetPath,
          targetName: targetPath.join("."),
          location: locOf(node),
        });
      }
      for (const argument of node.typeArguments ?? [])
        visit(argument, scope, depth + 1);
      return;
    }

    if (ts.isTypeQueryNode(node)) {
      const targetPath = entityPath(node.exprName);
      if (targetPath) {
        relations.push({
          kind: "REFERENCES",
          sourceKey: scope.symbolKey,
          scopeKey: scope.symbolKey,
          targetPath,
          targetName: targetPath.join("."),
          location: locOf(node),
        });
      }
      return;
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      if (visitCommonJsAssignment(node, scope, depth + 1)) return;
    }

    if (ts.isCallExpression(node)) {
      if (isRequireCall(node)) {
        sawCjs = true;
        addDependency({
          kind: "REQUIRE",
          specifier: (node.arguments[0] as ts.StringLiteralLike).text,
          isTypeOnly: false,
          moduleSystem: "CJS",
          bindings: bindingsFromContext(node, "whole"),
          location: locOf(node),
          scopeKey: scope.symbolKey,
        });
        return;
      }

      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length >= 1
      ) {
        diag(
          "INFO",
          "DYNAMIC_REQUIRE",
          "require() with a non-literal argument cannot be resolved statically.",
          node,
        );
        ts.forEachChild(node, (child) => visit(child, scope, depth + 1));
        return;
      }

      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (isLiteralDynamicImport(node)) {
          addDependency({
            kind: "DYNAMIC_IMPORT",
            specifier: (node.arguments[0] as ts.StringLiteralLike).text,
            isTypeOnly: false,
            moduleSystem: "ESM",
            bindings: bindingsFromContext(node, "namespace"),
            location: locOf(node),
            scopeKey: scope.symbolKey,
          });
        } else {
          diag(
            "INFO",
            "DYNAMIC_IMPORT",
            "import() with a non-literal argument cannot be resolved statically.",
            node,
          );
        }
        ts.forEachChild(node, (child) => visit(child, scope, depth + 1));
        return;
      }

      recordCall(node, scope);
    } else if (ts.isNewExpression(node)) {
      recordCall(node, scope);
    }

    ts.forEachChild(node, (child) => visit(child, scope, depth + 1));
  }

  for (const statement of sf.statements) visit(statement, root, 0);

  // ---------- finalisation ----------

  for (const { call, node } of pendingCalls) {
    call.directTargetKey = node ? (nodeKeys.get(node) ?? null) : null;
    calls.push(call);
  }

  const topLevel = symbols.filter(
    (symbol) =>
      symbol.parentKey === null &&
      symbol.kind !== "METHOD" &&
      symbol.details.lexicallyVisible !== false,
  );

  for (const alias of pendingAliases) {
    const targets = topLevel.filter(
      (symbol) => symbol.name === alias.localName,
    );

    if (targets.length > 0) {
      for (const target of targets) addExport(target, alias.exportName);
      continue;
    }

    // `import { a } from "./x"; export { a }` is a re-export.
    const bound = dependencies
      .filter((dep) => dep.scopeKey === null && dep.kind !== "RE_EXPORT")
      .flatMap((dep) =>
        dep.bindings
          .filter((binding) => binding.local === alias.localName)
          .map((binding) => ({ dep, binding })),
      )[0];

    if (bound) {
      dependencies.push({
        kind: "RE_EXPORT",
        specifier: bound.dep.specifier,
        isTypeOnly: alias.isTypeOnly || bound.binding.isTypeOnly,
        moduleSystem: bound.dep.moduleSystem,
        bindings: [
          {
            imported:
              bound.binding.kind === "default"
                ? "default"
                : bound.binding.kind === "namespace" ||
                    bound.binding.kind === "whole"
                  ? null
                  : bound.binding.imported,
            local: alias.exportName,
            kind:
              bound.binding.kind === "whole" ? "namespace" : bound.binding.kind,
            isTypeOnly: alias.isTypeOnly || bound.binding.isTypeOnly,
          },
        ],
        location: alias.location,
        scopeKey: null,
      });
      continue;
    }

    diagnostics.push({
      severity: "WARNING",
      source: "EXTRACTOR",
      code: "EXPORT_TARGET_NOT_FOUND",
      message: `Export "${alias.exportName}" refers to "${alias.localName}", which has no top-level declaration in this file.`,
      path,
      line: alias.location.startLine,
      column: alias.location.startColumn,
      details: null,
    });
  }

  for (const symbol of symbols) symbol.exportNames.sort();

  const moduleSyntax: ModuleSyntax = (() => {
    const declared = getDeclaredModuleSyntax(path);
    if (declared !== "UNKNOWN") return declared;
    if (sawEsm) return "ESM";
    if (sawCjs) return "COMMONJS";
    return "UNKNOWN";
  })();

  const shadowRecord: Record<string, string[]> = {};
  for (const [key, set] of shadows) shadowRecord[key] = [...set].sort();

  return {
    path,
    moduleSyntax,
    symbols,
    dependencies,
    calls,
    relations,
    shadows: shadowRecord,
    diagnostics,
  };
}
