// app/dashboard/page.tsx
import { Suspense } from "react";
import { redirect } from "next/navigation";

import OverviewStats from "@/components/dashboard/OverviewStats";
import RepositoryOverview from "@/components/dashboard/RepositoryOverview";
import RecentActivity from "@/components/dashboard/RecentActivity";
import RepositorySubmission from "@/components/dashboard/RepositorySubmission";

import { prisma } from "@/lib/db/prisma";
import { getCurrentSession } from "@/lib/auth/session";
import { toSnapshotSummaryView } from "@/lib/ingestion/source-content/source-content.service";

async function DashboardContent() {
  const session = await getCurrentSession();

  if (!session) {
    redirect("/sign-in");
  }

  const databaseRepositories = await prisma.repository.findMany({
    where: {
      ownerId: session.user.id,
    },
    include: {
      indexingJobs: {
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
      },
      snapshots: {
        orderBy: {
          createdAt: "desc",
        },
        take: 5,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const now = new Date();

  const repositories = databaseRepositories.map((repository) => {
    const latestJob = repository.indexingJobs[0] ?? null;

    let analysisStatus:
      | "not_started"
      | "queued"
      | "processing"
      | "completed"
      | "partial"
      | "failed";

    switch (repository.status) {
      case "QUEUED":
        analysisStatus = "queued";
        break;
      case "INDEXING":
        analysisStatus = "processing";
        break;
      case "INDEXED":
        analysisStatus = "completed";
        break;
      case "PARTIALLY_INDEXED":
        analysisStatus = "partial";
        break;
      case "FAILED":
        analysisStatus = "failed";
        break;
      case "SUBMITTED":
      default:
        analysisStatus = "not_started";
    }

    const retryAvailable =
      latestJob?.status === "FAILED" &&
      latestJob.attempts < latestJob.maxAttempts &&
      (!latestJob.nextRetryAt || latestJob.nextRetryAt <= now);

    return {
      id: repository.id,
      name: repository.name,
      owner: repository.ownerLogin,
      description: repository.description,
      htmlUrl: repository.htmlUrl,
      visibility:
        repository.visibility.toLowerCase() === "public"
          ? ("public" as const)
          : ("private" as const),
      defaultBranch: repository.defaultBranch,
      updatedAt: repository.updatedAt.toISOString(),
      analysisStatus,
      snapshots: repository.snapshots.map(toSnapshotSummaryView),
      latestJob: latestJob
        ? {
            id: latestJob.id,
            status: latestJob.status,
            attempts: latestJob.attempts,
            maxAttempts: latestJob.maxAttempts,
            errorCode: latestJob.errorCode,
            errorMessage: latestJob.errorMessage,
            nextRetryAt: latestJob.nextRetryAt?.toISOString() ?? null,
            retryAvailable,
          }
        : null,
    };
  });

  const activeJobs = repositories.filter(
    (repository) =>
      repository.latestJob?.status === "PENDING" ||
      repository.latestJob?.status === "PROCESSING",
  ).length;

  const completedAnalyses = repositories.filter(
    (repository) =>
      repository.analysisStatus === "completed" ||
      repository.analysisStatus === "partial",
  ).length;

  return (
    <div className="space-y-10">
      <OverviewStats
        repositories={repositories.length}
        analyses={completedAnalyses}
        findings={null}
        activeJobs={activeJobs}
      />

      <RepositorySubmission />

      <RepositoryOverview repositories={repositories} />

      <RecentActivity activities={[]} />
    </div>
  );
}

function DashboardLoading() {
  return (
    <div className="animate-pulse space-y-10">
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
