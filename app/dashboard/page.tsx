
import OverviewStats from "@/components/dashboard/OverviewStats";
import RepositoryOverview from "@/components/dashboard/RepositoryOverview";
import RecentActivity from "@/components/dashboard/RecentActivity";

export default function DashboardPage() {
  return (
    <div className="space-y-10">
      <OverviewStats
        repositories={null}
        analyses={null}
        findings={null}
        activeJobs={null}
      />

      <RepositoryOverview repositories={[]} />

      <RecentActivity activities={[]} />
    </div>
  );
}
