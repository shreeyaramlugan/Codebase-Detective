// app/dashboard/repositories/[repositoryId]/page.tsx
import { notFound, redirect } from "next/navigation";

import ExplorerWorkspace from "@/components/explorer/ExplorerWorkspace";
import { parseExplorerState } from "@/features/explorer/navigation/explorer-url";
import { AnalysisError } from "@/lib/analysis/analysis.errors";
import { getCurrentSession } from "@/lib/auth/session";
import { getRepositoryExplorerOverview } from "@/lib/explorer/explorer.service";

type PageProps = {
  params: Promise<{ repositoryId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function RepositoryExplorerPage({
  params,
  searchParams,
}: PageProps) {
  const session = await getCurrentSession();
  if (!session) redirect("/auth/sign-in");

  const { repositoryId } = await params;
  const state = parseExplorerState(await searchParams);

  try {
    // Ownership is enforced inside the service; a repository that belongs to
    // someone else is indistinguishable from one that does not exist.
    const overview = await getRepositoryExplorerOverview(
      session.user.id,
      repositoryId,
      { analysisId: state.analysis },
    );

    return (
      <ExplorerWorkspace initialOverview={overview} initialState={state} />
    );
  } catch (error) {
    if (error instanceof AnalysisError && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }
}
