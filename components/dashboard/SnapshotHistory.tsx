// components/dashboard/SnapshotHistory.tsx
export type SnapshotHistoryItem = {
  id: string;
  commitSha: string;
  commitMessage: string | null;
  status: string;
  completeness: string | null;
  totalFiles: number;
  eligibleFiles: number;
  storedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  totalBytes: string;
  completedAt: string | null;
  createdAt: string;
};

type SnapshotHistoryProps = {
  snapshots: SnapshotHistoryItem[];
};

function formatBytes(value: string): string {
  const bytes = Number(value);

  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(value: string | null) {
  if (!value) return "In progress";

  return new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function describe(snapshot: SnapshotHistoryItem): {
  label: string;
  className: string;
  note: string | null;
} {
  if (snapshot.status === "COMPLETED" && snapshot.completeness === "COMPLETE") {
    return {
      label: "Complete",
      className: "bg-emerald-500/10 text-emerald-400",
      note: null,
    };
  }

  if (snapshot.status === "COMPLETED" && snapshot.completeness === "PARTIAL") {
    return {
      label: "Partial",
      className: "bg-amber-500/10 text-amber-400",
      note:
        snapshot.failedFiles > 0
          ? `${snapshot.failedFiles} file(s) could not be retrieved. Retry to fetch only those files.`
          : "Some eligible files were skipped because of size limits.",
    };
  }

  if (snapshot.status === "FAILED") {
    return {
      label: "Failed",
      className: "bg-red-500/10 text-red-400",
      note: "No usable source files were stored for this commit.",
    };
  }

  return {
    label: "In progress",
    className: "bg-blue-500/10 text-blue-400",
    note: null,
  };
}

export default function SnapshotHistory({ snapshots }: SnapshotHistoryProps) {
  if (snapshots.length === 0) {
    return (
      <p className="mt-2 text-xs text-stone-500">
        No source snapshots have been created yet.
      </p>
    );
  }

  return (
    <ul className="mt-2 space-y-2" aria-label="Snapshot history">
      {snapshots.map((snapshot) => {
        const state = describe(snapshot);

        return (
          <li
            key={snapshot.id}
            className="rounded-xl border border-stone-800 bg-stone-950/40 p-3"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-xs text-stone-300">
                {snapshot.commitSha.slice(0, 7)}
              </span>

              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${state.className}`}
              >
                {state.label}
              </span>
            </div>

            {snapshot.commitMessage && (
              <p className="mt-1 truncate text-xs text-stone-500">
                {snapshot.commitMessage.split("\n")[0]}
              </p>
            )}

            <p className="mt-2 text-xs text-stone-400">
              {snapshot.storedFiles} stored · {snapshot.skippedFiles} skipped ·{" "}
              {snapshot.failedFiles} failed · {snapshot.totalFiles} discovered ·{" "}
              {formatBytes(snapshot.totalBytes)}
            </p>

            {state.note && (
              <p className="mt-1 text-xs text-stone-500">{state.note}</p>
            )}

            <p className="mt-1 text-xs text-stone-600">
              {formatDate(snapshot.completedAt ?? null)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
