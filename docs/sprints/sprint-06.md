<!-- docs/sprints/sprint-06.md -->
# Sprint 06 — AI Investigation Assistant

**Status:** Complete

## Objective

Let users ask questions about a repository and receive answers grounded in retrieved evidence, with citations that can be verified.

## Delivered

- A provider-independent AI interface with a Google Gemini implementation, a mock provider for development and centrally managed configuration. Credentials are read only in the provider factory.
- Database-backed evidence retrieval: source files, documentation, symbols, dependencies, calls and findings, scoped to a repository and snapshot, assembled into a bounded context.
- Repository-specific answers: explanations of files and symbols, cross-file relationships, change-impact questions and explanations of findings.
- Explicit handling of confirmed, possible and unresolved relationships, and of insufficient evidence.
- Citation validation. Citations that do not exist in the retrieved evidence are rejected, and valid ones link to the source viewer.
- Persistent, snapshot-aware conversations with create, rename, archive, restore and delete.
- Daily and per-request usage limits, request timeouts and handling of provider and malformed-response errors.
- Prompt-injection safeguards for repository content.

## Later hardening

Structured output through a response schema, tolerant parsing that still enforces grounding, model configuration through `GEMINI_MODEL`, optional thinking-budget control, and in Sprint 09 an automatic retry with an optional fallback model when the provider is overloaded (HTTP 503 or 429).

## Decisions locked

Gemini as the provider, database-backed retrieval, explicit snapshot switching, inline citations with a references panel, and completed responses rather than streaming.

## Verification

Provider, retrieval, grounding, citation, conversation, usage-limit and security tests, including a test that client code never references provider credentials.

## Handover

Sprint 07 reuses the provider and citation validation for research synthesis.
