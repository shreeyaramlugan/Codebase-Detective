// app/dashboard/repositories/[repositoryId]/loading.tsx
export default function Loading() {
  return (
    <div
      className="animate-pulse space-y-6"
      role="status"
      aria-label="Loading explorer"
    >
      <div className="h-6 w-64 rounded bg-stone-900" />
      <div className="h-10 rounded-lg bg-stone-900" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="h-40 rounded-2xl bg-stone-900" />
        <div className="h-40 rounded-2xl bg-stone-900" />
        <div className="h-40 rounded-2xl bg-stone-900" />
      </div>
    </div>
  );
}
