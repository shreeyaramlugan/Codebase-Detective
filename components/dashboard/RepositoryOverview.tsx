// components/dashboard/RepositoryOverview.tsx
import RepositoryRetryButton from "@/components/dashboard/RepositoryRetryButton";
import RepositoryIngestButton from "@/components/dashboard/RepositoryIngestButton";
import SnapshotHistory, {
  type SnapshotHistoryItem,
} from "@/components/dashboard/SnapshotHistory";

export type Repository = {
  id: string;
  name: string;
  owner: string;
  description: string | null;
  htmlUrl: string;
  visibility: "public" | "private";
  defaultBranch: string | null;
  updatedAt: string | null;
  analysisStatus:
    | "not_started"
    | "queued"
    | "processing"
    | "completed"
    | "partial"
    | "failed";
  snapshots?: SnapshotHistoryItem[];

  latestJob: {
    id: string;
    status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
    attempts: number;
    maxAttempts: number;
    errorCode: string | null;
    errorMessage: string | null;
    nextRetryAt: string | null;
    retryAvailable: boolean;
  } | null;
};

type RepositoryOverviewProps = {
  repositories: Repository[];
};

function formatDate(value: string | null) {
  if (!value) return "Not available";

  return new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function getStatusLabel(status: Repository["analysisStatus"]) {
  switch (status) {
    case "queued":
      return "Queued";
    case "processing":
      return "Processing";
    case "completed":
      return "Indexed";
    case "partial":
      return "Partially indexed";
    case "failed":
      return "Failed";
    default:
      return "Not started";
  }
}

export default function RepositoryOverview({
  repositories,
}: RepositoryOverviewProps) {
  return (
    <section aria-labelledby="repository-overview-heading">
      <div className="mb-5">
        <h2
          id="repository-overview-heading"
          className="text-lg font-semibold text-stone-100"
        >
          Your repositories
        </h2>

        <p className="mt-1 text-sm text-stone-400">
          GitHub repositories connected to your workspace.
        </p>
      </div>

      {repositories.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-700 bg-stone-900/40 p-8 text-center">
          <h3 className="text-base font-semibold text-stone-200">
            No repositories yet
          </h3>

          <p className="mt-2 text-sm text-stone-400">
            Add your first public GitHub repository above to start your
            investigation.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {repositories.map((repository) => {
            const job = repository.latestJob;

            return (
              <article
                key={repository.id}
                className="rounded-2xl border border-stone-800 bg-stone-900/70 p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <a
                      href={repository.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-stone-100 transition-colors hover:text-orange-400"
                    >
                      {repository.owner}/{repository.name}
                    </a>

                    <p className="mt-1 text-xs text-stone-500">
                      {repository.visibility} repository
                      {repository.defaultBranch
                        ? ` · ${repository.defaultBranch}`
                        : ""}
                    </p>
                  </div>

                  <span
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      repository.analysisStatus === "completed"
                        ? "bg-emerald-500/10 text-emerald-400"
                        : repository.analysisStatus === "partial"
                          ? "bg-amber-500/10 text-amber-400"
                          : repository.analysisStatus === "failed"
                            ? "bg-red-500/10 text-red-400"
                            : repository.analysisStatus === "processing"
                              ? "bg-blue-500/10 text-blue-400"
                              : "bg-stone-800 text-stone-300"
                    }`}
                  >
                    {getStatusLabel(repository.analysisStatus)}
                  </span>
                </div>

                {repository.description && (
                  <p className="mt-4 text-sm text-stone-400">
                    {repository.description}
                  </p>
                )}

                <div className="mt-5 border-t border-stone-800 pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-stone-400">
                      Indexing job
                    </span>

                    {job && (
                      <span className="text-xs text-stone-500">
                        Attempt {job.attempts} of {job.maxAttempts}
                      </span>
                    )}
                  </div>

                  <p className="mt-2 text-sm text-stone-300">
                    {job
                      ? job.status.toLowerCase()
                      : "No indexing job recorded"}
                  </p>

                  {job?.status === "FAILED" && (
                    <div className="mt-3 rounded-xl bg-red-500/5 p-3">
                      <p className="text-xs text-red-400">
                        {job.errorMessage || "Indexing failed."}
                      </p>

                      {job.attempts >= job.maxAttempts ? (
                        <p className="mt-2 text-xs text-stone-500">
                          Maximum retry attempts reached.
                        </p>
                      ) : job.nextRetryAt ? (
                        <p className="mt-2 text-xs text-stone-500">
                          Retry available: {formatDate(job.nextRetryAt)}
                        </p>
                      ) : null}

                      {job.retryAvailable && (
                        <div className="mt-3">
                          <RepositoryRetryButton jobId={job.id} />
                        </div>
                      )}
                    </div>
                  )}

                  {job?.status === "COMPLETED" && (
                    <p
                      className={`mt-2 text-xs ${
                        repository.analysisStatus === "partial"
                          ? "text-amber-400"
                          : "text-emerald-400"
                      }`}
                    >
                      {repository.analysisStatus === "partial"
                        ? "Ingestion finished with some files missing."
                        : "Source ingestion completed."}
                    </p>
                  )}

                  {(!job ||
                    job.status === "COMPLETED" ||
                    (job.status === "FAILED" &&
                      job.attempts >= job.maxAttempts)) && (
                    <div className="mt-3">
                      <RepositoryIngestButton
                        repositoryId={repository.id}
                        label={
                          repository.analysisStatus === "partial"
                            ? "Retry failed files"
                            : repository.snapshots &&
                                repository.snapshots.length > 0
                              ? "Re-ingest latest commit"
                              : "Ingest source"
                        }
                      />
                    </div>
                  )}
                </div>

                <div className="mt-4 border-t border-stone-800 pt-4">
                  <span className="text-xs font-medium text-stone-400">
                    Snapshot history
                  </span>

                  <SnapshotHistory snapshots={repository.snapshots ?? []} />
                </div>

                <p className="mt-4 text-xs text-stone-500">
                  Last updated: {formatDate(repository.updatedAt)}
                </p>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
