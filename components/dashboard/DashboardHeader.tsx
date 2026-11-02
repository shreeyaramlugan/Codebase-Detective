
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

type DashboardHeaderProps = {
  name: string;
  email: string;
  onMenuClick: () => void;
};

export default function DashboardHeader({
  name,
  email,
  onMenuClick,
}: DashboardHeaderProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");

  async function handleSignOut() {
    setSigningOut(true);
    setError("");

    try {
      const { error: signOutError } = await authClient.signOut();

      if (signOutError) {
        setError(signOutError.message || "Could not sign out.");
        setSigningOut(false);
        return;
      }

      router.replace("/auth/sign-in");
      router.refresh();
    } catch {
      setError("Something went wrong while signing out.");
      setSigningOut(false);
    }
  }

  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <header className="sticky top-0 z-30 border-b border-stone-800 bg-stone-950/90 backdrop-blur-xl">
      <div className="flex h-20 items-center justify-between px-5 sm:px-8">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onMenuClick}
            aria-label="Open navigation"
            className="rounded-lg border border-stone-800 p-2 text-stone-300 hover:bg-stone-900 lg:hidden"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <path
                d="M4 6h16M4 12h16M4 18h16"
                strokeLinecap="round"
              />
            </svg>
          </button>

          <div>
            <p className="text-xs text-stone-500">Workspace / Overview</p>
            <h1 className="mt-1 text-sm font-semibold text-stone-100 sm:text-base">
              Dashboard
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <p className="text-sm font-medium text-stone-200">{name}</p>
            <p className="max-w-48 truncate text-xs text-stone-500">
              {email}
            </p>
          </div>

          <div
            className="flex h-10 w-10 items-center justify-center rounded-full border border-orange-500/30 bg-orange-500/10 text-sm font-semibold text-orange-300"
            aria-label={`Profile for ${name}`}
            title={name}
          >
            {initials || "D"}
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="rounded-lg border border-stone-800 px-3 py-2 text-xs font-medium text-stone-300 transition hover:border-stone-600 hover:bg-stone-900 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
          >
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="border-t border-red-900/50 bg-red-950/30 px-5 py-2 text-xs text-red-300 sm:px-8"
        >
          {error}
        </p>
      )}
    </header>
  );
}
