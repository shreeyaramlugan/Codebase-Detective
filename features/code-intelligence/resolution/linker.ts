// features/code-intelligence/resolution/linker.ts
//
// Links raw call/relationship evidence to target symbols.
//
// A target is attached ONLY when static evidence supports it:
//   CONFIRMED  - one specific symbol, reached through lexical scope, a resolved
//                import/require, a class static, super or an immediately
//                invoked function.
//   POSSIBLE   - a plausible target exists but runtime behaviour could differ
//                (this.method() dispatch, instances of a class, reassignable
//                function variables, several same-named declarations,
//                .call/.apply, default-import interop).
//   UNRESOLVED - no target can be established. The call is still kept as
//                evidence; no target is invented.
import type {
  CallRecord,
  CallResolution,
  DependencyBinding,
  DependencyRecord,
  DiagnosticRecord,
  RelationRecord,
  ResolutionStatus,
  SymbolKind,
  SymbolRecord,
} from "../contracts";
import type {
  ExtractedFile,
  RawCall,
  RawRelation,
} from "../extraction/extract-file";
import type { SymbolRegistry } from "../registry/symbol-registry";

export interface LinkInput {
  files: readonly ExtractedFile[];
  /** Resolved dependency records, aligned per file with the extractor output. */
  dependencies: ReadonlyMap<string, readonly DependencyRecord[]>;
  registry: SymbolRegistry;
}

export interface LinkOutput {
  calls: CallRecord[];
  relations: RelationRecord[];
  droppedUnresolvedReferences: number;
  diagnostics: DiagnosticRecord[];
}

type Space = "value" | "type";

type Outcome =
  | {
      ok: true;
      symbols: SymbolRecord[];
      possible: boolean;
      note: string | null;
    }
  | { ok: false; status: ResolutionStatus; reason: string };

type ExportLookup =
  | { kind: "symbols"; symbols: SymbolRecord[]; possible: boolean }
  | { kind: "module"; targetPath: string }
  | { kind: "fail"; reason: string };

type Lookup =
  | { type: "symbols"; symbols: SymbolRecord[] }
  | { type: "binding"; dep: DependencyRecord; binding: DependencyBinding }
  | { type: "shadowed" }
  | { type: "none" };

const VALUE_KINDS: ReadonlySet<SymbolKind> = new Set([
  "FUNCTION",
  "CLASS",
  "VARIABLE",
  "ENUM",
]);
const TYPE_KINDS: ReadonlySet<SymbolKind> = new Set([
  "CLASS",
  "INTERFACE",
  "TYPE",
  "ENUM",
]);
const CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set([
  "FUNCTION",
  "CLASS",
  "METHOD",
]);

function rangeKey(location: {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}): string {
  return `${location.startLine}:${location.startColumn}-${location.endLine}:${location.endColumn}`;
}

