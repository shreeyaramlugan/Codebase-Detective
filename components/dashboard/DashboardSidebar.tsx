
"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

type DashboardSidebarProps = {
  mobileOpen: boolean;
  onClose: () => void;
};

const navigation = [
  {
    label: "Overview",
    href: "/dashboard",
    icon: "grid",
  },
  {
    label: "Repositories",
    href: "#",
    upcoming: "01.5",
    icon: "github",
  },
  {
    label: "Code Explorer",
    href: "#",
    upcoming: "03",
    icon: "code",
  },
  {
    label: "Dependency Graph",
    href: "#",
    upcoming: "03",
    icon: "network",
  },
  {
    label: "Findings",
    href: "#",
    upcoming: "05",
    icon: "shield",
  },
];

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    github: (
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    ),
    code: (
      <>
        <path d="m8 17-5-5 5-5" />
        <path d="m16 7 5 5-5 5" />
        <path d="m14 4-4 16" />
      </>
    ),
    network: (
      <>
        <rect x="9" y="2" width="6" height="6" rx="1" />
        <rect x="2" y="16" width="6" height="6" rx="1" />
        <rect x="16" y="16" width="6" height="6" rx="1" />
        <path d="M12 8v4M5 16v-4h14v4" />
      </>
    ),
    shield: (
      <path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" />
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 0 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9H4a1.7 1.7 0 0 1 0-3.4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a1.7 1.7 0 0 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a1.7 1.7 0 0 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 0 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 0 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9Z" />
      </>
    ),
  };

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export default function DashboardSidebar({
  mobileOpen,
  onClose,
}: DashboardSidebarProps) {
  const pathname = usePathname();

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/70 lg:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-stone-800 bg-stone-950 transition-transform duration-200 lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Brand */}
        <div className="flex h-20 items-center justify-between border-b border-stone-800 px-6">
          <Link
            href="/dashboard"
            onClick={onClose}
            className="flex items-center gap-3"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-orange-500/15 text-sm font-bold text-orange-400">
              CD
            </div>

            <div>
              <p className="text-sm font-semibold tracking-wide text-stone-100">
                Codebase Detective
              </p>
              <p className="text-xs text-stone-500">
                Investigation workspace
              </p>
            </div>
          </Link>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-lg p-2 text-stone-400 hover:bg-stone-800 lg:hidden"
          >
            ✕
          </button>
        </div>

        {/* Workspace navigation */}
        <div className="px-4 pt-7">
          <p className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-600">
            Workspace
          </p>

          <nav className="space-y-1" aria-label="Main navigation">
            {navigation.map((item) => {
              const active =
                item.href === "/dashboard"
                  ? pathname === "/dashboard"
                  : false;

              return item.upcoming ? (
                <div
                  key={item.label}
                  aria-disabled="true"
                  title={`Planned for Sprint ${item.upcoming}`}
                  className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-3 text-sm text-stone-600"
                >
                  <NavIcon name={item.icon} />
                  <span className="flex-1">{item.label}</span>
                  <span className="rounded bg-stone-900 px-1.5 py-0.5 text-[10px] text-stone-500">
                    S{item.upcoming}
                  </span>
                </div>
              ) : (
                <Link
                  key={item.label}
                  href={item.href}
                  onClick={onClose}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition ${
                    active
                      ? "border border-orange-500/20 bg-orange-500/10 text-orange-300"
                      : "text-stone-400 hover:bg-stone-900 hover:text-stone-200"
                  }`}
                >
                  <NavIcon name={item.icon} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Bottom navigation */}
        <div className="mt-auto space-y-4 border-t border-stone-800 p-4">
          <div>
            <p className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-600">
              Preferences
            </p>

            <Link
              href="/dashboard/settings"
              onClick={onClose}
              aria-current={
                pathname.startsWith("/dashboard/settings") ? "page" : undefined
              }
              className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition ${
                pathname.startsWith("/dashboard/settings")
                  ? "border border-orange-500/20 bg-orange-500/10 text-orange-300"
                  : "text-stone-400 hover:bg-stone-900 hover:text-stone-200"
              }`}
            >
              <NavIcon name="settings" />
              <span>Settings</span>
            </Link>
          </div>

          {/* Environment notice */}
          <div className="rounded-xl bg-stone-900/70 p-4">
            <p className="text-xs font-medium text-stone-300">
              Investigation engine
            </p>

            <p className="mt-1 text-xs leading-5 text-stone-500">
              Your workspace is ready. Repository analysis features will arrive
              as development progresses.
            </p>

            <div className="mt-3 flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />
              <span className="text-[10px] text-stone-500">
                Development environment
              </span>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
