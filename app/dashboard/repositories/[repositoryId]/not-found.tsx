// app/dashboard/repositories/[repositoryId]/not-found.tsx
import Link from "next/link";

export default function RepositoryNotFound() {
  return (
    <div className="rounded-2xl border border-dashed border-stone-700 bg-stone-900/40 p-10 text-center">
      <h1 className="text-lg font-semibold text-stone-100">
        Repository not found
      </h1>
      <p className="mt-2 text-sm text-stone-400">
        It may have been removed, or it is not part of your workspace.
      </p>
      <Link
        href="/dashboard/repositories"
        className="mt-5 inline-block rounded-lg border border-orange-500/30 px-4 py-2 text-sm text-orange-300 hover:bg-orange-500/10"
      >
        Back to repositories
      </Link>
    </div>
  );
}
