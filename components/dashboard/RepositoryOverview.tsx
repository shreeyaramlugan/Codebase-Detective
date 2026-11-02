
export type Repository = {
  id: string;
  name: string;
  owner: string;
  description: string | null;
  visibility: "public" | "private";
  defaultBranch: string | null;
  updatedAt: string | null;
  analysisStatus:
    | "not_started"
    | "queued"
    | "processing"
    | "completed"
    | "failed";
};

type RepositoryOverviewProps = {
  repositories: Repository[] | null;
};

function formatDate(date: string | null) {
  if (!date) return "Not available";

  const parsedDate = new Date(date);

  if (Number.isNaN(parsedDate.getTime())) {
    return "Not available";
  }

  return new Intl.DateTimeFormat("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsedDate);
}

function getStatus(status: Repository["analysisStatus"]) {
  switch (status) {
    case "queued":
      return {
        label: "Queued",
        style: "bg-amber-500/10 text-amber-400 border-amber-500/20",
      };

    case "processing":
      return {
        label: "Processing",
        style: "bg-blue-500/10 text-blue-400 border-blue-500/20",
      };

    case "completed":
      return {
        label: "Completed",
        style: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
      };

    case "failed":
      return {
        label: "Failed",
        style: "bg-red-500/10 text-red-400 border-red-500/20",
      };

    default:
      return {
        label: "Not analysed",
        style: "bg-stone-500/10 text-stone-400 border-stone-500/20",
      };
  }
}

export default function RepositoryOverview({
  repositories,
}: RepositoryOverviewProps) {
  const isLoading = repositories === null;
  const hasRepositories =
    repositories !== null && repositories.length > 0;

  return (
    <section aria-labelledby="repository-overview-heading">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
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

        <span className="rounded-full border border-stone-700 bg-stone-900 px-3 py-1 text-xs text-stone-400">
          {isLoading
            ? "Loading"
            : `${repositories.length} connected`}
        </span>
      </div>

      {isLoading ? (
        <div
          className="rounded-2xl border border-stone-800 bg-stone-900/60 p-8 text-center"
          aria-live="polite"
        >
          <p className="text-sm text-stone-400">
            Repository data is not connected yet.
          </p>
        </div>
      ) : !hasRepositories ? (
        <div className="rounded-2xl border border-dashed border-stone-700 bg-stone-900/40 px-6 py-12 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-stone-700 bg-stone-900">
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-7 w-7 text-stone-400"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.69c-2.78.6-3.37-1.18-3.37-1.18-.45-1.15-1.11-1.45-1.11-1.45-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.82.09-.65.35-1.08.63-1.33-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.28.1-2.66 0 0 .84-.27 2.75 1.03A9.57 9.57 0 0 1 12 6.98a9.6 9.6 0 0 1 2.5.34c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.41.1 2.66.64.7 1.03 1.6 1.03 2.69 0 3.85-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.59c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"
                clipRule="evenodd"
              />
            </svg>
          </div>

          <h3 className="mt-5 text-lg font-semibold text-stone-100">
            No repositories yet
          </h3>

          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-stone-400">
            Your investigations will appear here once you connect
            a GitHub repository. Start with a repository you own
            or one you have permission to access.
          </p>

          <div className="mx-auto mt-5 inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-500/10 px-3 py-2 text-xs font-medium text-orange-300">
            <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />
            Repository submission is coming in Sprint 01.5
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {repositories.map((repository) => {
            const status = getStatus(repository.analysisStatus);

            return (
              <article
                key={repository.id}
                className="rounded-2xl border border-stone-800 bg-stone-900/70 p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold text-stone-100">
                      {repository.name}
                    </h3>

                    <p className="mt-1 truncate text-xs text-stone-500">
                      {repository.owner}/{repository.name}
                    </p>
                  </div>

                  <span
                    className={`rounded-full border px-2.5 py-1 text-xs ${status.style}`}
                  >
                    {status.label}
                  </span>
                </div>

                {repository.description && (
                  <p className="mt-4 line-clamp-2 text-sm text-stone-400">
                    {repository.description}
                  </p>
                )}

                <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 border-t border-stone-800 pt-4 text-xs text-stone-500">
                  <span>
                    {repository.visibility === "public"
                      ? "Public"
                      : "Private"}
                  </span>

                  <span>
                    Branch: {repository.defaultBranch ?? "Unknown"}
                  </span>

                  <span>
                    Updated: {formatDate(repository.updatedAt)}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
