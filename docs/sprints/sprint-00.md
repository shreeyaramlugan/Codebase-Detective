<!-- docs/sprints/sprint-00.md -->
# Sprint 00 — Project Foundation and Infrastructure

**Status:** Complete

## Objective

Establish the technical base on which every later sprint builds: the application framework, database access, tooling and conventions.

## Delivered

- Next.js (App Router) and TypeScript application with Tailwind CSS styling.
- PostgreSQL database access through Prisma, with migrations.
- Vitest test setup, linting, formatting and TypeScript checking.
- Environment-variable conventions and an `.env.example` reference.
- Version control and project structure conventions used by every later sprint.

## Decisions locked

| Area | Decision |
| --- | --- |
| Language and framework | TypeScript, Next.js App Router, React |
| Database and ORM | PostgreSQL with Prisma |
| Testing | Vitest |
| Hosting direction | Vercel web application with a separate worker (later sprints) |
| Budget | Free-first |

## Handover

Sprint 01 adds authentication, repositories and the durable job lifecycle on this foundation.
