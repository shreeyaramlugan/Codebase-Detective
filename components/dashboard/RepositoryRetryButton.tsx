"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type RepositoryRetryButtonProps = {
  jobId: string;
};

export default function RepositoryRetryButton({
  jobId,
}: RepositoryRetryButtonProps) {
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleRetry() {
    if (loading) return;

    setLoading(true);
    setMessage(null);
    setIsError(false);

    try {
      const response = await fetch(
        `/api/jobs/${encodeURIComponent(jobId)}/retry`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      const data = await response.json();

      if (!response.ok) {
        setIsError(true);
        setMessage(
          typeof data.error === "string"
            ? data.error
            : "Unable to retry this indexing job.",
        );
        return;
      }

      setMessage("Retry successfully queued.");
      router.refresh();
    } catch {
      setIsError(true);
      setMessage("Unable to reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleRetry}
        disabled={loading}
        className="inline-flex items-center justify-center rounded-lg border border-orange-700/50 bg-orange-600/10 px-3 py-2 text-xs font-medium text-orange-400 transition-colors hover:bg-orange-600/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Queueing retry..." : "Retry indexing"}
      </button>

      {message && (
        <p
          role="status"
          aria-live="polite"
          className={`mt-2 text-xs ${
            isError ? "text-red-400" : "text-emerald-400"
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
