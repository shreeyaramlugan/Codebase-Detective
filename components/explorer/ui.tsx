// components/explorer/ui.tsx
//
// Small presentational helpers shared by the explorer views.
import type { ReactNode } from "react";

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "info" | "accent";
  title?: string;
}) {
  const tones = {
    neutral: "bg-stone-800 text-stone-300",
    good: "bg-emerald-500/10 text-emerald-400",
    warn: "bg-amber-500/10 text-amber-400",
    bad: "bg-red-500/10 text-red-400",
    info: "bg-blue-500/10 text-blue-400",
    accent: "bg-orange-500/10 text-orange-300",
  } as const;

  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-stone-800 bg-stone-900/70 ${className}`}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-stone-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-stone-200">{title}</h3>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Spinner({ label = "Loading..." }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex items-center gap-3 p-6 text-sm text-stone-400"
    >
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-stone-700 border-t-orange-500" />
      {label}
    </div>
  );
}

export function ErrorBox({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="m-4 rounded-xl border border-red-500/30 bg-red-500/5 p-4"
    >
      <p className="text-sm font-medium text-red-300">Something went wrong</p>
      <p className="mt-1 text-sm text-stone-400">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-lg border border-stone-700 px-3 py-1.5 text-xs text-stone-200 hover:bg-stone-800"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  message,
}: {
  title: string;
  message?: string;
}) {
  return (
    <div className="p-8 text-center">
      <p className="text-sm font-medium text-stone-300">{title}</p>
      {message && <p className="mt-1 text-sm text-stone-500">{message}</p>}
    </div>
  );
}

export const inputClass =
  "w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 placeholder:text-stone-600 focus:border-orange-500/60 focus:outline-none focus:ring-1 focus:ring-orange-500/40";

export function formatBytes(value: number | string | null): string {
  if (value === null) return "-";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatDate(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function kindTone(
  kind: string,
): "neutral" | "good" | "warn" | "bad" | "info" | "accent" {
  switch (kind) {
    case "FUNCTION":
    case "METHOD":
      return "info";
    case "CLASS":
      return "accent";
    case "INTERFACE":
    case "TYPE":
      return "good";
    case "ENUM":
      return "warn";
    default:
      return "neutral";
  }
}

export function resolutionTone(
  resolution: string,
): "neutral" | "good" | "warn" | "bad" | "info" | "accent" {
  switch (resolution) {
    case "CONFIRMED":
    case "RESOLVED":
      return "good";
    case "POSSIBLE":
    case "AMBIGUOUS":
      return "warn";
    case "UNRESOLVED":
      return "bad";
    default:
      return "neutral";
  }
}
