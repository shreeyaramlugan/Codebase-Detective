<!-- docs/sprints/sprint-01.md -->
# Sprint 01 — Authentication, Repositories and Durable Jobs

**Status:** Complete. Technical and manual acceptance checks passed. 190 automated tests across 18 files.

## Objective

Let a user sign in, register a public GitHub repository and track a persistent indexing job for it, with correct ownership and failure handling.

## Delivered

- Email/password and GitHub OAuth authentication with Better Auth.
- Protected dashboard access.
- GitHub repository URL validation and metadata retrieval.
- Repository persistence with ownership enforcement and duplicate prevention.
- Atomic creation of a repository and its indexing job in one transaction.
- Persistent job lifecycle: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`.
- Retry scheduling with exponential back-off, maximum attempt enforcement and an ownership-protected retry endpoint.
- Dashboard status display and a retry button.
- A development-only metadata processor that simulated indexing.

## Key design points

- Job state transitions are validated; two callers cannot claim the same job.
- Repository and job creation share one transaction, so neither exists without the other.
- Every job operation verifies repository ownership.

## Verification

TypeScript, ESLint (zero errors), Prisma validation, migrations, production build and Prettier passed. Manual repository submission, duplicate submission, retry and GitHub OAuth login were verified. Integration tests cover the job lifecycle and concurrency.

## Known limitations at the time

The development processor did not download source code. Real ingestion arrived in Sprint 02.

## Handover

Sprint 02 replaces the simulation with real commit-based ingestion on top of this job lifecycle.
