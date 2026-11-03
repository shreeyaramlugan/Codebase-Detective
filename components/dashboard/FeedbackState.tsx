type FeedbackStateProps = {
  type: "loading" | "error" | "success" | "info";
  title: string;
  message: string;
};

const styles = {
  loading: {
    container: "border-stone-700 bg-stone-900/60",
    icon: "◷",
    iconColor: "text-stone-300",
    role: "status" as const,
  },
  error: {
    container: "border-red-500/30 bg-red-500/5",
    icon: "!",
    iconColor: "text-red-400",
    role: "alert" as const,
  },
  success: {
    container: "border-emerald-500/30 bg-emerald-500/5",
    icon: "✓",
    iconColor: "text-emerald-400",
    role: "status" as const,
  },
  info: {
    container: "border-blue-500/30 bg-blue-500/5",
    icon: "i",
    iconColor: "text-blue-400",
    role: "status" as const,
  },
};

export default function FeedbackState({
  type,
  title,
  message,
}: FeedbackStateProps) {
  const style = styles[type];

  return (
    <div
      role={style.role}
      className={`flex gap-3 rounded-xl border p-4 ${style.container}`}
    >
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-950/50 font-semibold ${style.iconColor}`}
        aria-hidden="true"
      >
        {style.icon}
      </div>

      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-stone-100">{title}</h3>

        <p className="mt-1 text-sm leading-5 text-stone-400">{message}</p>
      </div>
    </div>
  );
}
