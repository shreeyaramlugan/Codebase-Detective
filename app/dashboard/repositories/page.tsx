// app/dashboard/repositories/page.tsx
import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

export default async function RepositoriesPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/auth/sign-in");

  const repositories = await prisma.repository.findMany({
    where: { ownerId: session.user.id },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      fullName: true,
      description: true,
      defaultBranch: true,
      codeAnalyses: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true, commitSha: true, createdAt: true },
      },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-100">Repositories</h1>
        <p className="mt-1 text-sm text-stone-400">
          Open a repository to explore its files, symbols and dependencies.
        </p>
      </div>

      {repositories.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-700 bg-stone-900/40 p-8 text-center">
          <p className="text-sm font-medium text-stone-200">
            No repositories yet
          </p>
          <p className="mt-1 text-sm text-stone-400">
            Add a repository from the{" "}
            <Link href="/dashboard" className="text-orange-300 hover:underline">
              dashboard
            </Link>{" "}
            to get started.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {repositories.map((repository) => {
            const analysis = repository.codeAnalyses[0];
            return (
              <li key={repository.id}>
                <Link
                  href={`/dashboard/repositories/${encodeURIComponent(repository.id)}`}
                  className="block rounded-2xl border border-stone-800 bg-stone-900/70 p-5 transition hover:border-orange-500/40"
                >
                  <p className="font-semibold text-stone-100">
                    {repository.fullName}
                  </p>
                  {repository.description && (
                    <p className="mt-1 line-clamp-2 text-sm text-stone-400">
                      {repository.description}
                    </p>
                  )}
                  <p className="mt-3 text-xs text-stone-500">
                    {analysis
                      ? `Latest analysis: ${analysis.status.toLowerCase()} · commit ${analysis.commitSha.slice(0, 7)}`
                      : "Not analysed yet"}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
