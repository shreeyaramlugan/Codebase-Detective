// features/research/engine/queries.ts
//
// Research query generation. Finding-based queries come from a fixed,
// reviewable table (no model involved), so identical findings always produce
// identical queries. Manual questions are normalised, never rewritten by a model.
import type { QueryPlan, ResearchLimits } from "./contracts";

export interface FindingSeed {
  ruleId: string;
  title: string;
  subjectPath: string;
}

interface Template {
  topic: string;
  /** Suggested research shown next to the finding. */
  suggestion: string;
  queries: Array<{ text: string; rationale: string; targets: QueryPlan["targets"] }>;
}

const DOCS: QueryPlan["targets"] = ["OFFICIAL_DOCUMENTATION"];
const SCHOLAR: QueryPlan["targets"] = ["CROSSREF", "OPENALEX"];
const ALL: QueryPlan["targets"] = ["OFFICIAL_DOCUMENTATION", "CROSSREF", "OPENALEX"];

export const FINDING_RESEARCH: Record<string, Template> = {
  DEP001: {
    topic: "Module resolution and project configuration",
    suggestion: "Module resolution and project configuration",
    queries: [
      { text: "module resolution paths tsconfig import unresolved", rationale: "How TypeScript and Node resolve import specifiers and where configuration matters.", targets: DOCS },
      { text: "esm import specifier extension resolution", rationale: "Extension and specifier rules for ES modules.", targets: DOCS },
    ],
  },
  DEP002: {
    topic: "Ambiguous module resolution",
    suggestion: "Module resolution and project configuration",
    queries: [
      { text: "module resolution extension index file import resolution", rationale: "How ambiguous specifiers are resolved in practice.", targets: DOCS },
      { text: "commonjs require module resolution cache", rationale: "CommonJS lookup rules that can produce multiple candidates.", targets: DOCS },
    ],
  },
  DEP003: {
    topic: "Circular dependencies and modular architecture",
    suggestion: "Modular architecture and dependency management",
    queries: [
      { text: "circular dependencies modules cycles", rationale: "How module cycles behave in JavaScript runtimes.", targets: DOCS },
      { text: "cyclic dependencies software architecture refactoring", rationale: "Published research on cyclic dependencies and how to remove them.", targets: SCHOLAR },
      { text: "dependency inversion coupling cohesion modules", rationale: "Design principles for breaking dependency cycles.", targets: SCHOLAR },
    ],
  },
  CPX001: complexity("cyclomatic complexity maintainability defects"),
  CPX002: {
    topic: "Function length and maintainability",
    suggestion: "Complexity metrics and maintainability",
    queries: [
      { text: "long method function length maintainability refactoring", rationale: "Evidence on function size and maintainability.", targets: SCHOLAR },
    ],
  },
  CPX003: {
    topic: "Nesting depth and comprehension",
    suggestion: "Complexity metrics and maintainability",
    queries: [
      { text: "cognitive complexity nesting depth code comprehension", rationale: "Evidence on how nesting affects understandability.", targets: SCHOLAR },
    ],
  },
  CPX004: {
    topic: "Parameter count and interface design",
    suggestion: "Complexity metrics and maintainability",
    queries: [
      { text: "long parameter list refactoring code smell", rationale: "Evidence on long parameter lists as a maintainability concern.", targets: SCHOLAR },
    ],
  },
  CPX005: {
    topic: "Large modules and separation of concerns",
    suggestion: "Separation of concerns and modular design",
    queries: [
      { text: "module size separation of concerns cohesion maintainability", rationale: "Evidence on module size and cohesion.", targets: SCHOLAR },
      { text: "component structure separation concerns large", rationale: "Official guidance on structuring code into smaller parts.", targets: DOCS },
    ],
  },
  STR001: {
    topic: "Duplicated code",
    suggestion: "Code duplication and maintainability",
    queries: [
      { text: "code clones duplicated code maintenance refactoring", rationale: "Evidence on the cost of duplicated code and refactoring options.", targets: SCHOLAR },
    ],
  },
  SEC001: security("eval dynamic code injection", "Dynamic code evaluation and injection risk"),
  SEC002: security("child_process exec shell command injection", "Shell command execution and injection risk"),
  SEC003: security("xss innerhtml dangerouslysetinnerhtml sanitize", "HTML injection sinks and cross-site scripting"),
  SEC004: security("hardcoded credentials secrets management", "Credential and secrets management"),
  SEC005: security("tls certificate verification rejectunauthorized", "TLS certificate verification"),
  SEC006: security("weak hash md5 sha1 password storage cryptographic", "Hashing algorithms and secure storage"),
};

function complexity(text: string): Template {
  return {
    topic: "Complexity metrics and maintainability",
    suggestion: "Complexity metrics and maintainability",
    queries: [
      { text, rationale: "Evidence relating complexity metrics to maintainability.", targets: SCHOLAR },
    ],
  };
}

function security(text: string, topic: string): Template {
  return {
    topic,
    suggestion: "Secure coding practices and relevant security guidance",
    queries: [
      { text, rationale: "Official secure-coding guidance for this pattern.", targets: DOCS },
      { text: `${topic.toLowerCase()} secure coding`, rationale: "Published research on this class of weakness.", targets: SCHOLAR },
    ],
  };
}

export function isResearchSupported(ruleId: string): boolean {
  return Object.prototype.hasOwnProperty.call(FINDING_RESEARCH, ruleId);
}

export function researchSuggestion(ruleId: string): string | null {
  return isResearchSupported(ruleId) ? FINDING_RESEARCH[ruleId].suggestion : null;
}

export function planFindingQueries(
  finding: FindingSeed,
  limits: Pick<ResearchLimits, "maxQueriesPerRun">,
): QueryPlan[] {
  if (!isResearchSupported(finding.ruleId)) return [];
  return FINDING_RESEARCH[finding.ruleId].queries
    .slice(0, limits.maxQueriesPerRun)
    .map((q, index) => ({ ordinal: index + 1, text: q.text, rationale: q.rationale, targets: q.targets }));
}

export class ManualQuestionError extends Error {}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const MAX_MANUAL_QUESTION = 500;

export function validateManualQuestion(raw: unknown): string {
  if (typeof raw !== "string") throw new ManualQuestionError("A research question is required.");
  const q = raw.replace(/\s+/g, " ").trim();
  if (q.length < 8) throw new ManualQuestionError("The research question is too short.");
  if (q.length > MAX_MANUAL_QUESTION) {
    throw new ManualQuestionError(`The research question is too long (maximum ${MAX_MANUAL_QUESTION} characters).`);
  }
  if (CONTROL.test(q)) throw new ManualQuestionError("The research question contains unsupported characters.");
  return q;
}

/** Manual questions search both documentation and scholarly sources with the user's own words. */
export function planManualQueries(
  question: string,
  limits: Pick<ResearchLimits, "maxQueriesPerRun">,
): QueryPlan[] {
  const text = question.replace(/[?!.]+$/g, "").slice(0, 200);
  const plans: QueryPlan[] = [
    { ordinal: 1, text, rationale: "Your question, searched in official documentation and scholarly sources.", targets: ALL },
  ];
  return plans.slice(0, limits.maxQueriesPerRun);
}
