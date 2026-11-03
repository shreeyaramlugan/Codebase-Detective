"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function RepositorySubmission() {
  const router = useRouter();
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "">("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setMessageType("");

    const trimmedUrl = repositoryUrl.trim();

    if (!trimmedUrl) {
      setMessage("Please enter a GitHub repository URL.");
      setMessageType("error");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/repositories", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: trimmedUrl,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage(data.error || "Unable to submit this repository.");
        setMessageType("error");
        return;
      }

      setRepositoryUrl("");

      setMessage(data.message || "Repository submitted successfully.");
      setMessageType("success");

      // Refresh the dashboard once real repository data is connected.
      router.refresh();
    } catch {
      setMessage("Unable to reach the server. Please try again.");
      setMessageType("error");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="rounded-2xl border border-stone-800 bg-stone-900/70 p-6">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-stone-100">
          Investigate a repository
        </h2>

        <p className="mt-1 text-sm leading-6 text-stone-400">
          Connect a public GitHub repository to start exploring its structure
          and codebase.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="repository-url"
            className="mb-2 block text-sm font-medium text-stone-300"
          >
            GitHub repository URL
          </label>

          <input
            id="repository-url"
            type="url"
            placeholder="https://github.com/owner/repository"
            value={repositoryUrl}
            onChange={(event) => setRepositoryUrl(event.target.value)}
            disabled={isSubmitting}
            required
            className="w-full rounded-xl border border-stone-700 bg-stone-950 px-4 py-3 text-sm text-stone-100 outline-none transition placeholder:text-stone-600 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 disabled:opacity-60"
          />

          <p className="mt-2 text-xs text-stone-500">
            Only public GitHub repositories are supported in this version.
          </p>
        </div>

        <button
          type="submit"
          disabled={isSubmitting || !repositoryUrl.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-orange-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              Submitting...
            </>
          ) : (
            <>
              <span aria-hidden="true">+</span>
              Add repository
            </>
          )}
        </button>

        {message && (
          <div
            role="status"
            aria-live="polite"
            className={`rounded-xl border px-4 py-3 text-sm ${
              messageType === "success"
                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                : "border-red-500/20 bg-red-500/10 text-red-400"
            }`}
          >
            {message}
          </div>
        )}
      </form>
    </section>
  );
}
