// features/findings/rules/complexity.ts
//
// Complexity rules. Every finding states the measured value and the threshold
// it exceeded, so the result is reproducible and explainable. Metrics come
// from the syntax-only source facts (or, for module size, the analysis file
// record); thresholds are explicit run configuration.
import type {
  FindingSeverity,
  RawFinding,
  RuleDefinition,
  RuleContext,
  RuleEvaluation,
  Thresholds,
} from "../contracts";
import {
  functionSubjects,
  locationOf,
  missingFactsLimitation,
  noFactsAvailable,
  type FunctionSubject,
} from "./helpers";

type Metric = {
  measure: (subject: FunctionSubject) => number;
  label: string;
  unit: string;
  severity: (value: number, thresholds: Thresholds) => FindingSeverity | null;
  threshold: (severity: FindingSeverity, thresholds: Thresholds) => number;
};

function functionRule(
  base: Pick<
    RuleDefinition,
    | "id"
    | "name"
    | "severities"
    | "severityPolicy"
    | "thresholdKeys"
    | "description"
    | "evaluation"
    | "recommendation"
  >,
  metric: Metric,
): RuleDefinition {
  return {
    ...base,
    version: "1.0.0",
    category: "COMPLEXITY",
    certainties: ["MEASURED"],
    scope: "FILE",
    requiresCompleteAnalysis: false,
    usesSourceFacts: true,
    evidenceRequirement:
      "A METRIC evidence item with the function's location, measured value and threshold.",
    evaluate(context: RuleContext): RuleEvaluation {
      const unavailable = noFactsAvailable(context);
      if (unavailable) return unavailable;

      const findings: RawFinding[] = [];

      for (const subject of functionSubjects(context)) {
        const value = metric.measure(subject);
        const severity = metric.severity(value, context.thresholds);
        if (severity === null) continue;

        const threshold = metric.threshold(severity, context.thresholds);

        findings.push({
          title: `${subject.name}: ${metric.label} ${value}`,
          description: `${subject.name} in ${subject.path} has ${metric.label} ${value} ${metric.unit}, above the configured threshold of ${threshold}.`,
          severity,
          certainty: "MEASURED",
          subjectPath: subject.path,
          subjectKey: subject.subjectKey,
          symbolKey: subject.fn.symbolKey,
          primaryLine: subject.fn.location.startLine,
          evidence: [
            {
              kind: "METRIC",
              filePath: subject.path,
              symbolKey: subject.fn.symbolKey,
              location: subject.fn.location,
              excerpt: null,
              message: `${metric.label} is ${value}; threshold is ${threshold}.`,
              data: { metric: base.id, value, threshold },
            },
          ],
          measurements: { value, threshold, metric: metric.label },
        });
      }

      return {
        kind: "findings",
        findings,
        limitations: missingFactsLimitation(context),
      };
    },
  };
}

export const cyclomaticRule = functionRule(
  {
    id: "CPX001",
    name: "High cyclomatic complexity",
    severities: ["MEDIUM", "HIGH"],
    severityPolicy: "MEDIUM at `cyclomaticMedium`; HIGH at `cyclomaticHigh`.",
    thresholdKeys: ["cyclomaticMedium", "cyclomaticHigh"],
    description:
      "A function with many independent decision paths, which is harder to test and reason about.",
    evaluation:
      "Cyclomatic complexity = 1 + decision points (if, loops, case clauses, catch, ternary, &&, ||, ??) in the function body, excluding nested functions.",
    recommendation:
      "Split the function into smaller functions with a single responsibility, or replace branching with a lookup table.",
  },
  {
    label: "cyclomatic complexity",
    unit: "",
    measure: (s) => s.fn.cyclomatic,
    severity: (v, t) =>
      v >= t.cyclomaticHigh
        ? "HIGH"
        : v >= t.cyclomaticMedium
          ? "MEDIUM"
          : null,
    threshold: (sev, t) =>
      sev === "HIGH" ? t.cyclomaticHigh : t.cyclomaticMedium,
  },
);

