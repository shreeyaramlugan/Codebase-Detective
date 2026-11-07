// components/dashboard/DashboardShell.tsx
"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import DashboardSidebar from "@/components/dashboard/DashboardSidebar";
import DashboardHeader from "@/components/dashboard/DashboardHeader";
import WelcomeSection from "@/components/dashboard/WelcomeSection";
type DashboardShellProps = {
  user: {
    name: string;
    email: string;
  };
  children: React.ReactNode;
};

export default function DashboardShell({
  user,
  children,
}: DashboardShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  // The welcome banner belongs to the dashboard home only; the explorer needs
  // the vertical space.
  const showWelcome = pathname === "/dashboard";
  const wide = pathname.startsWith("/dashboard/repositories/");

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100">
      <DashboardSidebar
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />

      <div className="min-h-screen lg:pl-64">
        <DashboardHeader
          name={user.name}
          email={user.email}
          onMenuClick={() => setMobileOpen(true)}
        />

        <main
          className={`mx-auto w-full space-y-10 px-4 py-8 sm:px-6 lg:px-8 ${
            wide ? "max-w-[96rem]" : "max-w-7xl"
          }`}
        >
          {showWelcome && (
            <WelcomeSection name={user.name} email={user.email} />
          )}

          {children}
        </main>
      </div>
    </div>
  );
}
