// features/findings/compare/compare-findings.ts
//
// Pure snapshot-to-snapshot comparison of findings.
//
//  NEW            present in head, absent in base, and the base could have
//                 shown it.
//  PERSISTENT     same fingerprint in both (or the same finding in a file that
//                 moved with identical content).
//  RESOLVED       present in base, absent in head, and the head analysis
//                 verifiably covered the subject with the same rule version
//                 and configuration.
//  UNVERIFIED     the absence cannot be trusted (partial analysis, file not
//                 analysed, source facts missing, rule did not complete).
//  NOT_COMPARABLE the rule's version or configuration differs between runs,
//                 so a difference may be an artefact of the change.
//
// A finding is never reported as resolved merely because it is missing.
import type { FindingSeverity, RuleRunRecord } from "../contracts";

export type ComparisonStatus =
  "NEW" | "PERSISTENT" | "RESOLVED" | "UNVERIFIED" | "NOT_COMPARABLE";

export interface ComparableFinding {
  fingerprint: string;
  ruleId: string;
  ruleVersion: string;
  severity: FindingSeverity;
  subjectPath: string;
  subjectKey: string;
  title: string;
}

export interface ComparisonSide {
  analysisId: string;
  /** True only for a COMPLETED analysis of a COMPLETE snapshot. */
  complete: boolean;
  findings: readonly ComparableFinding[];
  ruleRuns: readonly Pick<
    RuleRunRecord,
    "ruleId" | "ruleVersion" | "status" | "configHash"
  >[];
  /** Content hash of every analysed file, by path. */
  fileHashes: ReadonlyMap<string, string>;
  /** Analysed paths whose source facts could not be produced, with reason. */
  factsMissing: ReadonlyMap<string, string>;
  /** True when `factsMissing` was truncated and cannot be trusted as complete. */
  factsIncomplete?: boolean;
  /** Ids of rules that read source facts. */
  factRuleIds: ReadonlySet<string>;
}

export interface ComparisonEntry {
  status: ComparisonStatus;
  fingerprint: string;
  ruleId: string;
  title: string;
  severity: FindingSeverity;
  previousSeverity: FindingSeverity | null;
  subjectPath: string;
  previousPath: string | null;
  reason: string | null;
}

export interface ComparisonSummary {
  new: number;
  persistent: number;
  resolved: number;
  unverified: number;
  notComparable: number;
}

export interface FindingsComparison {
  entries: ComparisonEntry[];
  summary: ComparisonSummary;
  /** Rules that could not be compared, with the reason. */
  notComparableRules: Array<{ ruleId: string; reason: string }>;
  limitations: string[];
}

interface Incomparable {
  /** UNVERIFIED: a run could not vouch. NOT_COMPARABLE: the rule changed. */
  status: "UNVERIFIED" | "NOT_COMPARABLE";
  reason: string;
}

function ruleComparability(
  base: ComparisonSide,
  head: ComparisonSide,
  ruleId: string,
): Incomparable | null {
  const b = base.ruleRuns.find((run) => run.ruleId === ruleId);
  const h = head.ruleRuns.find((run) => run.ruleId === ruleId);

  if (!b || !h) {
    return {
      status: "NOT_COMPARABLE",
      reason: "The rule was not part of both runs.",
    };
  }
  if (b.status !== "COMPLETED" || h.status !== "COMPLETED") {
    return {
      status: "UNVERIFIED",
      reason: "The rule did not complete in both runs (insufficient evidence).",
    };
  }
  if (b.ruleVersion !== h.ruleVersion) {
    return {
      status: "NOT_COMPARABLE",
      reason: `The rule version changed (${b.ruleVersion} to ${h.ruleVersion}).`,
    };
  }
  if (b.configHash !== h.configHash) {
    return {
      status: "NOT_COMPARABLE",
      reason: "The rule's thresholds changed between runs.",
    };
  }
  return null;
}

/** Why a side cannot vouch for the absence of a finding, or null if it can. */
function cannotVouch(
  side: ComparisonSide,
  finding: ComparableFinding,
): string | null {
  const known = side.fileHashes.has(finding.subjectPath);

  if (!known) {
    return side.complete
      ? null
      : "The file was not analysed and the analysis is partial.";
  }

  if (side.factRuleIds.has(finding.ruleId)) {
    if (side.factsMissing.has(finding.subjectPath)) {
      return "Source facts for the file were unavailable.";
    }
    if (side.factsIncomplete) {
      return "The record of files without source facts is incomplete.";
    }
  }

  return null;
}

