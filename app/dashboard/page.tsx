import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";

async function DashboardContent() {
  let session;

  try {
    session = await requireSession();
  } catch {
    redirect("/sign-in");
  }

  return (
    <main className="min-h-screen bg-stone-950 p-8 text-white">
      <h1 className="text-3xl font-bold">
        Welcome, {session.user.name}
      </h1>

      <p className="mt-3 text-stone-400">
        Your Codebase Detective workspace.
      </p>

      <p className="mt-6 text-sm text-orange-400">
        Authentication successful.
      </p>
    </main>
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-stone-950 p-8 text-white">
          Loading your workspace...
        </main>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}