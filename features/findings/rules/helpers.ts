// features/findings/rules/helpers.ts
import type { SourceLocation } from "@/features/code-intelligence/contracts";

import type { FileFacts, RuleContext, RuleEvaluation } from "../contracts";

export function locationOf(
  startLine: number,
  endLine: number = startLine,
): SourceLocation {
  return { startLine, startColumn: 1, endLine, endColumn: 1 };
}

/** Files whose facts exist, in path order. */
export function factsInOrder(context: RuleContext): FileFacts[] {
  return [...context.facts.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

export function missingFactsLimitation(context: RuleContext): string[] {
  const count = context.factsMissing.size;
  return count === 0
    ? []
    : [
        `Source facts were unavailable for ${count} file(s); they were not checked.`,
      ];
}

export function noFactsAvailable(context: RuleContext): RuleEvaluation | null {
  if (context.facts.size === 0 && context.factsMissing.size > 0) {
    return {
      kind: "insufficient",
      reason: "No source content could be verified against the analysis.",
    };
  }
  return null;
}

import type { FunctionFacts } from "../contracts";

export interface FunctionSubject {
  path: string;
  fn: FunctionFacts;
  /** Display name: qualified symbol name, or "anonymous function". */
  name: string;
  /** Path-independent, ordinal-stable identity within the file. */
  subjectKey: string;
}

/**
 * Every function of every verified file with a stable subject key. Linked
 * functions are keyed by qualified name; unlinked ones (callbacks, anonymous
 * functions) by their order among the unlinked functions of the file.
 */
export function functionSubjects(context: RuleContext): FunctionSubject[] {
  const qualified = new Map<string, string>();
  for (const symbol of context.records.symbols) {
    qualified.set(symbol.key, symbol.qualifiedName);
  }

  const subjects: FunctionSubject[] = [];

  for (const file of factsInOrder(context)) {
    const counters = new Map<string, number>();

    for (const fn of file.functions) {
      const qualifiedName =
        fn.symbolKey !== null ? qualified.get(fn.symbolKey) : undefined;
      const base = qualifiedName
        ? `FUNCTION:${qualifiedName}`
        : "FUNCTION:<anonymous>";
      const n = counters.get(base) ?? 0;
      counters.set(base, n + 1);

      subjects.push({
        path: file.path,
        fn,
        name: qualifiedName ?? "anonymous function",
        subjectKey: `${base}#${n}`,
      });
    }
  }

  return subjects;
}