export function compareFindings(
  base: ComparisonSide,
  head: ComparisonSide,
): FindingsComparison {
  const entries: ComparisonEntry[] = [];
  const notComparable = new Map<string, string>();
  const limitations: string[] = [];

  if (!base.complete) {
    limitations.push(
      "The base analysis is partial; findings that look new may already have existed.",
    );
  }
  if (!head.complete) {
    limitations.push(
      "The head analysis is partial; findings that look resolved may simply not have been checked.",
    );
  }

  const baseByFp = new Map(base.findings.map((f) => [f.fingerprint, f]));
  const headByFp = new Map(head.findings.map((f) => [f.fingerprint, f]));

  const comparability = new Map<string, Incomparable | null>();
  const comparable = (ruleId: string): Incomparable | null => {
    if (!comparability.has(ruleId)) {
      const problem = ruleComparability(base, head, ruleId);
      comparability.set(ruleId, problem);
      if (problem) notComparable.set(ruleId, problem.reason);
    }
    return comparability.get(ruleId) ?? null;
  };
  const blocked = (problem: Incomparable, f: ComparableFinding, extra = {}) =>
    entry(problem.status, f, { reason: problem.reason, ...extra });

  const entry = (
    status: ComparisonStatus,
    finding: ComparableFinding,
    extra: Partial<ComparisonEntry> = {},
  ): ComparisonEntry => ({
    status,
    fingerprint: finding.fingerprint,
    ruleId: finding.ruleId,
    title: finding.title,
    severity: finding.severity,
    previousSeverity: null,
    subjectPath: finding.subjectPath,
    previousPath: null,
    reason: null,
    ...extra,
  });

  const unmatchedBase: ComparableFinding[] = [];
  const unmatchedHead: ComparableFinding[] = [];

  for (const finding of head.findings) {
    const previous = baseByFp.get(finding.fingerprint);
    if (previous) {
      const reason = comparable(finding.ruleId);
      entries.push(
        reason
          ? blocked(reason, finding)
          : entry("PERSISTENT", finding, {
              previousSeverity:
                previous.severity === finding.severity
                  ? null
                  : previous.severity,
            }),
      );
    } else {
      unmatchedHead.push(finding);
    }
  }

  for (const finding of base.findings) {
    if (!headByFp.has(finding.fingerprint)) unmatchedBase.push(finding);
  }

  // Move detection: same rule, same subject key, and the subject file has
  // identical content under a different path. Only unambiguous 1:1 matches.
  const groupKey = (f: ComparableFinding, hash: string | undefined) =>
    `${f.ruleId}\u0000${f.subjectKey}\u0000${hash ?? ""}`;
  const baseGroups = new Map<string, ComparableFinding[]>();
  const headGroups = new Map<string, ComparableFinding[]>();

  for (const f of unmatchedBase) {
    const hash = base.fileHashes.get(f.subjectPath);
    if (!hash || head.fileHashes.has(f.subjectPath)) continue;
    const key = groupKey(f, hash);
    baseGroups.set(key, [...(baseGroups.get(key) ?? []), f]);
  }
  for (const f of unmatchedHead) {
    const hash = head.fileHashes.get(f.subjectPath);
    if (!hash || base.fileHashes.has(f.subjectPath)) continue;
    const key = groupKey(f, hash);
    headGroups.set(key, [...(headGroups.get(key) ?? []), f]);
  }

  const movedBase = new Set<string>();
  const movedHead = new Set<string>();

  for (const [key, baseList] of baseGroups) {
    const headList = headGroups.get(key);
    if (baseList.length !== 1 || headList?.length !== 1) continue;
    const [from] = baseList;
    const [to] = headList;
    movedBase.add(from.fingerprint);
    movedHead.add(to.fingerprint);
    const reason = comparable(to.ruleId);
    entries.push(
      reason
        ? blocked(reason, to, { previousPath: from.subjectPath })
        : entry("PERSISTENT", to, {
            previousPath: from.subjectPath,
            previousSeverity:
              from.severity === to.severity ? null : from.severity,
            reason: "The file moved; its content is unchanged.",
          }),
    );
  }

  for (const finding of unmatchedHead) {
    if (movedHead.has(finding.fingerprint)) continue;

    const ruleReason = comparable(finding.ruleId);
    if (ruleReason) {
      entries.push(blocked(ruleReason, finding));
      continue;
    }

    const doubt = cannotVouch(base, finding);
    entries.push(
      doubt
        ? entry("UNVERIFIED", finding, {
            reason: `Not known to be new: ${doubt}`,
          })
        : entry("NEW", finding),
    );
  }

  for (const finding of unmatchedBase) {
    if (movedBase.has(finding.fingerprint)) continue;

    const ruleReason = comparable(finding.ruleId);
    if (ruleReason) {
      entries.push(blocked(ruleReason, finding));
      continue;
    }

    const doubt = cannotVouch(head, finding);
    entries.push(
      doubt
        ? entry("UNVERIFIED", finding, {
            reason: `Not known to be resolved: ${doubt}`,
          })
        : entry("RESOLVED", finding, {
            reason: head.fileHashes.has(finding.subjectPath)
              ? null
              : "The file no longer exists in the head snapshot.",
          }),
    );
  }

  const order: Record<ComparisonStatus, number> = {
    NEW: 0,
    RESOLVED: 1,
    UNVERIFIED: 2,
    NOT_COMPARABLE: 3,
    PERSISTENT: 4,
  };

  entries.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.subjectPath.localeCompare(b.subjectPath) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );

  const summary: ComparisonSummary = {
    new: 0,
    persistent: 0,
    resolved: 0,
    unverified: 0,
    notComparable: 0,
  };

  for (const e of entries) {
    if (e.status === "NEW") summary.new += 1;
    else if (e.status === "PERSISTENT") summary.persistent += 1;
    else if (e.status === "RESOLVED") summary.resolved += 1;
    else if (e.status === "UNVERIFIED") summary.unverified += 1;
    else summary.notComparable += 1;
  }

  return {
    entries,
    summary,
    notComparableRules: [...notComparable.entries()]
      .map(([ruleId, reason]) => ({ ruleId, reason }))
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
    limitations,
  };
}
