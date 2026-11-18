<!-- docs/sprints/sprint-02.md -->
# Sprint 02 — GitHub Ingestion and Repository Snapshots

**Status:** Complete

## Objective

Retrieve a repository's source code at an exact commit and store it as an immutable, integrity-verified snapshot that later sprints can analyse.

## Delivered

- Commit-based GitHub ingestion: the tree is retrieved for the exact resolved commit, not the branch name.
- Immutable repository snapshots with completeness tracking: complete, partial or failed.
- Classification of every discovered entry with a recorded reason. Sensitive files, dependency directories, binaries and oversized files are skipped and never downloaded.
- Source storage behind a provider-independent interface, with a local-disk adapter for development.
- SHA-256 and size verification of every blob against the tree, and hash verification again on read.
- Idempotent retries: an already complete snapshot is reused, a failed one is cleaned up and re-ingested, and a partial one retries only its failed files.
- Concurrent-claim protection, so two workers cannot ingest the same commit.
- Handling of GitHub rate limits as a retryable condition.
- Owner-protected source retrieval.

## Key design points

- Metadata is written only after the storage write succeeds, and a stored object is removed if the database update fails, so there are no orphaned objects.
- A usable-but-incomplete result is recorded as partial and is never presented as complete.
- Storage keys are random identifiers. Clients never supply storage paths.

## Verification

Acceptance and edge-case tests cover empty and excluded-only repositories, rate limits, missing or mismatched blobs, storage failures, concurrent claims and retries. Integration tests run against a real database.

## Handover

Sprint 03 analyses a stored snapshot by its identifier, using only files marked as stored and hash-verified.
