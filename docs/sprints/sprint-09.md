<!-- docs/sprints/sprint-09.md -->
# Sprint 09 — Deployment and Production Release

**Status:** Complete

## Objective

Run Codebase Detective in production: a hosted web application, a hosted database, durable storage and a separately deployed worker.

## Delivered

- **Hosting.** Vercel for the web application with a `vercel-build` step (`prisma generate`, then `next build`), Neon for PostgreSQL and a container host (Railway) for the worker, using `Dockerfile.worker`. A Fly.io example configuration is included.
- **Durable storage.** An S3-compatible storage adapter with no SDK dependency. Requests are signed with AWS Signature V4. It works with Cloudflare R2, Supabase, Backblaze and AWS S3, verifies SHA-256 on read, and does not put credentials or endpoints into error messages.
- **Two supported modes.** Local storage for a single machine, and S3 storage for hosted deployments, chosen with `SOURCE_STORAGE_PROVIDER`. Local storage in production requires an explicit `ALLOW_LOCAL_STORAGE=true`.
- **Configuration safety.** The worker refuses to start in production with local storage, missing storage settings or a malformed `S3_ENDPOINT`. `npm run check:env -- web|worker` validates a production environment before deployment without printing secret values.
- **Authentication in production.** Trusted origins are derived from the application URL and `TRUSTED_ORIGINS`. Localhost is trusted only outside production.
- **Security headers.** HSTS, frame denial, content-type protection, referrer and permissions policies, and removal of `X-Powered-By`.
- **Failure handling.** A storage failure during ingestion is now recorded on the job with a safe reason instead of leaving the job to be recovered as stale.
- **Release process.** A manual GitHub workflow for forward-only migrations using the direct database URL, with release order, rollback, backup and troubleshooting guidance in [deployment.md](../deployment.md).

## Lessons from the first deployment

- `NEXT_PUBLIC_*` values are embedded at build time, so changing them requires a rebuild.
- `next build` type-checks test files, so `npm run typecheck` must pass before pushing.
- A hosted worker needs a GitHub token, because shared server addresses exhaust the unauthenticated rate limit.
- OpenAlex requires an API key, and Crossref rejects unknown fields in its `select` parameter.
- A worker connected to a database claims that database's jobs, so local workers must use a separate database.

## Not included

A Content-Security-Policy, automatic data-retention policies and migration of existing local-storage snapshots to object storage.

## Verification

Storage adapter, configuration, environment-checker, worker-config and security tests, and a manual production run through registration, ingestion, analysis and research.

## Outcome

The platform runs end to end in production: ingestion, analysis, findings, AI investigation and research, with a recoverable worker and durable storage.
