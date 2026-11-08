// features/findings/identity.ts
//
// Finding identity.
//
// The fingerprint is a hash of the rule id, the subject's file path and a
// path-independent subject key. It deliberately excludes line numbers (code
// moving within a file keeps its identity), the rule version (so a rule
// upgrade can be detected as a version change rather than as new findings)
// and every run/analysis/snapshot id (so the same issue in two snapshots has
// the same fingerprint). Identical inputs always give identical fingerprints.
import { createHash } from "node:crypto";

export function createFindingFingerprint(input: {
  ruleId: string;
  subjectPath: string;
  subjectKey: string;
}): string {
  const material = [input.ruleId, input.subjectPath, input.subjectKey].join(
    "\u0000",
  );

  return `fnd_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

export function isFindingFingerprint(value: string): boolean {
  return /^fnd_[0-9a-f]{32}$/.test(value);
}
