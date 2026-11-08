// features/findings/rules/dependency.ts
//
// Dependency rules. They read only the persisted Sprint 03 dependency
// records; no relationship is inferred here.
import type { DependencyRecord } from "@/features/code-intelligence/contracts";

import type {
  RawEvidence,
  RawFinding,
  RuleContext,
  RuleDefinition,
  RuleEvaluation,
} from "../contracts";

function dependencyEvidence(
  dependency: DependencyRecord,
  message: string,
): RawEvidence {
  return {
    kind: "DEPENDENCY",
    filePath: dependency.sourcePath,
    symbolKey: null,
    location: dependency.location,
    excerpt: null,
    message,
    data: {
      specifier: dependency.specifier,
      dependencyKind: dependency.kind,
      status: dependency.status,
    },
  };
}

/** Occurrence-stable key for an import within its file. */
function importKeys(
  dependencies: readonly DependencyRecord[],
): Map<DependencyRecord, string> {
  const counters = new Map<string, number>();
  const keys = new Map<DependencyRecord, string>();

  for (const dependency of dependencies) {
    const base = `IMPORT:${dependency.kind}:${dependency.specifier}`;
    const bucket = `${dependency.sourcePath}\u0000${base}`;
    const n = counters.get(bucket) ?? 0;
    counters.set(bucket, n + 1);
    keys.set(dependency, `${base}#${n}`);
  }

  return keys;
}

function byStatus(
  context: RuleContext,
  status: DependencyRecord["status"],
  build: (dependency: DependencyRecord, subjectKey: string) => RawFinding,
): RuleEvaluation {
  const keys = importKeys(context.records.dependencies);
  const findings: RawFinding[] = [];

  for (const dependency of context.records.dependencies) {
    if (dependency.status !== status) continue;
    findings.push(build(dependency, keys.get(dependency) as string));
  }

  return { kind: "findings", findings };
}

export const unresolvedImportRule: RuleDefinition = {
  id: "DEP001",
  name: "Unresolved import",
  version: "1.0.0",
  category: "DEPENDENCY",
  severities: ["MEDIUM", "LOW"],
  severityPolicy: "MEDIUM for value imports; LOW for type-only imports.",
  certainties: ["CONFIRMED"],
  scope: "PROJECT",
  requiresCompleteAnalysis: true,
  usesSourceFacts: false,
  thresholdKeys: [],
  description:
    "An import or require whose target could not be resolved to a file of the snapshot or to an external package.",
  evaluation:
    "A dependency record with resolution status UNRESOLVED in a complete analysis of a complete snapshot.",
  evidenceRequirement:
    "The dependency record: source file, specifier and location.",
  recommendation:
    "Check the specifier, the file's existence and any path alias configuration. If the target is generated at build time, this finding can be dismissed with a reason.",
  evaluate(context) {
    return byStatus(context, "UNRESOLVED", (dependency, subjectKey) => ({
      title: `Unresolved import "${dependency.specifier}"`,
      description: `${dependency.sourcePath} imports "${dependency.specifier}", which did not resolve. ${dependency.reason}`,
      severity: dependency.isTypeOnly ? "LOW" : "MEDIUM",
      certainty: "CONFIRMED",
      subjectPath: dependency.sourcePath,
      subjectKey,
      symbolKey: null,
      primaryLine: dependency.location.startLine,
      evidence: [
        dependencyEvidence(
          dependency,
          `Resolution status UNRESOLVED: ${dependency.reason}`,
        ),
      ],
      measurements: null,
    }));
  },
};

export const ambiguousImportRule: RuleDefinition = {
  id: "DEP002",
  name: "Ambiguous import resolution",
  version: "1.0.0",
  category: "DEPENDENCY",
  severities: ["LOW"],
  severityPolicy: "Always LOW.",
  certainties: ["CONFIRMED"],
  scope: "PROJECT",
  requiresCompleteAnalysis: true,
  usesSourceFacts: false,
  thresholdKeys: [],
  description:
    "An import that matched more than one candidate file, so its target cannot be determined statically.",
  evaluation:
    "A dependency record with resolution status AMBIGUOUS in a complete analysis.",
  evidenceRequirement:
    "The dependency record with the candidate files that matched.",
  recommendation:
    "Make the specifier explicit (include the extension or the index file) so exactly one file matches.",
  evaluate(context) {
    return byStatus(context, "AMBIGUOUS", (dependency, subjectKey) => ({
      title: `Ambiguous import "${dependency.specifier}"`,
      description: `${dependency.sourcePath} imports "${dependency.specifier}", which matches ${dependency.candidates.length} candidate files.`,
      severity: "LOW",
      certainty: "CONFIRMED",
      subjectPath: dependency.sourcePath,
      subjectKey,
      symbolKey: null,
      primaryLine: dependency.location.startLine,
      evidence: [
        {
          ...dependencyEvidence(
            dependency,
            `Matched candidates: ${dependency.candidates.slice(0, 5).join(", ")}`,
          ),
        },
      ],
      measurements: { candidates: dependency.candidates.length },
    }));
  },
};

