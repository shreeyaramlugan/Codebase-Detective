// components/findings/FindingsComparison.tsx
"use client";

import { useMemo, useState } from "react";

import {
  SEVERITY_LABELS,
  STATUS_LABELS,
  labelFor,
  severityTone,
  statusTone,
} from "@/features/findings/view/findings-view";
import type {
  FindingsComparisonView,
  FindingsRunView,
} from "@/lib/findings/findings.service";

import {
  Badge,
  EmptyState,
  ErrorBox,
  Panel,
  Spinner,
  formatDate,
  inputClass,
} from "@/components/explorer/ui";
import { useApi } from "@/components/explorer/useApi";

type Props = { repositoryId: string; currentRunId: string | null };

const STATUS_ORDER = [
  "NEW",
  "RESOLVED",
  "UNVERIFIED",
  "NOT_COMPARABLE",
  "PERSISTENT",
] as const;

function runLabel(run: FindingsRunView): string {
  return `${run.commitSha.slice(0, 7)} · ${run.status.toLowerCase()} · ${formatDate(run.createdAt)}`;
}

export default function FindingsComparison({
  repositoryId,
  currentRunId,
}: Props) {
  const runs = useApi<{ runs: FindingsRunView[] }>(
    `/api/repositories/${encodeURIComponent(repositoryId)}/findings/runs`,
  );
  const [base, setBase] = useState("");
  const [head, setHead] = useState(currentRunId ?? "");
  const [status, setStatus] = useState<string>("");

  const ready = base !== "" && head !== "" && base !== head;
  const comparison = useApi<FindingsComparisonView>(
    ready
      ? `/api/repositories/${encodeURIComponent(repositoryId)}/findings/compare?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`
      : null,
  );

  const entries = useMemo(
    () =>
      (comparison.data?.entries ?? []).filter(
        (entry) => status === "" || entry.status === status,
      ),
    [comparison.data, status],
  );

  const options = runs.data?.runs.filter(
    (run) => run.status === "COMPLETED" || run.status === "PARTIAL",
  );

  return (
    <div className="space-y-4">
      <Panel title="Compare snapshots">
        {runs.loading && <Spinner />}
        {runs.error && <ErrorBox message={runs.error} onRetry={runs.reload} />}
        {options && options.length < 2 && (
          <EmptyState
            title="At least two finished findings runs are needed."
            message="Run findings on another snapshot or analysis, then compare."
          />
        )}
        {options && options.length >= 2 && (
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="cmp-base"
                className="mb-1 block text-[11px] text-stone-500"
              >
                Base (earlier)
              </label>
              <select
                id="cmp-base"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                className={inputClass}
              >
                <option value="">Choose a run</option>
                {options.map((run) => (
                  <option key={run.id} value={run.id}>
                    {runLabel(run)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="cmp-head"
                className="mb-1 block text-[11px] text-stone-500"
              >
                Head (later)
              </label>
              <select
                id="cmp-head"
                value={head}
                onChange={(e) => setHead(e.target.value)}
                className={inputClass}
              >
                <option value="">Choose a run</option>
                {options.map((run) => (
                  <option key={run.id} value={run.id}>
                    {runLabel(run)}
                  </option>
                ))}
              </select>
            </div>
            {base !== "" && base === head && (
              <p role="alert" className="text-sm text-amber-300 sm:col-span-2">
                Choose two different runs.
              </p>
            )}
          </div>
        )}
      </Panel>

      {ready && comparison.loading && <Spinner label="Comparing..." />}
      {ready && comparison.error && (
        <ErrorBox message={comparison.error} onRetry={comparison.reload} />
      )}

      {comparison.data && (
        <>
          {comparison.data.limitations.length > 0 && (
            <div
              role="note"
              className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-200"
            >
              <p className="font-medium">Read these results with care</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {comparison.data.limitations.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {STATUS_ORDER.map((key) => {
              const count =
                comparison.data!.summary[
                  key === "NOT_COMPARABLE"
                    ? "notComparable"
                    : (key.toLowerCase() as "new")
                ];
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={status === key}
                  onClick={() => setStatus(status === key ? "" : key)}
                  className={`rounded-2xl border p-4 text-left transition ${status === key ? "border-orange-500/60" : "border-stone-800 hover:border-stone-700"} bg-stone-900/70`}
                >
                  <p className="text-2xl font-semibold text-stone-100">
                    {count}
                  </p>
                  <p className="text-xs text-stone-400">
                    {labelFor(STATUS_LABELS, key)}
                  </p>
                </button>
              );
            })}
          </div>

          {comparison.data.notComparableRules.length > 0 && (
            <Panel title="Rules that cannot be compared">
              <ul className="divide-y divide-stone-800">
                {comparison.data.notComparableRules.map((rule) => (
                  <li
                    key={rule.ruleId}
                    className="px-4 py-2 text-sm text-stone-400"
                  >
                    <span className="text-stone-200">{rule.ruleId}</span>:{" "}
                    {rule.reason}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title={`Differences (${entries.length})`}>
            {entries.length === 0 ? (
              <EmptyState title="Nothing to show for this filter." />
            ) : (
              <ul className="divide-y divide-stone-800">
                {entries.map((entry) => (
                  <li
                    key={`${entry.status}-${entry.fingerprint}`}
                    className="space-y-1 px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={statusTone(entry.status)}>
                        {labelFor(STATUS_LABELS, entry.status)}
                      </Badge>
                      <Badge tone={severityTone(entry.severity)}>
                        {labelFor(SEVERITY_LABELS, entry.severity)}
                      </Badge>
                      {entry.previousSeverity && (
                        <Badge tone="warn">
                          was{" "}
                          {labelFor(SEVERITY_LABELS, entry.previousSeverity)}
                        </Badge>
                      )}
                      <span className="text-xs text-stone-500">
                        {entry.ruleId}
                      </span>
                    </div>
                    <p className="text-sm text-stone-200">{entry.title}</p>
                    <p className="text-xs text-stone-500">
                      {entry.previousPath
                        ? `${entry.previousPath} → ${entry.subjectPath}`
                        : entry.subjectPath}
                    </p>
                    {entry.reason && (
                      <p className="text-xs text-stone-400">{entry.reason}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
