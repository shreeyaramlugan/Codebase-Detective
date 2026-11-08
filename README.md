# Codebase Detective

**Investigate codebases. Understand their structure. Discover what matters.**

Codebase Detective is a full-stack codebase investigation platform designed to help developers understand unfamiliar repositories through deterministic code analysis, source-grounded AI explanations and research-backed recommendations.

The project is being developed incrementally as a technically advanced portfolio project using TypeScript, Next.js, PostgreSQL and Prisma.

> **Current development status: Sprint 01 — Repository registration and indexing job management.**

The current indexing processor is a development-only metadata simulation. Actual source-code ingestion, parsing, dependency analysis and findings are planned for subsequent sprints.

---

## Table of Contents

- [Project Overview](#project-overview)
- [Technology Stack](#technology-stack)
- [Current Features](#current-features)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Database Setup](#database-setup)
- [Development Commands](#development-commands)
- [Indexing Job Processing](#indexing-job-processing)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Development Roadmap](#development-roadmap)
- [Security Considerations](#security-considerations)
- [Current Limitations](#current-limitations)

---

## Project Overview

Understanding an unfamiliar codebase can be time-consuming, particularly when a developer needs to identify its architecture, dependencies, important components and potential risks.

Codebase Detective aims to make that investigation easier through:

1. Repository ingestion and source-code indexing.
2. Deterministic AST-based code analysis.
3. Symbol and dependency graph construction.
4. Rule-based code findings.
5. Source-grounded AI explanations.
6. Research-backed recommendations.

The platform prioritises reproducible analysis and traceable evidence rather than relying on AI-generated guesses.

## Technology Stack

| Layer                  | Technology                         |
| ---------------------- | ---------------------------------- |
| Language               | TypeScript                         |
| Frontend               | React                              |
| Framework              | Next.js App Router                 |
| Styling                | Tailwind CSS                       |
| Database               | PostgreSQL                         |
| ORM                    | Prisma                             |
| Authentication         | Better Auth                        |
| Repository provider    | GitHub API                         |
| Testing                | Vitest                             |
| Development processing | tsx                                |
| Hosting plan           | Vercel                             |
| Worker architecture    | Separate persistent worker planned |

## Current Features

### Implemented

- Email/password authentication.
- GitHub OAuth configuration.
- Protected dashboard access.
- Authenticated GitHub repository submission.
- Public repository metadata validation.
- Repository ownership enforcement.
- Duplicate repository detection.
- Transactional repository and indexing-job creation.
- Persistent indexing job records.
- Job lifecycle management:
  - PENDING
  - PROCESSING
  - COMPLETED
  - FAILED
- Retry handling with exponential backoff.
- Maximum attempt enforcement.
- Ownership-protected retry endpoint.
- Dashboard repository status display.
- Retry button with dashboard refresh.
- Development-only metadata processing simulation.

### Planned

- Repository snapshot ingestion.
- Source-code parsing using the TypeScript Compiler API.
- Symbol extraction and indexing.
- Dependency graph construction.
- Deterministic code findings.
- AI-powered explanations grounded in source evidence.
- Research-backed recommendations.
- Advanced codebase investigation features.

---

## Architecture

The application currently follows a modular monolith architecture.

```text
Browser
   |
   v
Next.js Application
   |
   +---- Authentication (Better Auth)
   |
   +---- Dashboard
   |
   +---- API Routes
   |        |
   |        +---- Repository Submission
   |        |
   |        +---- Indexing Job Retry
   |
   +---- Application Services
   |        |
   |        +---- GitHub Validation
   |        |
   |        +---- Job Lifecycle
   |
   +---- Prisma ORM
            |
            v
       PostgreSQL
```

A separate persistent worker will be introduced in a later sprint.

## Getting Started

### Prerequisites

Install the following:

- Node.js
- npm
- Git
- PostgreSQL database (local or hosted)
- GitHub account

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/codebase-detective.git
cd codebase-detective
```

Replace `YOUR_USERNAME` with the GitHub account hosting the project.

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a local environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Populate the required values in `.env`.

Never commit `.env` or expose authentication secrets.

### 4. Configure the database

Create a PostgreSQL database and configure its connection string in `DATABASE_URL`.

Apply migrations:

```bash
npx prisma migrate dev
```

Generate the Prisma Client:

```bash
npx prisma generate
```

Check migration status:

```bash
npx prisma migrate status
```

### 5. Start the development server

```bash
npm run dev
```

Open:

http://localhost:3000

---

## Environment Variables

Create `.env` in the project root.

| Variable               | Description                     |
| ---------------------- | ------------------------------- |
| `DATABASE_URL`         | PostgreSQL connection string    |
| `BETTER_AUTH_SECRET`   | Authentication signing secret   |
| `BETTER_AUTH_URL`      | Better Auth base URL            |
| `NEXT_PUBLIC_APP_URL`  | Application base URL            |
| `GITHUB_CLIENT_ID`     | GitHub OAuth application ID     |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth application secret |
| `AI_PROVIDER`          | AI provider selection           |
| `AI_MODEL`             | Selected AI model               |

### Example configuration

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require"

BETTER_AUTH_SECRET="GENERATE_A_RANDOM_SECRET"
BETTER_AUTH_URL="http://localhost:3000"
NEXT_PUBLIC_APP_URL="http://localhost:3000"

GITHUB_CLIENT_ID="YOUR_GITHUB_CLIENT_ID"
GITHUB_CLIENT_SECRET="YOUR_GITHUB_CLIENT_SECRET"

AI_PROVIDER="mock"
AI_MODEL="mock-v1"
```

The mock AI configuration is a development placeholder. It does not represent a configured production AI provider.

Generate a secure authentication secret rather than using the example value.

---

## Database Setup

The project uses Prisma with PostgreSQL.

Prisma schema:

```text
prisma/schema.prisma
```

Useful commands:

```bash
npx prisma validate
npx prisma generate
npx prisma migrate dev
npx prisma migrate status
```

The current data model includes repository and indexing-job management, alongside authentication-related records.

Database changes should be made through Prisma schema updates and migrations.

---

## Development Commands

| Command                 | Description                        |
| ----------------------- | ---------------------------------- |
| `npm run dev`           | Start Next.js development server   |
| `npm run build`         | Create production build            |
| `npm start`             | Start production server            |
| `npm run lint`          | Run ESLint                         |
| `npm run typecheck`     | Run TypeScript checks              |
| `npm test`              | Run Vitest tests                   |
| `npm run test:watch`    | Run tests in watch mode            |
| `npm run test:coverage` | Generate test coverage             |
| `npm run format`        | Format project files               |
| `npm run format:check`  | Check formatting                   |
| `npm run jobs:process`  | Run development indexing processor |

---

## Indexing Job Processing

Sprint 01 introduces a durable job lifecycle.

### Job lifecycle

```text
Repository Submitted
        |
        v
      PENDING
        |
        v
    PROCESSING
        |
        +----------+
        |          |
        v          v
   COMPLETED     FAILED
                   |
                   v
             Retry Eligible?
                /     \
              Yes      No
               |        |
               v        v
            PENDING   Terminal
```

### Development processor

Run:

```bash
npm run jobs:process
```

The processor:

1. Finds eligible pending indexing jobs.
2. Attempts to claim each job.
3. Validates stored repository metadata.
4. Simulates successful metadata indexing.
5. Updates job and repository status.
6. Records failures and retry eligibility.

**Important:** This is not yet a source-code indexing engine. It does not clone repositories, download source files, execute repository code or perform AST analysis.

The processor is development-only and is blocked in production environments.

A persistent worker with resource controls is planned for Sprint 08.

---

## Testing

Run the complete Vitest suite:

```bash
npm test
```

Run a specific integration test:

```bash
npx vitest run tests/integration/jobs/job-lifecycle.test.ts
```

Run TypeScript checks:

```bash
npm run typecheck
```

Run ESLint:

```bash
npm run lint
```

Run a production build:

```bash
npm run build
```

Sprint 01 integration tests cover job creation, lifecycle transitions, retry eligibility, attempt limits and concurrent job claiming.

---

## Project Structure

```text
codebase-detective/
|
+-- app/
|   +-- api/
|   |   +-- auth/
|   |   +-- health/
|   |   +-- jobs/
|   |   +-- repositories/
|   |
|   +-- auth/
|   +-- dashboard/
|
+-- components/
|   +-- dashboard/
|
+-- lib/
|   +-- auth/
|   +-- db/
|   +-- jobs/
|
+-- prisma/
|   +-- schema.prisma
|   +-- migrations/
|
+-- scripts/
|   +-- process-indexing-jobs.ts
|
+-- tests/
|   +-- integration/
|
+-- .env.example
+-- package.json
+-- tsconfig.json
+-- vitest.config.ts
```

The structure will evolve as additional modules are introduced.

---

## Development Roadmap

The project is divided into ten implementation sprints.

| Sprint    | Focus                                              |
| --------- | -------------------------------------------------- |
| Sprint 00 | Project foundation and infrastructure              |
| Sprint 01 | Authentication, repositories and durable jobs      |
| Sprint 02 | Repository snapshot ingestion                      |
| Sprint 03 | Parsing and symbol indexing                        |
| Sprint 04 | Dependency and relationship analysis               |
| Sprint 05 | Deterministic findings and rules                   |
| Sprint 06 | Source-grounded AI investigation                   |
| Sprint 07 | Research-backed recommendations                    |
| Sprint 08 | Persistent worker and production resource controls |
| Sprint 09 | Deployment, hardening and final release            |

Features will be marked complete only after their acceptance criteria and verification tests pass.

---

## Security Considerations

The project follows these principles:

- Authentication required for protected application routes.
- Repository records are scoped to their owning user.
- Job operations verify repository ownership.
- Repository URLs are validated against the supported GitHub host.
- Repository and job creation use database transactions.
- Duplicate repository submissions are rejected.
- Retry operations enforce job lifecycle and attempt limits.
- Secrets are stored in environment variables, not source code.
- Repository source code will not be executed during indexing.

Additional production security controls will be introduced in later sprints.

---

## Current Limitations

Codebase Detective is actively under development.

At the current Sprint 01 stage:

- Only public GitHub repository registration is supported.
- Repository metadata is validated and stored.
- Indexing jobs are persisted and tracked.
- The development processor performs metadata simulation only.
- Actual source-code parsing is not implemented.
- Dependency graphs are not implemented.
- Deterministic findings are not implemented.
- Production AI investigation is not implemented.
- The persistent production worker is not implemented.
- Production deployment is deferred to Sprint 09.

The dashboard's completed indexing status must not be interpreted as completed code analysis.

---

## Project Philosophy

Codebase Detective is being built around a simple principle:

**Every insight should be explainable, traceable and grounded in evidence.**

The goal is not simply to ask AI what a codebase does. It is to build a system that can investigate the underlying code, identify relationships and explain its conclusions with supporting evidence.

Built with TypeScript, Next.js, PostgreSQL and a healthy amount of curiosity.

## Sprint Tracking

# Sprint 01 — Completion Record

**Sprint:** 01 — Repository Registration and Indexing Job Management  
**Status:** Complete — technical and manual acceptance checks passed  
**Automated tests:** 190 passed across 18 test files

### Delivered

- Email/password and GitHub OAuth authentication.
- Protected dashboard access.
- GitHub repository URL validation and metadata retrieval.
- Repository persistence with ownership enforcement.
- Duplicate repository prevention.
- Atomic repository and indexing-job creation.
- Persistent indexing-job lifecycle management.
- Retry scheduling, attempt limits and failure handling.
- Development-only metadata processing simulation.
- Dashboard repository status and retry integration.
- Integration tests for job lifecycle and concurrency.
- Updated README and environment documentation.

### Verification

- TypeScript: passed.
- ESLint: zero errors; five non-blocking warnings.
- Prisma schema validation: passed.
- Database migrations: up to date.
- Automated tests: 190/190 passed.
- Production build: passed.
- Prettier formatting: passed.
- Manual repository submission: passed.
- Manual duplicate submission: passed.
- Manual retry and dashboard refresh: passed.
- GitHub OAuth login: manually verified.

### Known limitations

The development processor validates repository metadata and simulates successful indexing. It does not yet download source code, parse files, construct dependency graphs or generate deterministic code findings.

These capabilities remain assigned to subsequent sprints.

### Completion decision

Sprint 01 acceptance checks are satisfied. The project is ready to proceed to Sprint 02, subject to the normal project-level review and version-control checkpoint.

### Sprint 02 — GitHub Ingestion & Repository Snapshots

**Status: Complete**

Implemented commit-based GitHub repository ingestion, immutable
repository snapshots, file classification, source storage,
content integrity verification, snapshot completeness tracking,
idempotent retries and owner-protected source retrieval.

### Sprint 03 — Code Intelligence Engine

**Status: Complete**

Implemented the deterministic, non-executing code intelligence engine using the TypeScript Compiler API. The engine parses JavaScript and TypeScript source files, including JSX and TSX, extracts code structures and symbols, resolves module dependencies, identifies statically traceable function calls, and generates a structured dependency graph.

**### Delivered**

- JavaScript, TypeScript, JSX and TSX parsing.
- AST-based extraction of functions, classes, methods, interfaces, types, variables and enums.
- Import, export and CommonJS analysis.
- Source-location tracking for extracted code structures and relationships.
- Stable symbol identification and symbol registry.
- Module resolution supporting relative imports, path aliases, package metadata and CommonJS.
- Explicit handling of resolved, unresolved, ambiguous and external dependencies.
- Static function-call relationship extraction, including uncertain call identification.
- Dependency graph generation with structured nodes, edges and relationship evidence.
- Relational persistence of analysis records, symbols, dependencies and diagnostics.
- Derived, regeneratable graph JSON read model.
- Immutable analysis runs, preserving previous results and failed runs.
- Analysis engine and parser version tracking.
- Foundation for future incremental analysis.
- Authenticated, owner-protected analysis and result retrieval.
- Parser, extraction, resolver, graph, integration and security tests.
- Updated technical documentation and README.

**### Completion decision**

Sprint 03 acceptance criteria are satisfied. The project now has a deterministic code intelligence foundation capable of transforming stored repository snapshots into structured, traceable code representations. The analysis engine does not execute repository code or rely on AI to establish code structures and dependencies.

The project is ready to proceed to Sprint 04, subject to the normal project-level review and version-control checkpoint.
Sprint 04 — Interactive Codebase Explorer

Status: Complete

Implemented the interactive Codebase Explorer, providing a user-facing interface for navigating and investigating repository snapshots and their associated code analysis results. The explorer connects the deterministic code intelligence produced in Sprint 03 to an integrated interface for browsing repository structure, inspecting source code, exploring symbols, visualising dependencies and searching across the codebase.

### Delivered

Repository overview displaying repository metadata, selected snapshots, commit information and analysis status.

Repository statistics covering files, symbols, dependencies and analysis results.

Hierarchical file explorer with nested folder navigation and file selection.

Source code viewer with syntax highlighting and line numbers.

Source navigation using extracted symbol locations.

Symbol explorer for browsing functions, classes, methods, interfaces, types, variables and enums.

Symbol search and filtering by relevant categories.

Symbol details and parent-child relationship navigation.

Interactive dependency graph using React Flow.

Graph navigation with zoom, pan, node selection and relationship inspection.

Graph filtering by node and edge types.

Visual distinction between confirmed and possible function-call relationships.

Handling of unresolved and external dependencies without inventing relationships.

Unified codebase search across files, paths, symbols, modules and exports.

Navigation between search results, source files, symbols and graph entities.

Integration with Sprint 02 repository snapshots and Sprint 03 analysis results.

Owner-protected access to repository and source information.

Handling of loading, empty, partial-analysis and error states.

Integration, navigation, security and regression testing.

Updated technical documentation and README.

### Completion decision

Sprint 04 acceptance criteria are satisfied. The project now provides an interactive interface for exploring repository structure and investigating the code intelligence generated by Sprint 03.

Users can navigate repository files, inspect source code, locate extracted symbols, explore dependency relationships and search across the analysed codebase. The explorer uses persisted analysis results and preserves the distinction between confirmed, possible and unresolved relationships.

The project is ready to proceed to Sprint 05, subject to the normal project-level review and version-control checkpoint.
### Sprint 05 — Deterministic Findings Engine

**Status: Complete**

Implemented the deterministic, rule-based findings engine, extending the code intelligence foundation from Sprint 03 to identify codebase issues and architectural observations. The engine evaluates analysed repository data against versioned rules, generates structured findings, preserves supporting source evidence and provides an interface for investigating findings and tracking changes across repository snapshots.

**### Delivered**

- Deterministic rule engine with structured rule registration and evaluation.
- Stable rule identifiers and version tracking.
- Dependency analysis rules for unresolved internal imports and circular dependencies.
- Unused export detection where supported by available analysis evidence.
- Code complexity metrics and configurable thresholds.
- Structural analysis for empty modules, unusually large modules and repeated patterns.
- Static security indicator rules with evidence-based reporting.
- Structured finding generation with categories, severity and descriptions.
- Finding evidence tracking linked to repository snapshots, analysis runs, files and symbols.
- Relational persistence of findings and supporting evidence.
- Finding deduplication within individual analysis runs.
- Findings dashboard with overview statistics and categorisation.
- Finding search and filtering by severity and category.
- Detailed finding views with supporting evidence and recommendations.
- Navigation from findings to affected source files and locations.
- Snapshot finding comparison.
- Classification of findings as new, persistent or resolved.
- Preservation of finding history across immutable analysis runs.
- Handling of partial analysis results to prevent unsupported resolution claims.
- Authenticated, owner-protected findings and evidence retrieval.
- Rule engine, finding generation, persistence, comparison, integration and security tests.
- Updated technical documentation and README.

**### Completion decision**

Sprint 05 acceptance criteria are satisfied. Codebase Detective can now evaluate analysed repositories using deterministic rules and generate structured, evidence-backed findings.

The platform identifies dependency issues, complexity concerns, structural observations and static security indicators. Findings are traceable to their originating rules, analysis runs and source evidence. The platform also supports investigating findings and tracking how they change across repository snapshots.

The project is ready to proceed to Sprint 06, subject to the normal project-level review and version-control checkpoint.