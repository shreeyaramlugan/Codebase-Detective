import type {
  EvidenceReference,
  AIExplanation,
} from "../providers/explanation";

import type { GroundingContext } from "./evidence";

export interface GroundingValidation {
  valid: boolean;
  acceptedReferences: EvidenceReference[];
  rejectedReferences: EvidenceReference[];
  errors: string[];
}

export function validateEvidenceReferences(
  explanation: AIExplanation,
  context: GroundingContext,
): GroundingValidation {
  const availableEvidence = new Map(
    context.evidence.map((item) => [item.id, item.type]),
  );

  const acceptedReferences: EvidenceReference[] = [];
  const rejectedReferences: EvidenceReference[] = [];
  const errors: string[] = [];

  for (const reference of explanation.evidenceReferences) {
    const actualType = availableEvidence.get(reference.id);

    if (!actualType) {
      rejectedReferences.push(reference);
      errors.push(`Unknown evidence reference: ${reference.id}`);
      continue;
    }

    if (actualType !== reference.type) {
      rejectedReferences.push(reference);
      errors.push(`Evidence type mismatch: ${reference.id}`);
      continue;
    }

    if (!acceptedReferences.some((item) => item.id === reference.id)) {
      acceptedReferences.push(reference);
    }
  }

  return {
    valid: errors.length === 0,
    acceptedReferences,
    rejectedReferences,
    errors,
  };
}
