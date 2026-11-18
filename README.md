# Codebase Detective

**Investigate codebases. Understand their structure. Discover what matters.**

Codebase Detective is a full-stack platform that helps developers understand unfamiliar repositories. It combines deterministic static analysis, rule-based findings, source-grounded AI explanations and research-backed recommendations, so that every conclusion can be traced back to evidence.

Built with TypeScript, Next.js, PostgreSQL and Prisma.

> **Project status: complete (Sprints 00–09).** All planned capabilities, from repository ingestion to production deployment with a separate background worker, are implemented.

---

## Table of Contents

- [Overview](#overview)
- [Key Capabilities](#key-capabilities)
- [Technology Stack](#technology-stack)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Running Modes](#running-modes)
- [Development Commands](#development-commands)
- [Production Deployment](#production-deployment)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Security and Integrity](#security-and-integrity)
- [Limitations](#limitations)
- [Development History](#development-history)
- [Documentation](#documentation)

---

## Overview

Understanding an unfamiliar codebase is slow, particularly when you need to identify its architecture, dependencies, important components and risks. Codebase Detective makes that investigation faster without relying on AI guesswork.

The design follows one principle:

> **Deterministic analysis establishes the facts. AI explains them. Research supports the recommendations. Nothing is invented.**

Each layer builds on the previous one:

1. **Ingestion** stores an immutable, integrity-checked snapshot of a repository at a specific commit.
2. **Code intelligence** parses that snapshot into symbols, dependencies, function calls and a graph, without executing any repository code.
3. **Findings** apply versioned rules to the analysis and attach source evidence to every result.
4. **Investigation** lets users ask questions that are answered from retrieved repository evidence, with validated citations.
5. **Research** gathers official documentation and scholarly sources and produces recommendations that cite both the repository and external evidence.

## Key Capabilities

### Repository ingestion

- Public GitHub repositories, ingested at an exact commit.
- Immutable snapshots with per-file classification, SHA-256 integrity verification and completeness tracking (complete, partial or failed).
- Idempotent retries and safe handling of rate limits, missing files and oversized content.
- Source storage behind a provider-independent interface: local disk for development or any S3-compatible object storage for production.

### Deterministic code intelligence

- JavaScript, TypeScript, JSX, TSX, MJS and CJS parsing with the TypeScript Compiler API.
- Extraction of functions, classes, methods, interfaces, types, variables and enums, with source locations.
- Import, export and CommonJS analysis. Module resolution covers relative imports, path aliases and package metadata, and distinguishes resolved, unresolved, ambiguous and external dependencies.
- Static call relationships, with confirmed and possible calls kept separate.
- Immutable analysis runs and a regeneratable graph read model.

### Interactive explorer

- Repository overview, hierarchical file tree and syntax-highlighted source viewer.
- Symbol explorer, unified search and an interactive dependency graph (React Flow) with filtering.
- Unresolved relationships are never drawn as invented connections.

### Findings engine

- Versioned rules for dependency issues (unresolved imports, cycles, unused exports), complexity, code structure and static security indicators.
- Every finding carries traceable evidence. Security results are reported as indicators, not confirmed vulnerabilities.
- Review status management and comparison across snapshots (new, persistent, resolved) that does not treat partial analyses as resolutions.

### AI investigation assistant

- Provider-independent AI layer with a Google Gemini integration, structured output and automatic retry with an optional fallback model.
- Database-backed evidence retrieval scoped to a repository and snapshot.
- Answers include validated citations that link back to the source viewer, and the assistant states when evidence is insufficient.
- Persistent conversations, daily and per-request usage limits, and prompt-injection safeguards for repository content.

### Research engine

- Discovery from official documentation, Crossref and OpenAlex, with source provenance, publication type and availability (full text, abstract or metadata only) recorded.
- Research can start from a finding or a manual question. Users review sources before recommendations are generated.
- Concise and detailed recommendations with validated repository and external citations, plus a managed lifecycle (save, rename, accept, reject, implemented, archive).
- Immutable research runs with reusable sources, usage limits and protection against prompt injection from external content.

### Production worker and operations

- Durable PostgreSQL-backed job queue with atomic claiming, heartbeats, stale-job recovery, bounded retries with exponential back-off and graceful shutdown.
- Separate worker process with health and readiness endpoints, structured logs and per-job resource limits.
- The web application only enqueues work and returns immediately. Ingestion, analysis, findings and research run in the worker, and analysis starts automatically after a successful ingestion.

## Technology Stack

| Layer | Technology |
| --- | --- |
| Language | TypeScript |
| Framework | Next.js (App Router) and React |
| Styling | Tailwind CSS |
| Database | PostgreSQL (Neon) with Prisma ORM |
| Authentication | Better Auth (email/password and GitHub OAuth) |
| Code analysis | TypeScript Compiler API |
| Graph visualisation | React Flow (`@xyflow/react`) |
| AI | Google Gemini, behind a provider-independent interface |
| Research sources | Official documentation, Crossref, OpenAlex |
| Object storage | Any S3-compatible service (for example Cloudflare R2) |
| Background processing | Dedicated TypeScript worker (`tsx`) |
| Testing | Vitest |
| Hosting | Vercel (web), Railway or another container host (worker) |

## Architecture

```text
Browser
   |
   v
Next.js application (Vercel)
   |-- Authentication (Better Auth)
   |-- Dashboard and explorer UI
   |-- API routes (authenticated, owner-scoped)
   |        |
   |        +--> enqueue job, return 202
   |
   v
PostgreSQL (Neon) <----------------------------+
   ^   durable job queue, analyses, findings,   |
   |   conversations, research                  |
   |                                            |
Background worker (Railway / Docker) -----------+
   |-- Repository ingestion  --> GitHub API
   |-- Code analysis         --> TypeScript Compiler API
   |-- Findings generation
   |-- Research discovery    --> official docs, Crossref, OpenAlex
   |-- Research synthesis    --> Gemini
   |
   v
Object storage (S3-compatible) or local disk
   immutable, hash-verified source files
```

The web application and the worker share the same database and the same storage. A worker never needs a browser session, and a failed worker job never corrupts completed snapshots or analyses.

## Getting Started

### Prerequisites

- Node.js 22 or later and npm
- Git
- A PostgreSQL database (local, or a hosted service such as Neon)
- A GitHub account (for OAuth and API access)

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/codebase-detective.git
cd codebase-detective
npm install
```

### 2. Configure the environment

```bash
cp .env.example .env
```

On Windows PowerShell: `Copy-Item .env.example .env`.

Fill in the values described in [Environment Variables](#environment-variables). Never commit `.env`.

### 3. Prepare the database

```bash
npx prisma migrate dev
npx prisma generate
```

### 4. Start the application and the worker

Use two terminals:

```bash
npm run dev      # web application at http://localhost:3000
npm run worker   # background worker (ingestion, analysis, findings, research)
```

Add a repository in the dashboard. Ingestion, analysis and findings then run in the worker.

## Environment Variables

`.env.example` documents every variable. The essential ones are:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (use the pooled URL for hosted databases) |
| `BETTER_AUTH_SECRET` | Session signing secret (32 or more random characters) |
| `BETTER_AUTH_URL` | Public base URL of the application |
| `NEXT_PUBLIC_APP_URL` | Public base URL used by the browser (set at build time) |
| `TRUSTED_ORIGINS` | Optional extra origins allowed for authentication |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth application |
| `GITHUB_TOKEN` | Raises the GitHub API limit for ingestion; no scopes needed for public repositories |
| `AI_PROVIDER` | `gemini` for real answers, `mock` for development |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | Gemini credentials, model and optional fallback |
| `AI_REQUEST_TIMEOUT_MS` | Provider timeout (60000 recommended) |
| `OPENALEX_API_KEY` | Free OpenAlex key (required by OpenAlex) |
| `RESEARCH_CONTACT_EMAIL` | Identifies the application to Crossref |
| `SOURCE_STORAGE_PROVIDER` | `local` or `s3` |
| `SOURCE_STORAGE_ROOT` | Directory for local storage |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3-compatible object storage |
| `BACKGROUND_EXECUTION` | `worker` in production |
| `WORKER_*`, `LOG_LEVEL` | Worker concurrency, timeouts, health endpoint and logging |

Only `NEXT_PUBLIC_*` variables are exposed to the browser. Keys and secrets are read on the server only.

To validate a production configuration before deploying:

```bash
npm run check:env -- web
npm run check:env -- worker
```

## Running Modes

| | Local or self-hosted (one machine) | Hosted (Vercel plus a worker host) |
| --- | --- | --- |
| Snapshot storage | `SOURCE_STORAGE_PROVIDER=local` | `SOURCE_STORAGE_PROVIDER=s3` |
| Web application | `npm run dev` | Vercel |
| Worker | `npm run worker` on the same machine | Railway, Fly.io or any Docker host |

Two rules keep both modes safe:

- The web application and the worker must see the same storage. Local disk is shared only when both run on one machine, so a hosted deployment must use S3-compatible storage. Running the production build on a single machine with local storage requires `ALLOW_LOCAL_STORAGE=true`.
- Never run a local worker against the production database. Any worker connected to a database claims its queued jobs.

## Development Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run worker` | Start the background worker |
| `npm run worker:dev` | Start the worker with automatic restart |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Run the full test suite |
| `npm run test:coverage` | Run tests with coverage |
| `npm run typecheck` | TypeScript type checking |
| `npm run lint` / `npm run format:check` | Linting and formatting checks |
| `npm run check:env -- web\|worker` | Validate production environment variables |
| `npm run migrate:deploy` | Apply database migrations (production workflow) |

## Production Deployment

The reference deployment uses Vercel for the web application, Neon for PostgreSQL, Cloudflare R2 for snapshot storage and Railway for the worker. The repository includes `Dockerfile.worker`, an example `fly.worker.toml`, a manual GitHub workflow for applying migrations and security headers configured in `next.config.ts`.

Key points:

- Apply migrations with the **direct** (non-pooled) database URL, forwards only. Never reset or push a schema to production.
- Use the same bucket and credentials for the web application and the worker.
- Set `NEXT_PUBLIC_APP_URL` before the build and rebuild after changing it. It is embedded at build time.
- Release order when migrations are included: migrate, deploy the worker, then deploy the web application.
- The web application can be rolled back instantly from Vercel. The worker is rolled back by redeploying the previous image.

The full guide, including the first-release sequence, smoke test, backup and rollback procedures and troubleshooting, is in [docs/deployment.md](docs/deployment.md).

## Testing

```bash
npm test
```

The suite contains more than 1,200 automated tests across unit, integration and security categories, covering parsing and extraction, module resolution, graph construction, the rule engine, findings comparison, the AI assistant and citation validation, the research engine, storage adapters, the job queue and worker lifecycle, and API ownership and isolation.

Some integration tests run against a real PostgreSQL database configured through `DATABASE_URL`. Use a development database for them, never production. Run `npm run typecheck` as well: `npm run build` type-checks test files, and a type error there fails the deployment.

## Project Structure

```text
app/            Next.js routes, pages and API handlers
components/     Shared React components
features/       Domain modules: analysis, code-intelligence, explorer,
                findings, ai, research, repositories
lib/            Services: ingestion, storage, jobs, worker, auth, GitHub,
                research runtime, configuration
worker/         Worker entry point
prisma/         Schema and migrations
rules/          Findings rule definitions
scripts/        Operational scripts (environment checks, job processing)
tests/          Unit, integration and security tests
docs/           Deployment and technical documentation
```

## Security and Integrity

- Every protected route requires authentication. Repositories, snapshots, analyses, findings, conversations and research are scoped to the owning user, and cross-user access returns not found.
- Repository source code is analysed statically and is never executed.
- Source files are verified against SHA-256 hashes on read. Corrupt or missing objects produce safe errors.
- Repository content and external documents are treated as untrusted data in AI prompts. Citations and sources must exist in retrieved evidence or they are rejected.
- Secrets exist only in environment variables, are read server-side, and are never written to logs. Tests check that client code never references AI or storage credentials.
- Error responses do not expose internal details, storage paths or credentials.
- Security headers are set on all responses, including HSTS, frame denial and content-type protection. A Content-Security-Policy is not yet configured.
- AI usage, research usage and job workloads are bounded by configurable limits.

## Limitations

- Only public GitHub repositories are supported.
- Analysis covers JavaScript and TypeScript. Other languages are stored but not analysed.
- Static analysis does not resolve dynamic behaviour. Calls and imports that cannot be established are reported as possible, unresolved or ambiguous.
- Security findings are indicators for investigation and are not confirmed vulnerabilities.
- Marking a recommendation as implemented records the user's status. It does not verify any code change.
- Recommendations depend on the sources retrieved. Where only abstracts or metadata were available, the output says so.
- Snapshots created under local storage are not migrated automatically when switching to S3 storage and must be ingested again.
- Third-party services (GitHub, Gemini, Crossref, OpenAlex) apply their own rate limits and terms.

## Development History

The project was built in ten sprints. Each was completed only after its acceptance criteria and verification tests passed.

| Sprint | Focus | Outcome |
| --- | --- | --- |
| 00 | Project foundation and infrastructure | Next.js, Prisma, tooling and conventions |
| 01 | Authentication, repositories and durable jobs | Better Auth, repository registration, persistent job lifecycle with retries |
| 02 | Repository snapshot ingestion | Commit-based ingestion, immutable snapshots, classification, hash-verified storage |
| 03 | Code intelligence engine | Parsing, symbols, module resolution, call relationships, dependency graph |
| 04 | Interactive codebase explorer | File tree, source viewer, symbol explorer, graph and unified search |
| 05 | Deterministic findings engine | Versioned rules, evidence-backed findings, snapshot comparison |
| 06 | AI investigation assistant | Gemini integration, evidence retrieval, validated citations, conversations |
| 07 | Research engine | Official documentation, Crossref and OpenAlex, research-backed recommendations |
| 08 | Production worker | Durable queue, worker process, recovery, health checks, resource controls |
| 09 | Deployment and release | Vercel, Neon, S3-compatible storage, hosted worker, security configuration, documentation |

## Documentation

| Document | Description |
| --- | --- |
| [docs/deployment.md](docs/deployment.md) | Deployment, operations, backup, rollback and troubleshooting |
| [docs/sprints/](docs/sprints/README.md) | A record for each sprint: objective, deliverables, decisions and verification |
| [.env.example](.env.example) | Complete environment variable reference |
| [features/README.md](features/README.md) | Feature module overview |

---

*Every insight should be explainable, traceable and grounded in evidence.*