export const longFunctionRule = functionRule(
  {
    id: "CPX002",
    name: "Long function",
    severities: ["LOW", "MEDIUM"],
    severityPolicy:
      "LOW at `functionLinesLow`; MEDIUM at `functionLinesMedium`.",
    thresholdKeys: ["functionLinesLow", "functionLinesMedium"],
    description: "A function whose body spans many lines.",
    evaluation: "Line span of the function node (start line to end line).",
    recommendation: "Extract cohesive blocks into named helper functions.",
  },
  {
    label: "length",
    unit: "lines",
    measure: (s) => s.fn.lineSpan,
    severity: (v, t) =>
      v >= t.functionLinesMedium
        ? "MEDIUM"
        : v >= t.functionLinesLow
          ? "LOW"
          : null,
    threshold: (sev, t) =>
      sev === "MEDIUM" ? t.functionLinesMedium : t.functionLinesLow,
  },
);

export const deepNestingRule = functionRule(
  {
    id: "CPX003",
    name: "Deep nesting",
    severities: ["LOW"],
    severityPolicy: "Always LOW.",
    thresholdKeys: ["nestingDepthLow"],
    description: "A function with deeply nested control flow.",
    evaluation:
      "Maximum depth of nested control-flow statements (if, loops, switch, try) inside the function, excluding nested functions.",
    recommendation:
      "Use early returns or guard clauses and extract inner blocks.",
  },
  {
    label: "nesting depth",
    unit: "levels",
    measure: (s) => s.fn.maxNesting,
    severity: (v, t) => (v >= t.nestingDepthLow ? "LOW" : null),
    threshold: (_sev, t) => t.nestingDepthLow,
  },
);

export const parameterCountRule = functionRule(
  {
    id: "CPX004",
    name: "Many parameters",
    severities: ["LOW"],
    severityPolicy: "Always LOW.",
    thresholdKeys: ["parameterCountLow"],
    description: "A function that takes many positional parameters.",
    evaluation: "Number of declared parameters.",
    recommendation:
      "Group related parameters into an options object or a dedicated type.",
  },
  {
    label: "parameter count",
    unit: "parameters",
    measure: (s) => s.fn.parameterCount,
    severity: (v, t) => (v >= t.parameterCountLow ? "LOW" : null),
    threshold: (_sev, t) => t.parameterCountLow,
  },
);

export const largeModuleRule: RuleDefinition = {
  id: "CPX005",
  name: "Large module",
  version: "1.0.0",
  category: "COMPLEXITY",
  severities: ["LOW", "MEDIUM"],
  severityPolicy: "LOW at `moduleLinesLow`; MEDIUM at `moduleLinesMedium`.",
  certainties: ["MEASURED"],
  scope: "FILE",
  requiresCompleteAnalysis: false,
  usesSourceFacts: false,
  thresholdKeys: ["moduleLinesLow", "moduleLinesMedium"],
  description: "A source file with a very large number of lines.",
  evaluation: "Line count of the analysed file record.",
  evidenceRequirement:
    "A METRIC evidence item with the file line count and threshold.",
  recommendation: "Split the module along responsibility boundaries.",
  evaluate(context) {
    const findings: RawFinding[] = [];
    const { moduleLinesLow, moduleLinesMedium } = context.thresholds;

    for (const file of context.records.files) {
      if (
        file.scriptKind === null ||
        (file.status !== "ANALYSED" && file.status !== "ANALYSED_WITH_ERRORS")
      ) {
        continue;
      }

      const lines = file.lineCount;
      if (lines < moduleLinesLow) continue;

      const severity: FindingSeverity =
        lines >= moduleLinesMedium ? "MEDIUM" : "LOW";
      const threshold =
        severity === "MEDIUM" ? moduleLinesMedium : moduleLinesLow;

      findings.push({
        title: `${file.path} has ${lines} lines`,
        description: `${file.path} has ${lines} lines, above the configured threshold of ${threshold}.`,
        severity,
        certainty: "MEASURED",
        subjectPath: file.path,
        subjectKey: "MODULE",
        symbolKey: null,
        primaryLine: 1,
        evidence: [
          {
            kind: "METRIC",
            filePath: file.path,
            symbolKey: null,
            location: locationOf(1, Math.max(1, lines)),
            excerpt: null,
            message: `Line count is ${lines}; threshold is ${threshold}.`,
            data: { metric: "CPX005", value: lines, threshold },
          },
        ],
        measurements: { value: lines, threshold, metric: "module lines" },
      });
    }

    return { kind: "findings", findings };
  },
};

export const complexityRules: RuleDefinition[] = [
  cyclomaticRule,
  longFunctionRule,
  deepNestingRule,
  parameterCountRule,
  largeModuleRule,
];
