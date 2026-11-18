<!-- docs/sprints/sprint-07.md -->
# Sprint 07 — Research Engine

**Status:** Complete

## Objective

Complement deterministic findings with external technical knowledge, and produce recommendations that cite both repository evidence and verifiable sources.

## Delivered

- A provider-independent research layer with three sources: official documentation, Crossref and OpenAlex.
- Normalised sources that keep canonical URLs, identifiers, publisher, authors, dates and retrieval time. Duplicates are merged on DOI or canonical URL.
- Classification as official documentation, peer-reviewed work, preprint or other scholarly material, and an explicit record of availability: full text, abstract only or metadata only. The system never implies that a full paper was reviewed when it was not.
- Research started by the user, from a supported finding or a manual question. Queries are generated from the finding and its evidence.
- Separate stages: discovery first, then source review by the user, then recommendation generation.
- Recommendations as a concise summary and a detailed report (problem, repository evidence, research basis, proposed change, rationale, benefits, trade-offs, limitations), each with validated repository and external citations.
- A lifecycle for recommendations: save, rename, accept, reject, mark implemented and archive. Marking implemented records the user's status and does not verify the change.
- Immutable research runs with reusable sources and persistent history.
- Per-request, daily, provider and source limits. Retrieved material is treated as untrusted, with prompt-injection safeguards.

## Later hardening

OpenAlex now requires a free API key (`OPENALEX_API_KEY`). Provider failures report their HTTP status. Crossref requests use only documented fields, with a fallback if the field list is rejected.

## Verification

Identity and provider tests, query planning, discovery, synthesis, run service, citation and security tests.

## Handover

Sprint 08 moves discovery and synthesis into background jobs.
