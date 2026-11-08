// features/findings/rules/structure.ts
//
// Structure rules. Structural duplication is reported as an INDICATOR: two
// functions with the same syntax shape may be intentional.
import type { FunctionSubject } from "./helpers";
import {
  factsInOrder,
  functionSubjects,
  locationOf,
  missingFactsLimitation,
  noFactsAvailable,
} from "./helpers";
import type { RawFinding, RuleDefinition } from "../contracts";

export const duplicateStructureRule: RuleDefinition = {
  id: "STR001",
  name: "Structurally duplicated functions",
  version: "1.0.0",
  category: "STRUCTURE",
  severities: ["LOW"],
  severityPolicy: "Always LOW.",
  certainties: ["INDICATOR"],
  scope: "PROJECT",
  requiresCompleteAnalysis: false,
  usesSourceFacts: true,
  thresholdKeys: ["duplicateMinGroupSize", "duplicateMinNodes"],
  description:
    "Several functions with an identical syntax structure (identifier and literal values ignored), which often indicates copy-and-paste code.",
  evaluation:
    "Functions with at least `duplicateMinNodes` syntax nodes are grouped by a hash of their syntax-kind sequence; groups of at least `duplicateMinGroupSize` functions are reported once per group. Reported as an indicator: identical structure does not prove duplication.",
  evidenceRequirement:
    "A SOURCE_LOCATION evidence item for each function in the group (up to the evidence limit).",
  recommendation:
    "Review the functions and extract the shared logic into one parameterised function if they are genuine duplicates.",
  evaluate(context) {
    const unavailable = noFactsAvailable(context);
    if (unavailable) return unavailable;

    const groups = new Map<string, FunctionSubject[]>();

    for (const subject of functionSubjects(context)) {
      const { structureHash, nodeCount } = subject.fn;
      if (
        structureHash === null ||
        nodeCount < context.thresholds.duplicateMinNodes
      ) {
        continue;
      }
      const list = groups.get(structureHash) ?? [];
      list.push(subject);
      groups.set(structureHash, list);
    }

    const findings: RawFinding[] = [];

    for (const [hash, members] of [...groups.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      if (members.length < context.thresholds.duplicateMinGroupSize) continue;

      const sorted = [...members].sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          a.fn.location.startLine - b.fn.location.startLine,
      );
      const anchor = sorted[0];

      findings.push({
        title: `${sorted.length} functions share the same structure`,
        description: `${sorted.length} functions have an identical syntax structure (${anchor.fn.nodeCount} syntax nodes each), starting with ${anchor.name} in ${anchor.path}. This is an indicator of possible duplication, not proof.`,
        severity: "LOW",
        certainty: "INDICATOR",
        subjectPath: anchor.path,
        subjectKey: `DUPLICATE_STRUCTURE:${hash.slice(0, 16)}`,
        symbolKey: anchor.fn.symbolKey,
        primaryLine: anchor.fn.location.startLine,
        evidence: sorted.map((member) => ({
          kind: "SOURCE_LOCATION" as const,
          filePath: member.path,
          symbolKey: member.fn.symbolKey,
          location: member.fn.location,
          excerpt: null,
          message: `${member.name} has the shared structure.`,
          data: { nodes: member.fn.nodeCount },
        })),
        measurements: {
          functions: sorted.length,
          nodes: anchor.fn.nodeCount,
          threshold: context.thresholds.duplicateMinGroupSize,
        },
      });
    }

    return {
      kind: "findings",
      findings,
      limitations: missingFactsLimitation(context),
    };
  },
};

export const emptyModuleRule: RuleDefinition = {
  id: "STR002",
  name: "Module without statements",
  version: "1.0.0",
  category: "STRUCTURE",
  severities: ["INFO"],
  severityPolicy: "Always INFO.",
  certainties: ["CONFIRMED"],
  scope: "FILE",
  requiresCompleteAnalysis: false,
  usesSourceFacts: true,
  thresholdKeys: [],
  description:
    "A source file that parses without errors but contains no statements (only whitespace or comments).",
  evaluation:
    "Top-level statement count is zero and the file has no syntax errors.",
  evidenceRequirement: "A SOURCE_LOCATION evidence item for the file.",
  recommendation:
    "Remove the file if it is unused, or add the intended content. Empty placeholder files are sometimes deliberate.",
  evaluate(context) {
    const unavailable = noFactsAvailable(context);
    if (unavailable) return unavailable;

    const findings: RawFinding[] = [];

    for (const file of factsInOrder(context)) {
      if (file.statementCount !== 0 || file.syntaxErrorCount !== 0) continue;

      findings.push({
        title: `${file.path} contains no statements`,
        description: `${file.path} has no code, only whitespace or comments.`,
        severity: "INFO",
        certainty: "CONFIRMED",
        subjectPath: file.path,
        subjectKey: "EMPTY_MODULE",
        symbolKey: null,
        primaryLine: 1,
        evidence: [
          {
            kind: "SOURCE_LOCATION",
            filePath: file.path,
            symbolKey: null,
            location: locationOf(1, Math.max(1, file.lineCount)),
            excerpt: null,
            message: "The file has zero top-level statements.",
            data: { statements: 0 },
          },
        ],
        measurements: { statements: 0 },
      });
    }

    return {
      kind: "findings",
      findings,
      limitations: missingFactsLimitation(context),
    };
  },
};

export const structureRules: RuleDefinition[] = [
  duplicateStructureRule,
  emptyModuleRule,
];