interface Edge {
  from: string;
  to: string;
  dependency: DependencyRecord;
}

/** Iterative Tarjan strongly connected components (no recursion limit). */
export function stronglyConnected(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  for (const root of nodes) {
    if (index.has(root)) continue;

    const work: Array<{ node: string; next: number }> = [
      { node: root, next: 0 },
    ];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const neighbours = adjacency.get(frame.node) ?? [];

      if (frame.next < neighbours.length) {
        const target = neighbours[frame.next];
        frame.next += 1;

        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(
            frame.node,
            Math.min(
              low.get(frame.node) as number,
              index.get(target) as number,
            ),
          );
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];

      if (parent) {
        low.set(
          parent.node,
          Math.min(
            low.get(parent.node) as number,
            low.get(frame.node) as number,
          ),
        );
      }

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop() as string;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        components.push(component);
      }
    }
  }

  return components;
}

export const circularDependencyRule: RuleDefinition = {
  id: "DEP003",
  name: "Circular dependency",
  version: "1.0.0",
  category: "DEPENDENCY",
  severities: ["MEDIUM", "HIGH"],
  severityPolicy:
    "MEDIUM; HIGH when the cycle spans at least `circularHighSize` files.",
  certainties: ["CONFIRMED"],
  scope: "PROJECT",
  requiresCompleteAnalysis: true,
  usesSourceFacts: false,
  thresholdKeys: ["circularHighSize"],
  description:
    "A group of source files that import each other directly or transitively through resolved, load-time imports.",
  evaluation:
    "Strongly connected components of the graph of RESOLVED, analysed, non-type-only, non-dynamic dependencies. Components of two or more files, and files importing themselves, are reported once per component.",
  evidenceRequirement:
    "One CYCLE_EDGE evidence item per import edge inside the cycle (up to the evidence limit).",
  recommendation:
    "Break the cycle by moving shared code to a module both sides import, or by inverting one dependency.",
  evaluate(context) {
    const edges: Edge[] = [];

    for (const dependency of context.records.dependencies) {
      if (
        dependency.status !== "RESOLVED" ||
        !dependency.targetAnalysed ||
        dependency.targetPath === null ||
        dependency.isTypeOnly ||
        dependency.kind === "DYNAMIC_IMPORT"
      ) {
        continue;
      }
      edges.push({
        from: dependency.sourcePath,
        to: dependency.targetPath,
        dependency,
      });
    }

    const nodes = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort();
    const adjacency = new Map<string, string[]>();

    for (const edge of edges) {
      const list = adjacency.get(edge.from) ?? [];
      if (!list.includes(edge.to)) list.push(edge.to);
      adjacency.set(edge.from, list);
    }
    for (const list of adjacency.values()) list.sort();

    const findings: RawFinding[] = [];

    for (const component of stronglyConnected(nodes, adjacency)) {
      const members = new Set(component);
      const sorted = [...component].sort();
      const inside = edges.filter(
        (e) => members.has(e.from) && members.has(e.to),
      );

      if (component.length === 1 && !inside.some((e) => e.from === e.to)) {
        continue;
      }

      const anchor = sorted[0];
      const evidence: RawEvidence[] = inside
        .sort(
          (a, b) =>
            a.from.localeCompare(b.from) ||
            a.dependency.location.startLine - b.dependency.location.startLine,
        )
        .map((edge) =>
          dependencyEvidence(
            edge.dependency,
            `${edge.from} imports ${edge.to}`,
          ),
        )
        .map((item) => ({ ...item, kind: "CYCLE_EDGE" as const }));

      findings.push({
        title:
          sorted.length === 1
            ? `File imports itself: ${anchor}`
            : `Circular dependency between ${sorted.length} files`,
        description: `These files depend on each other: ${sorted.slice(0, 8).join(", ")}${sorted.length > 8 ? ", …" : ""}.`,
        severity:
          sorted.length >= context.thresholds.circularHighSize
            ? "HIGH"
            : "MEDIUM",
        certainty: "CONFIRMED",
        subjectPath: anchor,
        subjectKey: "CYCLE",
        symbolKey: null,
        primaryLine: evidence[0]?.location?.startLine ?? null,
        evidence,
        measurements: {
          files: sorted.length,
          edges: inside.length,
          threshold: context.thresholds.circularHighSize,
        },
      });
    }

    return { kind: "findings", findings };
  },
};