export function linkCallsAndRelations(input: LinkInput): LinkOutput {
  const { registry } = input;
  const diagnostics: DiagnosticRecord[] = [];

  // ---------- indexes ----------

  const fileByPath = new Map(input.files.map((file) => [file.path, file]));

  const exportsByFile = new Map<string, Map<string, SymbolRecord[]>>();
  for (const symbol of registry.all()) {
    let table = exportsByFile.get(symbol.filePath);
    if (!table) {
      table = new Map();
      exportsByFile.set(symbol.filePath, table);
    }
    for (const name of symbol.exportNames) {
      const list = table.get(name);
      if (list) list.push(symbol);
      else table.set(name, [symbol]);
    }
  }

  const reexportsByFile = new Map<string, DependencyRecord[]>();
  const bindingScopes = new Map<
    string,
    Map<
      string,
      Map<string, { dep: DependencyRecord; binding: DependencyBinding }>
    >
  >();

  for (const [path, deps] of input.dependencies) {
    const raws = fileByPath.get(path)?.dependencies ?? [];

    deps.forEach((dep, index) => {
      if (dep.kind === "RE_EXPORT" || dep.kind === "EXPORT_ALL") {
        const list = reexportsByFile.get(path);
        if (list) list.push(dep);
        else reexportsByFile.set(path, [dep]);
        return;
      }

      const scopeKey = raws[index]?.scopeKey ?? null;
      let scopes = bindingScopes.get(path);
      if (!scopes) {
        scopes = new Map();
        bindingScopes.set(path, scopes);
      }
      let table = scopes.get(scopeKey ?? "");
      if (!table) {
        table = new Map();
        scopes.set(scopeKey ?? "", table);
      }

      for (const binding of dep.bindings) {
        if (binding.local && !table.has(binding.local)) {
          table.set(binding.local, { dep, binding });
        }
      }
    });
  }

  // ---------- lexical lookup ----------

  function lookupName(
    path: string,
    scopeKey: string | null,
    name: string,
    space: Space,
  ): Lookup {
    const kinds = space === "value" ? VALUE_KINDS : TYPE_KINDS;
    const extracted = fileByPath.get(path);
    let current: string | null = scopeKey;

    while (true) {
      const bound = bindingScopes
        .get(path)
        ?.get(current ?? "")
        ?.get(name);
      if (bound) return { type: "binding", ...bound };

      const matches = registry
        .getChildren(current, path)
        .filter(
          (symbol) =>
            symbol.name === name &&
            kinds.has(symbol.kind) &&
            symbol.details.lexicallyVisible !== false,
        );
      if (matches.length > 0) return { type: "symbols", symbols: [...matches] };

      if (extracted?.shadows[current ?? ""]?.includes(name)) {
        return { type: "shadowed" };
      }

      if (current === null) return { type: "none" };
      current = registry.getByKey(current)?.parentKey ?? null;
    }
  }

  // ---------- exports ----------

  function lookupExport(
    targetPath: string,
    name: string,
    visited: Set<string> = new Set(),
  ): ExportLookup {
    const guard = `${targetPath}::${name}`;
    if (visited.has(guard)) {
      return {
        kind: "fail",
        reason: `Circular re-export of "${name}" in ${targetPath}.`,
      };
    }
    visited.add(guard);

    const direct = exportsByFile.get(targetPath)?.get(name);
    if (direct && direct.length > 0) {
      return { kind: "symbols", symbols: [...direct], possible: false };
    }

    const reexports = reexportsByFile.get(targetPath) ?? [];

    for (const dep of reexports) {
      if (dep.kind !== "RE_EXPORT") continue;
      const binding = dep.bindings.find(
        (candidate) => candidate.local === name,
      );
      if (!binding) continue;

      if (dep.status !== "RESOLVED" || !dep.targetAnalysed || !dep.targetPath) {
        return {
          kind: "fail",
          reason: `"${name}" is re-exported from "${dep.specifier}", which could not be resolved to an analysed file.`,
        };
      }

      if (binding.kind === "namespace") {
        return { kind: "module", targetPath: dep.targetPath };
      }

      return lookupExport(
        dep.targetPath,
        binding.kind === "default" ? "default" : (binding.imported ?? name),
        visited,
      );
    }

    if (name !== "default") {
      const found: ExportLookup[] = [];

      for (const dep of reexports) {
        if (dep.kind !== "EXPORT_ALL") continue;
        if (dep.status !== "RESOLVED" || !dep.targetAnalysed || !dep.targetPath)
          continue;
        const result = lookupExport(dep.targetPath, name, new Set(visited));
        if (result.kind !== "fail") found.push(result);
      }

      if (found.length === 1) return found[0];
      if (found.length > 1) {
        const keys = new Set(
          found.flatMap((entry) =>
            entry.kind === "symbols" ? entry.symbols.map((s) => s.key) : [],
          ),
        );
        if (
          keys.size <= 1 &&
          found.every((entry) => entry.kind === "symbols")
        ) {
          return found[0];
        }
        return {
          kind: "fail",
          reason: `"${name}" is exported by more than one "export *" source in ${targetPath}.`,
        };
      }
    }

    return {
      kind: "fail",
      reason: `${targetPath} does not statically export "${name}".`,
    };
  }

  function fromBinding(
    dep: DependencyRecord,
    binding: DependencyBinding,
    asCallee: boolean,
  ): ExportLookup {
    if (dep.status === "EXTERNAL") {
      return {
        kind: "fail",
        reason: `Imported from the external package "${dep.externalPackage}", whose source is not part of the snapshot.`,
      };
    }
    if (dep.status === "AMBIGUOUS") {
      return {
        kind: "fail",
        reason: `The import of "${dep.specifier}" is ambiguous (${dep.candidates.join(", ")}).`,
      };
    }
    if (dep.status === "UNRESOLVED") {
      return {
        kind: "fail",
        reason: `The import of "${dep.specifier}" is unresolved.`,
      };
    }
    if (!dep.targetPath || !dep.targetAnalysed) {
      return {
        kind: "fail",
        reason: `The import of "${dep.specifier}" does not point at an analysed source file.`,
      };
    }

    if (binding.kind === "namespace") {
      return { kind: "module", targetPath: dep.targetPath };
    }

    if (binding.kind === "whole") {
      if (asCallee) {
        const whole = lookupExport(dep.targetPath, "module.exports");
        return whole.kind === "fail"
          ? {
              kind: "fail",
              reason: `${dep.targetPath} does not statically assign module.exports.`,
            }
          : whole;
      }
      return { kind: "module", targetPath: dep.targetPath };
    }

    if (binding.kind === "default") {
      const direct = lookupExport(dep.targetPath, "default");
      if (direct.kind !== "fail") return direct;

      // CommonJS interop: a default import of a CommonJS module is its
      // module.exports. Plausible, but not certain.
      const interop = lookupExport(dep.targetPath, "module.exports");
      return interop.kind === "symbols"
        ? { ...interop, possible: true }
        : direct;
    }

    return lookupExport(dep.targetPath, binding.imported ?? "");
  }

  // ---------- class helpers ----------

  const parentClassOf = new Map<string, SymbolRecord[]>();

  function findMember(
    classSymbol: SymbolRecord,
    name: string,
    seen: Set<string> = new Set(),
  ): SymbolRecord[] {
    if (seen.has(classSymbol.key)) return [];
    seen.add(classSymbol.key);

    const own = registry
      .getChildren(classSymbol.key, classSymbol.filePath)
      .filter(
        (member) =>
          member.kind === "METHOD" &&
          member.name === name &&
          member.details.isConstructor !== true,
      );
    if (own.length > 0) return [...own];

    for (const parent of parentClassOf.get(classSymbol.key) ?? []) {
      const inherited = findMember(parent, name, seen);
      if (inherited.length > 0) return inherited;
    }
    return [];
  }

  // ---------- entity resolution ----------

  function resolveEntity(
    path: string,
    scopeKey: string | null,
    names: readonly string[],
    space: Space,
    asCallee = false,
  ): Outcome {
    const [first, ...rest] = names;
    const lookup = lookupName(path, scopeKey, first, space);

    let entity: ExportLookup;
    let possible = false;

    if (lookup.type === "none") {
      return {
        ok: false,
        status: "UNRESOLVED",
        reason: `"${first}" is not declared in this file (it may be a global or undeclared).`,
      };
    }

    if (lookup.type === "shadowed") {
      return {
        ok: false,
        status: "UNRESOLVED",
        reason: `"${first}" is a local binding (parameter, loop or catch variable); its value is not statically known.`,
      };
    }

    if (lookup.type === "binding") {
      entity = fromBinding(
        lookup.dep,
        lookup.binding,
        asCallee && rest.length === 0,
      );
      if (entity.kind === "fail") {
        const status: ResolutionStatus =
          lookup.dep.status === "EXTERNAL"
            ? "EXTERNAL"
            : lookup.dep.status === "AMBIGUOUS"
              ? "AMBIGUOUS"
              : "UNRESOLVED";
        return { ok: false, status, reason: entity.reason };
      }
    } else {
      entity = { kind: "symbols", symbols: lookup.symbols, possible: false };
    }

    let note: string | null = null;

    for (let index = 0; index < rest.length; index += 1) {
      const name = rest[index];

      if (entity.kind === "module") {
        entity = lookupExport(entity.targetPath, name);
        if (entity.kind === "fail") {
          return { ok: false, status: "UNRESOLVED", reason: entity.reason };
        }
        continue;
      }

      if (entity.symbols.length !== 1) {
        return {
          ok: false,
          status: "AMBIGUOUS",
          reason: `"${names.slice(0, index + 1).join(".")}" has several possible declarations.`,
        };
      }

      const owner = entity.symbols[0];
      possible = possible || entity.possible;
      let classSymbol: SymbolRecord | null = null;
      let viaInstance = false;

      if (owner.kind === "CLASS") {
        classSymbol = owner;
      } else if (
        owner.kind === "VARIABLE" &&
        Array.isArray(owner.details.instanceOf)
      ) {
        const instance = resolveEntity(
          owner.filePath,
          owner.parentKey,
          owner.details.instanceOf as string[],
          "value",
        );
        if (
          instance.ok &&
          instance.symbols.length === 1 &&
          instance.symbols[0].kind === "CLASS"
        ) {
          classSymbol = instance.symbols[0];
          viaInstance = true;
          note = `"${owner.name}" was created with new ${(owner.details.instanceOf as string[]).join(".")}; it could be reassigned or be a subclass instance.`;
        }
      }

      if (!classSymbol) {
        return {
          ok: false,
          status: "UNRESOLVED",
          reason: `The type of "${names.slice(0, index + 1).join(".")}" cannot be determined statically.`,
        };
      }

      const members = findMember(classSymbol, name);
      const eligible = viaInstance
        ? members.filter((member) => member.details.static !== true)
        : members.filter((member) => member.details.static === true);

      if (eligible.length === 0) {
        return {
          ok: false,
          status: "UNRESOLVED",
          reason: viaInstance
            ? `Class "${classSymbol.name}" has no statically declared instance member "${name}".`
            : `Class "${classSymbol.name}" has no statically declared static member "${name}".`,
        };
      }

      entity = { kind: "symbols", symbols: eligible, possible: viaInstance };
    }

    if (entity.kind === "module") {
      return {
        ok: false,
        status: "UNRESOLVED",
        reason: `"${names.join(".")}" refers to a module namespace, not a symbol.`,
      };
    }
    return {
      ok: true,
      symbols: entity.symbols,
      possible: possible || entity.possible,
      note,
    };
  }

  // ---------- relations ----------

  const relations: RelationRecord[] = [];
  let droppedUnresolvedReferences = 0;

  function linkRelation(file: ExtractedFile, raw: RawRelation) {
    let status: ResolutionStatus;
    let targetKey: string | null = null;
    let reason: string;

    if (!raw.targetPath) {
      status = "UNRESOLVED";
      reason =
        "The heritage expression is not a plain name, so its target is not resolved.";
    } else {
      const outcome = resolveEntity(
        file.path,
        raw.scopeKey,
        raw.targetPath,
        "type",
      );

      if (!outcome.ok) {
        status = outcome.status;
        reason = outcome.reason;
      } else if (outcome.symbols.length === 1) {
        status = "RESOLVED";
        targetKey = outcome.symbols[0].key;
        reason = `Resolved to ${outcome.symbols[0].qualifiedName}.`;
      } else {
        status = "AMBIGUOUS";
        reason = `${outcome.symbols.length} declarations match "${raw.targetName}".`;
      }
    }

    if (raw.kind === "REFERENCES") {
      if (status !== "RESOLVED" || targetKey === raw.sourceKey) {
        droppedUnresolvedReferences += status === "RESOLVED" ? 0 : 1;
        return;
      }
    }

    relations.push({
      key: `${raw.kind}|${file.path}|${rangeKey(raw.location)}|${raw.targetName}`,
      kind: raw.kind,
      sourcePath: file.path,
      sourceKey: raw.sourceKey,
      targetName: raw.targetName,
      targetKey,
      status,
      reason,
      location: raw.location,
    });

    if (
      raw.kind === "EXTENDS" &&
      status === "RESOLVED" &&
      targetKey &&
      raw.sourceKey
    ) {
      const source = registry.getByKey(raw.sourceKey);
      const target = registry.getByKey(targetKey);
      if (source?.kind === "CLASS" && target?.kind === "CLASS") {
        const list = parentClassOf.get(source.key);
        if (list) list.push(target);
        else parentClassOf.set(source.key, [target]);
      }
    }
  }

  // Heritage first: super/this resolution depends on it. Within a file the
  // original traversal order is kept, so the output is deterministic.
  for (const file of input.files) {
    for (const raw of file.relations) {
      if (raw.kind !== "REFERENCES") linkRelation(file, raw);
    }
  }
  for (const file of input.files) {
    for (const raw of file.relations) {
      if (raw.kind === "REFERENCES") linkRelation(file, raw);
    }
  }

  // ---------- calls ----------

  const calls: CallRecord[] = [];

  function pushCall(
    file: ExtractedFile,
    raw: RawCall,
    resolution: CallResolution,
    target: SymbolRecord | null,
    reason: string,
  ) {
    calls.push({
      key: `${file.path}|${rangeKey(raw.location)}|${raw.kind}|${target?.key ?? "-"}`,
      sourcePath: file.path,
      callerKey: raw.callerKey,
      kind: raw.kind,
      calleeText: raw.calleeText,
      optional: raw.optional,
      resolution,
      targetKey: target?.key ?? null,
      reason,
      location: raw.location,
    });
  }

  function fromOutcome(
    file: ExtractedFile,
    raw: RawCall,
    outcome: Outcome,
    options: { forcePossible?: string } = {},
  ) {
    if (!outcome.ok) {
      pushCall(file, raw, "UNRESOLVED", null, outcome.reason);
      return;
    }

    const callable = outcome.symbols.filter((symbol) =>
      CALLABLE_KINDS.has(symbol.kind),
    );

    if (callable.length === 0) {
      pushCall(
        file,
        raw,
        "UNRESOLVED",
        null,
        `"${raw.calleeText}" refers to a ${outcome.symbols[0]?.kind.toLowerCase() ?? "value"}, not a statically known function or class.`,
      );
      return;
    }

    if (
      raw.kind === "NEW" &&
      callable.every((symbol) => symbol.kind === "METHOD")
    ) {
      pushCall(
        file,
        raw,
        "UNRESOLVED",
        null,
        "new was applied to a method, which is not a constructor.",
      );
      return;
    }

    const reasons: string[] = [];
    if (callable.length > 1) {
      reasons.push(`${callable.length} declarations share this name.`);
    }
    if (outcome.possible) {
      reasons.push(
        outcome.note ??
          "The target depends on runtime behaviour (dispatch or module interop).",
      );
    }
    if (callable.some((symbol) => symbol.details.reassignable === true)) {
      reasons.push(
        "The function is held in a let/var binding that may be reassigned.",
      );
    }
    if (options.forcePossible) reasons.push(options.forcePossible);

    const certain = reasons.length === 0;

    for (const symbol of callable) {
      pushCall(
        file,
        raw,
        certain ? "CONFIRMED" : "POSSIBLE",
        symbol,
        certain ? `Resolved to ${symbol.qualifiedName}.` : reasons.join(" "),
      );
    }
  }

  function linkCall(file: ExtractedFile, raw: RawCall) {
    const { shape } = raw;

    switch (shape.type) {
      case "dynamic":
        pushCall(
          file,
          raw,
          "UNRESOLVED",
          null,
          `Dynamic call: ${shape.reason}.`,
        );
        return;

      case "direct": {
        const target = raw.directTargetKey
          ? registry.getByKey(raw.directTargetKey)
          : undefined;
        if (target)
          pushCall(
            file,
            raw,
            "CONFIRMED",
            target,
            "Immediately invoked function expression.",
          );
        else
          pushCall(
            file,
            raw,
            "UNRESOLVED",
            null,
            "The invoked function expression was not recorded.",
          );
        return;
      }

      case "super-constructor": {
        const parents = raw.classKey
          ? (parentClassOf.get(raw.classKey) ?? [])
          : [];
        if (parents.length === 1) {
          pushCall(
            file,
            raw,
            "CONFIRMED",
            parents[0],
            `Calls the constructor of ${parents[0].qualifiedName}.`,
          );
        } else {
          pushCall(
            file,
            raw,
            "UNRESOLVED",
            null,
            "The parent class could not be resolved.",
          );
        }
        return;
      }

      case "identifier":
        fromOutcome(
          file,
          raw,
          resolveEntity(file.path, raw.callerKey, [shape.name], "value", true),
        );
        return;

      case "member": {
        const note = shape.invoker
          ? `Invoked through .${shape.invoker}(); the receiver may change behaviour.`
          : undefined;

        if (shape.base === "identifier" && shape.baseName) {
          const names = [shape.baseName, ...shape.path];
          let outcome = resolveEntity(file.path, raw.callerKey, names, "value");

          if (
            shape.invoker &&
            outcome.ok &&
            !outcome.symbols.every(
              (s) => s.kind === "FUNCTION" || s.kind === "METHOD",
            )
          ) {
            // e.g. a class with a static member that is literally named `call`.
            outcome = resolveEntity(
              file.path,
              raw.callerKey,
              [...names, shape.invoker],
              "value",
            );
            fromOutcome(file, raw, outcome);
            return;
          }

          fromOutcome(file, raw, outcome, { forcePossible: note });
          return;
        }

        const classSymbol = raw.classKey
          ? registry.getByKey(raw.classKey)
          : undefined;

        if (!classSymbol || shape.path.length !== 1) {
          pushCall(
            file,
            raw,
            "UNRESOLVED",
            null,
            shape.base === "this"
              ? "The receiver is a property of `this`, whose type is not statically known."
              : "The super call is outside a class or has an unsupported shape.",
          );
          return;
        }

        const name = shape.path[0];

        if (shape.base === "super") {
          const parents = parentClassOf.get(classSymbol.key) ?? [];
          const members =
            parents.length === 1 ? findMember(parents[0], name) : [];
          if (members.length > 0) {
            fromOutcome(
              file,
              raw,
              { ok: true, symbols: members, possible: false, note: null },
              { forcePossible: note },
            );
          } else {
            pushCall(
              file,
              raw,
              "UNRESOLVED",
              null,
              `super.${name} could not be found in a resolved parent class.`,
            );
          }
          return;
        }

        const members = findMember(classSymbol, name);
        if (members.length > 0) {
          fromOutcome(
            file,
            raw,
            {
              ok: true,
              symbols: members,
              possible: true,
              note: "this.method() is dispatched at runtime; a subclass may override it.",
            },
            { forcePossible: note },
          );
        } else {
          pushCall(
            file,
            raw,
            "UNRESOLVED",
            null,
            `No method "${name}" is declared on ${classSymbol.name} or its resolved parents.`,
          );
        }
      }
    }
  }

  for (const file of input.files) {
    for (const raw of file.calls) linkCall(file, raw);
  }

  return { calls, relations, droppedUnresolvedReferences, diagnostics };
}
