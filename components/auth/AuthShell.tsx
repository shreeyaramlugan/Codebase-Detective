import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";

export const authInputClass =
  "w-full rounded-xl border border-stone-700 bg-stone-950 px-4 py-3 text-sm text-stone-100 placeholder:text-stone-500 transition focus:border-orange-500/60 focus:outline-none focus:ring-2 focus:ring-orange-500/30 disabled:cursor-not-allowed disabled:opacity-50";

export const authPrimaryButtonClass =
  "w-full rounded-xl bg-orange-500 px-4 py-3 text-sm font-semibold text-stone-950 transition hover:bg-orange-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900 disabled:cursor-not-allowed disabled:opacity-50";

export const authSecondaryButtonClass =
  "flex w-full items-center justify-center gap-2 rounded-xl border border-stone-700 px-4 py-3 text-sm font-semibold text-stone-100 transition hover:border-orange-500/60 hover:bg-stone-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900 disabled:cursor-not-allowed disabled:opacity-50";

export function AuthLabel({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-xs font-medium text-stone-300"
    >
      {children}
    </label>
  );
}

export function AuthDivider() {
  return (
    <div className="flex items-center gap-3 text-xs text-stone-500" aria-hidden>
      <span className="h-px flex-1 bg-stone-800" />
      or
      <span className="h-px flex-1 bg-stone-800" />
    </div>
  );
}

export function AuthStatus({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className="mt-5 rounded-xl border border-stone-700 bg-stone-950/60 px-4 py-3 text-sm text-stone-200"
    >
      {message}
    </p>
  );
}

export default function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[28rem] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(0,184,169,0.16),transparent)]"
      />

      <div className="relative z-10 w-full max-w-md">
        <Link
          href="/"
          className="mx-auto mb-8 flex w-fit items-center gap-3"
          aria-label="Codebase Detective home"
        >
          <Image
            src="/logo.png"
            alt=""
            width={44}
            height={44}
            className="rounded-xl bg-white"
            priority
          />
          <span className="text-sm font-semibold tracking-wide text-stone-100">
            Codebase Detective
          </span>
        </Link>

        <div className="rounded-2xl border border-stone-800 bg-stone-900 p-8 shadow-[0_24px_80px_-30px_rgba(0,184,169,0.35)]">
          <span
            aria-hidden
            className="block h-1 w-8 rounded-full bg-orange-500"
          />
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-white">
            {title}
          </h1>
          <p className="mt-2 text-sm text-stone-400">{subtitle}</p>

          {children}
        </div>

        <p className="mt-6 text-center text-sm text-stone-400">{footer}</p>
      </div>
    </main>
  );
}
