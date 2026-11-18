import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";

import { getCurrentSession } from "@/lib/auth/session";

const primaryButton =
  "inline-flex items-center justify-center rounded-xl bg-orange-500 px-6 py-3 text-sm font-semibold text-stone-950 transition hover:bg-orange-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950";

const secondaryButton =
  "inline-flex items-center justify-center rounded-xl border border-stone-700 px-6 py-3 text-sm font-semibold text-stone-100 transition hover:border-orange-500/60 hover:bg-stone-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950";

const features = [
  {
    title: "Explore the structure",
    body: "Browse files, symbols and modules of any repository snapshot with fast code search.",
  },
  {
    title: "Trace dependencies",
    body: "Follow imports, calls and references across the codebase as an interactive graph.",
  },
  {
    title: "Follow the evidence",
    body: "Findings and AI explanations are backed by the exact source they came from.",
    evidence: true,
  },
];

/** Session-aware actions. Falls back to sign-in / register while loading. */
function GuestActions({ size = "lg" }: { size?: "sm" | "lg" }) {
  const compact = size === "sm";
  return (
    <>
      <Link
        href="/auth/sign-in"
        className={
          compact
            ? "rounded-lg px-3 py-2 text-sm font-medium text-stone-300 transition hover:text-white"
            : secondaryButton
        }
      >
        Sign in
      </Link>
      <Link
        href="/auth/sign-up"
        className={
          compact
            ? "rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-orange-400"
            : primaryButton
        }
      >
        Register
      </Link>
    </>
  );
}

async function AuthActions({ size = "lg" }: { size?: "sm" | "lg" }) {
  const session = await getCurrentSession();

  if (!session) {
    return <GuestActions size={size} />;
  }

  return (
    <Link
      href="/dashboard"
      className={
        size === "sm"
          ? "rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-orange-400"
          : primaryButton
      }
    >
      Open dashboard
    </Link>
  );
}

export default function HomePage() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      {/* Soft teal glow behind the hero */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[34rem] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(0,184,169,0.16),transparent)]"
      />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-3">
          <Image
            src="/logo.png"
            alt=""
            width={36}
            height={36}
            className="rounded-lg bg-white"
            priority
          />
          <span className="text-sm font-semibold tracking-wide text-stone-100">
            Codebase Detective
          </span>
        </Link>

        <nav className="flex items-center gap-2" aria-label="Account">
          <Suspense fallback={<GuestActions size="sm" />}>
            <AuthActions size="sm" />
          </Suspense>
        </nav>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col items-center px-6 pb-20 pt-10 text-center sm:pt-16">
        <div className="rounded-[2rem] bg-white p-3 shadow-[0_0_0_1px_rgba(0,184,169,0.35),0_24px_80px_-20px_rgba(0,184,169,0.45)]">
          <Image
            src="/logo.png"
            alt="Codebase Detective logo: a magnifying glass over a cat holding code brackets"
            width={208}
            height={208}
            className="h-40 w-40 rounded-3xl sm:h-52 sm:w-52"
            priority
          />
        </div>

        <p className="mt-10 text-sm font-semibold uppercase tracking-[0.2em] text-orange-400">
          Codebase Detective
        </p>

        <h1 className="mt-4 max-w-3xl text-4xl font-bold tracking-tight text-white sm:text-6xl">
          Understand the code.
          <br />
          <span className="text-orange-400">See what changes.</span>
        </h1>

        <p className="mt-6 max-w-2xl text-base text-stone-300 sm:text-lg">
          Explore repository structure, trace dependencies, and discover{" "}
          <span className="text-amber-400">evidence-backed</span> explanations
          of how a codebase works.
        </p>

        <div className="mt-10 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
          <Suspense
            fallback={
              <div className="flex flex-col gap-3 sm:flex-row">
                <GuestActions />
              </div>
            }
          >
            <AuthActions />
          </Suspense>
        </div>

        <ul className="mt-20 grid w-full gap-4 text-left sm:grid-cols-3">
          {features.map((feature) => (
            <li
              key={feature.title}
              className="rounded-2xl border border-stone-800 bg-stone-900/70 p-6"
            >
              <span
                aria-hidden
                className={`block h-1 w-8 rounded-full ${
                  feature.evidence ? "bg-amber-400" : "bg-orange-500"
                }`}
              />
              <h2 className="mt-4 text-base font-semibold text-stone-100">
                {feature.title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-stone-400">
                {feature.body}
              </p>
            </li>
          ))}
        </ul>
      </main>

      <footer className="relative z-10 border-t border-stone-800 px-6 py-6 text-center text-xs text-stone-500">
        Codebase Detective
      </footer>
    </div>
  );
}
