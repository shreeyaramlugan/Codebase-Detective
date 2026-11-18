<!-- docs/sprints/sprint-08.md -->
# Sprint 08 — Production Worker and Infrastructure

**Status:** Complete

## Objective

Move long-running work out of web requests into a reliable, observable worker process that survives restarts and failures.

## Delivered

- **Durable queue.** The Sprint 01 job table became a PostgreSQL-backed queue with atomic claiming, worker ownership, heartbeats, deduplication keys, bounded retries with exponential back-off (30 seconds to 15 minutes), stale-job recovery and graceful release on shutdown.
- **Worker process.** `npm run worker` starts a separate TypeScript process with validated configuration, a database lifecycle, structured JSON logs with correlation identifiers, and `/healthz` and `/readyz` endpoints.
- **Pipeline integration.** Job types for repository ingestion, code analysis, findings generation, research discovery and research synthesis. Existing services are invoked, not duplicated. API routes enqueue work and return `202 Accepted`, and the interface polls job status.
- **Automatic chaining.** A successful ingestion queues analysis for the new snapshot.
- **Reliability.** Retryable and permanent failures are distinguished, provider retry hints are respected, and repeated execution does not create duplicate snapshots, analyses or findings.
- **Resource and security controls.** Concurrency, per-job timeouts, payload validation, ownership checks at job creation, and logs that never contain secrets or source content.
- **Operations.** Queue statistics, safe inspection of failed jobs and permission-protected retries.

## Hardening after first use

Longer database transaction timeouts for slow remote databases, optional `GITHUB_TOKEN` support for the GitHub rate limit, and clearer ingestion failure logging with a cause code and a safe detail.

## Decisions locked

A database-backed queue before any paid queue service. The Sprint 01 job model was extended rather than replaced.

## Verification

Worker lifecycle, claiming, concurrency, retry, recovery, handler, configuration, security and logging tests, plus integration tests against a real database.

## Handover

Sprint 09 deploys the web application and the worker as separate services.
