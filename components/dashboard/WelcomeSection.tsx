type WelcomeSectionProps = {
  name: string;
  email: string;
};

export default function WelcomeSection({ name, email }: WelcomeSectionProps) {
  const hour = new Date().getHours();

  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const firstName = name.trim().split(/\s+/)[0] || "Detective";

  return (
    <section className="space-y-6">
      {/* Welcome heading */}
      <div>
        <p className="text-sm font-medium text-orange-400">
          YOUR INVESTIGATION WORKSPACE
        </p>

        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-100 sm:text-4xl">
          {greeting}, {firstName}.
        </h1>

        <p className="mt-3 max-w-2xl text-sm leading-6 text-stone-400 sm:text-base">
          Welcome to Codebase Detective. Your workspace is ready. Investigate
          repositories, explore code relationships, uncover issues and
          understand how your codebase works.
        </p>
      </div>

      {/* Getting started card */}
      <div className="relative overflow-hidden rounded-2xl border border-orange-500/20 bg-gradient-to-br from-orange-500/10 via-stone-900 to-stone-900 p-5 sm:p-6">
        <div className="relative z-10 max-w-2xl">
          <span className="rounded-full border border-orange-500/30 bg-orange-500/10 px-2.5 py-1 text-xs font-medium text-orange-300">
            GETTING STARTED
          </span>

          <h2 className="mt-4 text-xl font-semibold text-stone-100">
            Every investigation starts with a repository.
          </h2>

          <p className="mt-2 text-sm leading-6 text-stone-400">
            Connect a GitHub repository to begin exploring its structure,
            dependencies and potential issues.
          </p>

          <div className="mt-5 flex items-center gap-2 text-xs text-stone-500">
            <span className="h-2 w-2 rounded-full bg-orange-400" />
            Add a repository to start your investigation.
          </div>
        </div>

        <div className="pointer-events-none absolute -right-8 -top-8 opacity-10">
          <svg
            width="190"
            height="190"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="0.6"
            className="text-orange-300"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
            <path d="M8 11h6M11 8v6" />
          </svg>
        </div>
      </div>
    </section>
  );
}