export const unusedExportRule: RuleDefinition = {
  id: "DEP004",
  name: "Possibly unused export",
  version: "1.0.0",
  category: "DEPENDENCY",
  severities: ["INFO"],
  severityPolicy: "Always INFO.",
  certainties: ["INDICATOR"],
  scope: "PROJECT",
  requiresCompleteAnalysis: true,
  usesSourceFacts: false,
  thresholdKeys: [],
  description:
    "A named export that no resolved import in the analysed snapshot refers to. It may still be used by code outside the snapshot, by a framework convention, or through a public package entry point.",
  evaluation:
    "Only for files imported by at least one other analysed file, and only when every importer names what it imports. A file is skipped when any importer uses a namespace, whole-module, CommonJS, dynamic or export-all form, because the used names cannot then be determined. Reported as an indicator, never as dead code.",
  evidenceRequirement:
    "A SYMBOL evidence item for the export and the number of importing files.",
  recommendation:
    "Check whether the export is part of a public API or a framework convention. If it is not, remove it or make it module-private.",
  evaluate(context) {
    const importers = new Map<string, DependencyRecord[]>();

    for (const dependency of context.records.dependencies) {
      if (
        dependency.status !== "RESOLVED" ||
        !dependency.targetAnalysed ||
        dependency.targetPath === null
      ) {
        continue;
      }
      const list = importers.get(dependency.targetPath) ?? [];
      list.push(dependency);
      importers.set(dependency.targetPath, list);
    }

    const findings: RawFinding[] = [];
    const counters = new Map<string, number>();

    for (const symbol of context.records.symbols) {
      if (!symbol.isExported || symbol.exportNames.length === 0) continue;

      const incoming = importers.get(symbol.filePath);
      if (!incoming || incoming.length === 0) continue;

      // Any importer whose used names are not explicit makes the file
      // unjudgeable.
      const opaque = incoming.some(
        (dependency) =>
          dependency.kind === "DYNAMIC_IMPORT" ||
          dependency.kind === "REQUIRE" ||
          dependency.kind === "EXPORT_ALL" ||
          dependency.kind === "SIDE_EFFECT_IMPORT" ||
          dependency.bindings.length === 0 ||
          dependency.bindings.some(
            (binding) =>
              binding.kind === "namespace" || binding.kind === "whole",
          ),
      );
      if (opaque) continue;

      const names = symbol.exportNames.filter(
        (name) => name !== "module.exports",
      );
      if (names.length === 0) continue;

      const used = incoming.some((dependency) =>
        dependency.bindings.some((binding) =>
          binding.kind === "default"
            ? names.includes("default")
            : binding.imported !== null && names.includes(binding.imported),
        ),
      );
      if (used) continue;

      const base = `UNUSED_EXPORT:${symbol.qualifiedName}`;
      const n = counters.get(`${symbol.filePath}\u0000${base}`) ?? 0;
      counters.set(`${symbol.filePath}\u0000${base}`, n + 1);

      findings.push({
        title: `Export "${symbol.name}" is not imported anywhere`,
        description: `${symbol.filePath} exports "${symbol.name}", but none of the ${incoming.length} file(s) importing this module use it. It may still be used outside this snapshot.`,
        severity: "INFO",
        certainty: "INDICATOR",
        subjectPath: symbol.filePath,
        subjectKey: `${base}#${n}`,
        symbolKey: symbol.key,
        primaryLine: symbol.location.startLine,
        evidence: [
          {
            kind: "SYMBOL",
            filePath: symbol.filePath,
            symbolKey: symbol.key,
            location: symbol.location,
            excerpt: null,
            message: `Exported as ${names.join(", ")}; ${incoming.length} importing file(s) reference other names.`,
            data: { importers: incoming.length },
          },
        ],
        measurements: { importers: incoming.length },
      });
    }

    return { kind: "findings", findings };
  },
};

export const dependencyRules: RuleDefinition[] = [
  unresolvedImportRule,
  ambiguousImportRule,
  circularDependencyRule,
  unusedExportRule,
];
