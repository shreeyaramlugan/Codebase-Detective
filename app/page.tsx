export default function HomePage() {
  return (
    <main className="min-h-screen bg-stone-950 px-6 py-16 text-stone-100">
      <div className="mx-auto max-w-4xl">
        <p className="text-sm font-medium text-orange-400">
          CODEBASE DETECTIVE
        </p>

        <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-6xl">
          Understand the code.
          <br />
          See what changes.
        </h1>

        <p className="mt-6 max-w-2xl text-stone-300">
          Explore repository structure, trace dependencies, and discover
          evidence-backed explanations of how a codebase works.
        </p>

        <div className="mt-10 rounded-xl border border-stone-800 bg-stone-900 p-6">
          <h2 className="text-lg font-semibold">
            Your investigation starts here.
          </h2>
          <p className="mt-2 text-sm text-stone-400">
            Repository ingestion and analysis are coming next.
          </p>
        </div>
      </div>
    </main>
  );
}
