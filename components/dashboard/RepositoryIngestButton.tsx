// components/dashboard/RepositoryIngestButton.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type RepositoryIngestButtonProps = {
  repositoryId: string;
  label: string;
};

export default function RepositoryIngestButton({
  repositoryId,
  label,
}: RepositoryIngestButtonProps) {
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleClick() {
    if (loading) return;

    setLoading(true);
    setMessage(null);
    setIsError(false);

    try {
      const response = await fetch(
        `/api/repositories/${encodeURIComponent(repositoryId)}/ingest`,
        { method: "POST" },
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setIsError(true);
        setMessage(
          typeof data.error === "string"
            ? data.error
            : "Unable to queue ingestion.",
        );
        return;
      }

      setMessage("Ingestion queued.");
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
        onClick={handleClick}
        disabled={loading}
        className="inline-flex items-center justify-center rounded-lg border border-orange-700/50 bg-orange-600/10 px-3 py-2 text-xs font-medium text-orange-400 transition-colors hover:bg-orange-600/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Queueing..." : label}
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
