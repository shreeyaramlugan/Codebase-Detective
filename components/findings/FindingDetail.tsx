// components/findings/FindingDetail.tsx
"use client";

import { useState } from "react";

import { researchSuggestion } from "@/features/research/engine/queries";
import type { ExplorerState } from "@/features/explorer/navigation/explorer-url";
import {
  CATEGORY_LABELS,
  CERTAINTY_EXPLANATIONS,
  CERTAINTY_LABELS,
  REVIEW_LABELS,
  SEVERITY_LABELS,
  certaintyTone,
  formatLocation,
  labelFor,
  severityTone,
  sourceNavigation,
} from "@/features/findings/view/findings-view";
import type { FindingDetail as FindingDetailView } from "@/lib/findings/findings.service";

import {
  Badge,
  ErrorBox,
  Panel,
  Spinner,
  inputClass,
} from "@/components/explorer/ui";
import { readApiError, useApi } from "@/components/explorer/useApi";

type Props = {
  findingId: string;
  onNavigate: (patch: Partial<ExplorerState>) => void;
  onClose: () => void;
  onReviewChanged: () => void;
};

export default function FindingDetail({
  findingId,
  onNavigate,
  onClose,
  onReviewChanged,
}: Props) {
  const { data, error, loading, reload } = useApi<FindingDetailView>(
    `/api/findings/${encodeURIComponent(findingId)}`,
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  async function review(status: "ACKNOWLEDGED" | "DISMISSED" | null) {
    setBusy(true);
    setReviewError(null);
    try {
      const response = await fetch(
        `/api/findings/${encodeURIComponent(findingId)}/review`,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status, reason: reason.trim() || null }),
        },
      );
      if (!response.ok) throw new Error(await readApiError(response));
      setReason("");
      reload();
      onReviewChanged();
    } catch (cause) {
      setReviewError(
        cause instanceof Error ? cause.message : "Could not save the review.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Finding details"
      action={
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-stone-700 px-2.5 py-1 text-xs text-stone-300 hover:bg-stone-800"
        >
          Close
        </button>
      }
    >
      {loading && <Spinner label="Loading finding..." />}
      {error && <ErrorBox message={error} onRetry={reload} />}

      {data && (
        <div className="space-y-5 p-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={severityTone(data.severity)}>
                {labelFor(SEVERITY_LABELS, data.severity)}
              </Badge>
              <Badge tone="neutral">
                {labelFor(CATEGORY_LABELS, data.category)}
              </Badge>
              <Badge
                tone={certaintyTone(data.certainty)}
                title={
                  CERTAINTY_EXPLANATIONS[
                    data.certainty as keyof typeof CERTAINTY_EXPLANATIONS
                  ]
                }
              >
                {labelFor(CERTAINTY_LABELS, data.certainty)}
              </Badge>
              <Badge tone="neutral">
                {data.ruleId} v{data.ruleVersion}
              </Badge>
              {data.review && (
                <Badge tone="accent">
                  {labelFor(REVIEW_LABELS, data.review.status)}
                </Badge>
              )}
            </div>
            <h4 className="mt-3 text-base font-semibold text-stone-100">
              {data.title}
            </h4>
            <p className="mt-2 text-sm text-stone-400">{data.description}</p>
          </div>

          {researchSuggestion(data.ruleId) && (
            <div className="rounded-xl border border-stone-800 bg-stone-950/40 p-3">
              <p className="text-sm text-stone-300">
                Research available: {researchSuggestion(data.ruleId)}.
              </p>
              <p className="mt-1 text-xs text-stone-500">
                Research searches official documentation and scholarly
                sources. You review the sources before any recommendation is
                written, and nothing changes in your code.
              </p>
              <button
                type="button"
                onClick={() => onNavigate({ view: "research", finding: findingId, research: null })}
                className="mt-2 rounded-lg border border-orange-500/40 px-3 py-1.5 text-xs font-medium text-orange-300 hover:bg-orange-500/10"
              >
                Research this finding
              </button>
            </div>
          )}

          {data.isIndicator && (
            <p
              role="note"
              className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200"
            >
              This is a static pattern indicator, not a confirmed vulnerability.
              Review the code to decide whether it matters.
            </p>
          )}

          <section aria-label="Evidence">
            <h5 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
              Evidence ({data.evidence.length})
            </h5>
            <ul className="mt-2 space-y-2">
              {data.evidence.map((item) => {
                const target = sourceNavigation(item);
                return (
                  <li
                    key={item.ordinal}
                    className="rounded-xl border border-stone-800 bg-stone-950/60 p-3"
                  >
                    <p className="text-sm text-stone-300">{item.message}</p>
                    {item.excerpt && (
                      <pre className="mt-2 overflow-x-auto rounded-lg bg-stone-900 p-2 text-xs text-stone-300">
                        {item.excerpt}
                      </pre>
                    )}
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <code className="text-xs text-stone-500">
                        {formatLocation(item)}
                      </code>
                      {target && (
                        <button
                          type="button"
                          onClick={() => onNavigate(target)}
                          className="rounded-lg border border-stone-700 px-2.5 py-1 text-xs text-orange-300 hover:bg-stone-800"
                        >
                          Open in source
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {data.measurements !== null &&
            typeof data.measurements === "object" && (
              <section aria-label="Measurements">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                  Measurements
                </h5>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  {Object.entries(
                    data.measurements as Record<string, unknown>,
                  ).map(([key, value]) => (
                    <div
                      key={key}
                      className="rounded-lg bg-stone-950/60 px-3 py-2"
                    >
                      <dt className="text-[11px] text-stone-500">{key}</dt>
                      <dd className="text-stone-200">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

          <section aria-label="Recommendation">
            <h5 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
              Suggested next step
            </h5>
            <p className="mt-2 text-sm text-stone-300">{data.recommendation}</p>
          </section>

          {data.rule && (
            <section aria-label="Rule">
              <h5 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                How this was detected
              </h5>
              <p className="mt-2 text-sm text-stone-400">
                <span className="text-stone-300">{data.rule.name}.</span>{" "}
                {data.rule.evaluation}
              </p>
            </section>
          )}

          <section
            aria-label="Review"
            className="border-t border-stone-800 pt-4"
          >
            <h5 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
              Your review
            </h5>
            <p className="mt-1 text-xs text-stone-500">
              Triage notes stay with this finding across analyses and never
              change what the engine detects.
            </p>
            {data.review?.reason && (
              <p className="mt-2 text-sm text-stone-300">
                Reason: {data.review.reason}
              </p>
            )}
            <label htmlFor="review-reason" className="sr-only">
              Reason
            </label>
            <input
              id="review-reason"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Reason (required to dismiss)"
              className={`${inputClass} mt-2`}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void review("ACKNOWLEDGED")}
                className="rounded-lg border border-stone-700 px-3 py-1.5 text-xs text-stone-200 hover:bg-stone-800 disabled:opacity-50"
              >
                Acknowledge
              </button>
              <button
                type="button"
                disabled={busy || reason.trim() === ""}
                onClick={() => void review("DISMISSED")}
                className="rounded-lg border border-stone-700 px-3 py-1.5 text-xs text-stone-200 hover:bg-stone-800 disabled:opacity-50"
              >
                Dismiss
              </button>
              {data.review && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void review(null)}
                  className="rounded-lg px-3 py-1.5 text-xs text-stone-400 hover:text-stone-200 disabled:opacity-50"
                >
                  Clear review
                </button>
              )}
            </div>
            {reviewError && (
              <p role="alert" className="mt-2 text-xs text-red-400">
                {reviewError}
              </p>
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}
