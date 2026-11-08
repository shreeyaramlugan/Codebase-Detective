// features/findings/config.ts
//
// Explicit, documented thresholds. Defaults are conventional values for the
// metrics used; they can be overridden per run (within bounds) and are stored
// with the run so results are reproducible and comparable.
import { createHash } from "node:crypto";

import type { RuleDefinition, Thresholds } from "./contracts";

export const DEFAULT_THRESHOLDS: Thresholds = {
  cyclomaticMedium: 15,
  cyclomaticHigh: 30,
  functionLinesLow: 100,
  functionLinesMedium: 250,
  nestingDepthLow: 6,
  parameterCountLow: 7,
  moduleLinesLow: 500,
  moduleLinesMedium: 1000,
  circularHighSize: 5,
  duplicateMinGroupSize: 3,
  duplicateMinNodes: 60,
};

const BOUNDS: Record<keyof Thresholds, [number, number]> = {
  cyclomaticMedium: [5, 200],
  cyclomaticHigh: [5, 500],
  functionLinesLow: [10, 5_000],
  functionLinesMedium: [10, 10_000],
  nestingDepthLow: [2, 50],
  parameterCountLow: [2, 50],
  moduleLinesLow: [50, 100_000],
  moduleLinesMedium: [50, 100_000],
  circularHighSize: [2, 1_000],
  duplicateMinGroupSize: [2, 100],
  duplicateMinNodes: [10, 100_000],
};

/** Pairs where the first must not exceed the second. */
const ORDERED_PAIRS: Array<[keyof Thresholds, keyof Thresholds]> = [
  ["cyclomaticMedium", "cyclomaticHigh"],
  ["functionLinesLow", "functionLinesMedium"],
  ["moduleLinesLow", "moduleLinesMedium"],
];

export class ThresholdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThresholdError";
  }
}

/**
 * Merges overrides onto the defaults. Unknown keys, non-integers and
 * out-of-range values are rejected rather than silently ignored.
 */
export function resolveThresholds(overrides: unknown = {}): Thresholds {
  if (overrides === null || overrides === undefined) {
    return { ...DEFAULT_THRESHOLDS };
  }

  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new ThresholdError("thresholds must be an object.");
  }

  const merged: Thresholds = { ...DEFAULT_THRESHOLDS };

  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULT_THRESHOLDS)) {
      throw new ThresholdError(`Unknown threshold "${key}".`);
    }

    const [min, max] = BOUNDS[key as keyof Thresholds];

    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new ThresholdError(`Threshold "${key}" must be an integer.`);
    }

    if (value < min || value > max) {
      throw new ThresholdError(
        `Threshold "${key}" must be between ${min} and ${max}.`,
      );
    }

    merged[key as keyof Thresholds] = value;
  }

  for (const [low, high] of ORDERED_PAIRS) {
    if (merged[low] > merged[high]) {
      throw new ThresholdError(`"${low}" must not exceed "${high}".`);
    }
  }

  return merged;
}

/** Hash of only the thresholds a rule uses: equal hash = same behaviour. */
export function ruleConfigHash(
  rule: Pick<RuleDefinition, "thresholdKeys">,
  thresholds: Thresholds,
): string {
  const material = [...rule.thresholdKeys]
    .sort()
    .map((key) => `${key}=${thresholds[key]}`)
    .join(";");

  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}
