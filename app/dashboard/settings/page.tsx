
import { getCurrentSession } from "@/lib/auth/session";
import ProfileEditor from "@/components/dashboard/ProfileEditor";

export default async function SettingsPage() {
  const session = await getCurrentSession();

  if (!session) {
    return null;
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8">
      <div>
        <p className="text-sm font-medium text-orange-400">
          WORKSPACE PREFERENCES
        </p>

        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-100">
          Settings
        </h1>

        <p className="mt-2 text-sm leading-6 text-stone-400">
          Manage your account and personalise your Codebase Detective
          workspace.
        </p>
      </div>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-stone-100">
            Profile
          </h2>

          <p className="mt-1 text-sm text-stone-400">
            Update how your identity appears across your workspace.
          </p>
        </div>

        <ProfileEditor
          name={session.user.name ?? "Detective"}
          email={session.user.email}
        />
      </section>
    </div>
  );
}
