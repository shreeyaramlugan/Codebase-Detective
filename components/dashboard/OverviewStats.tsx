
type OverviewStatsProps = {
  repositories: number | null;
  analyses: number | null;
  findings: number | null;
  activeJobs: number | null;
};

const statistics = [
  {
    key: "repositories",
    label: "Repositories",
    description: "Connected repositories",
    icon: "github",
  },
  {
    key: "analyses",
    label: "Analyses",
    description: "Completed codebase analyses",
    icon: "scan-search",
  },
  {
    key: "findings",
    label: "Findings",
    description: "Deterministic analysis findings",
    icon: "shield-alert",
  },
  {
    key: "activeJobs",
    label: "Active jobs",
    description: "Queued or processing jobs",
    icon: "activity",
  },
] as const;

export default function OverviewStats({
  repositories,
  analyses,
  findings,
  activeJobs,
}: OverviewStatsProps) {
  const values = {
    repositories,
    analyses,
    findings,
    activeJobs,
  };

  return (
    <section aria-labelledby="overview-stats-heading">
      <div className="mb-4">
        <h2
          id="overview-stats-heading"
          className="text-lg font-semibold text-stone-100"
        >
          Workspace overview
        </h2>

        <p className="mt-1 text-sm text-stone-400">
          A summary of your codebase investigations.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {statistics.map((stat) => {
          const value = values[stat.key];

          return (
            <article
              key={stat.key}
              className="rounded-2xl border border-stone-800 bg-stone-900/70 p-5 transition-colors hover:border-stone-700"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-stone-400">
                  {stat.label}
                </span>

                <span className="text-stone-500" aria-hidden="true">
                  {stat.icon === "github" && "⌘"}
                  {stat.icon === "scan-search" && "⌕"}
                  {stat.icon === "shield-alert" && "◇"}
                  {stat.icon === "activity" && "↗"}
                </span>
              </div>

              <div className="mt-5">
                <p
                  className={`text-3xl font-semibold tracking-tight ${
                    value === null
                      ? "text-stone-600"
                      : "text-stone-100"
                  }`}
                  aria-label={
                    value === null
                      ? `${stat.label} data unavailable`
                      : `${value} ${stat.label.toLowerCase()}`
                  }
                >
                  {value === null
                    ? "—"
                    : value.toLocaleString("en-ZA")}
                </p>

                <p className="mt-2 text-xs text-stone-500">
                  {value === null
                    ? "Data source not connected yet"
                    : stat.description}
                </p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
