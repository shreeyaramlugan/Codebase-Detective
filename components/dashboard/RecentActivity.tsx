export type ActivityType =
  | "repository_connected"
  | "analysis_started"
  | "analysis_completed"
  | "analysis_failed"
  | "finding_detected";

export type ActivityItem = {
  id: string;
  type: ActivityType;
  title: string;
  description: string;
  createdAt: string;
};

type RecentActivityProps = {
  activities: ActivityItem[] | null;
};

const activityStyles: Record<
  ActivityType,
  { label: string; icon: string; color: string }
> = {
  repository_connected: {
    label: "Repository",
    icon: "⌘",
    color: "text-orange-400 bg-orange-500/10 border-orange-500/20",
  },
  analysis_started: {
    label: "Analysis started",
    icon: "◷",
    color: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  },
  analysis_completed: {
    label: "Analysis completed",
    icon: "✓",
    color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  },
  analysis_failed: {
    label: "Analysis failed",
    icon: "!",
    color: "text-red-400 bg-red-500/10 border-red-500/20",
  },
  finding_detected: {
    label: "Finding detected",
    icon: "◇",
    color: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  },
};

function formatActivityDate(date: string) {
  const parsedDate = new Date(date);

  if (Number.isNaN(parsedDate.getTime())) {
    return "Date unavailable";
  }

  return new Intl.DateTimeFormat("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsedDate);
}

export default function RecentActivity({ activities }: RecentActivityProps) {
  const isLoading = activities === null;

  const sortedActivities =
    activities === null
      ? []
      : [...activities]
          .sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          )
          .slice(0, 8);

  return (
    <section aria-labelledby="recent-activity-heading">
      <div className="mb-4">
        <h2
          id="recent-activity-heading"
          className="text-lg font-semibold text-stone-100"
        >
          Recent activity
        </h2>

        <p className="mt-1 text-sm text-stone-400">
          Keep track of what&apos;s happening across your investigations.
        </p>
      </div>

      <div className="rounded-2xl border border-stone-800 bg-stone-900/60 p-5">
        {isLoading ? (
          <p className="py-6 text-center text-sm text-stone-400" role="status">
            Loading recent activity...
          </p>
        ) : sortedActivities.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-stone-700 bg-stone-800 text-stone-400">
              <span className="text-xl" aria-hidden="true">
                ◷
              </span>
            </div>

            <h3 className="mt-4 font-medium text-stone-200">No activity yet</h3>

            <p className="mt-2 max-w-sm text-sm leading-6 text-stone-500">
              Your repository submissions, analysis runs and investigation
              updates will appear here.
            </p>
          </div>
        ) : (
          <ol className="divide-y divide-stone-800">
            {sortedActivities.map((activity) => {
              const style = activityStyles[activity.type];

              return (
                <li
                  key={activity.id}
                  className="flex gap-4 py-4 first:pt-0 last:pb-0"
                >
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border text-sm font-semibold ${style.color}`}
                    aria-hidden="true"
                  >
                    {style.icon}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-stone-200">
                        {activity.title}
                      </p>

                      <span className="rounded-full border border-stone-700 px-2 py-0.5 text-[10px] text-stone-500">
                        {style.label}
                      </span>
                    </div>

                    <p className="mt-1 text-sm text-stone-400">
                      {activity.description}
                    </p>

                    <time
                      dateTime={activity.createdAt}
                      className="mt-2 block text-xs text-stone-500"
                    >
                      {formatActivityDate(activity.createdAt)}
                    </time>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
