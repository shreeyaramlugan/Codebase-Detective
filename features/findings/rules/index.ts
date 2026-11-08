// features/findings/rules/index.ts
//
// The rule catalogue. Rule ids are permanent; add rules, never renumber.
import type { RuleDefinition } from "../contracts";
import { assertValidCatalogue } from "../engine/run-rules";
import { complexityRules } from "./complexity";
import { dependencyRules } from "./dependency";
import { securityRules } from "./security";
import { structureRules } from "./structure";

export const RULE_CATALOGUE: readonly RuleDefinition[] = Object.freeze(
  [
    ...dependencyRules,
    ...complexityRules,
    ...structureRules,
    ...securityRules,
  ].sort((a, b) => a.id.localeCompare(b.id)),
);

assertValidCatalogue(RULE_CATALOGUE);

export function getRule(id: string): RuleDefinition | undefined {
  return RULE_CATALOGUE.find((rule) => rule.id === id);
}
