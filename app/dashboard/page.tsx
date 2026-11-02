
import { Suspense } from "react";
import { redirect } from "next/navigation";

import OverviewStats from "@/components/dashboard/OverviewStats";
import RepositoryOverview from "@/components/dashboard/RepositoryOverview";
import RecentActivity from "@/components/dashboard/RecentActivity";
import RepositorySubmission from "@/components/dashboard/RepositorySubmission";

import { prisma } from "@/lib/db/prisma";
import { getCurrentSession } from "@/lib/auth/session";

async function DashboardContent() {
  const session = await getCurrentSession();

  if (!session) {
    redirect("/sign-in");
  }

  const databaseRepositories = await prisma.repository.findMany({
    where: {
      ownerId: session.user.id,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const repositories = databaseRepositories.map((repository) => ({
    id: repository.id,
    name: repository.name,
    owner: repository.ownerLogin,
    description: repository.description,
    visibility:
      repository.visibility.toLowerCase() === "public"
        ? ("public" as const)
        : ("private" as const),
    defaultBranch: repository.defaultBranch,
    updatedAt: repository.updatedAt.toISOString(),
    analysisStatus: (() => {
      switch (repository.status) {
        case "QUEUED":
          return "queued" as const;
        case "INDEXING":
          return "processing" as const;
        case "INDEXED":
          return "completed" as const;
        case "FAILED":
          return "failed" as const;
        case "SUBMITTED":
        default:
          return "not_started" as const;
      }
    })(),
  }));

  return (
    <div className="space-y-10">
      <OverviewStats
        repositories={repositories.length}
        analyses={null}
        findings={null}
        activeJobs={null}
      />

      <RepositorySubmission />

      <RepositoryOverview repositories={repositories} />

      <RecentActivity activities={[]} />
    </div>
  );
}

function DashboardLoading() {
  return (
    <div className="space-y-10 animate-pulse">
      <div className="h-24 rounded-2xl bg-stone-900" />
      <div className="h-40 rounded-2xl bg-stone-900" />
      <div className="h-64 rounded-2xl bg-stone-900" />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <DashboardContent />
    </Suspense>
  );
}
