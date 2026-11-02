import type { ReactNode } from "react";
import { Suspense } from "react";
import { redirect } from "next/navigation";

import { getCurrentSession } from "@/lib/auth/session";
import DashboardShell from "@/components/dashboard/DashboardShell";

async function DashboardAuthBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const session = await getCurrentSession();

  if (!session) {
    redirect("/auth/sign-in");
  }

  return (
    <DashboardShell
      user={{
        name: session.user.name ?? "Detective",
        email: session.user.email,
      }}
    >
      {children}
    </DashboardShell>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-stone-950 text-stone-300">
          <div className="text-center">
            <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-stone-700 border-t-orange-500" />
            <p className="text-sm">Loading your investigation workspace...</p>
          </div>
        </main>
      }
    >
      <DashboardAuthBoundary>{children}</DashboardAuthBoundary>
    </Suspense>
  );
}