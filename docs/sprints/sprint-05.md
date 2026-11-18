<!-- docs/sprints/sprint-05.md -->
# Sprint 05 — Deterministic Findings Engine

**Status:** Complete

## Objective

Identify objectively verifiable issues and architectural observations from the analysis, with traceable evidence and without any AI judgement.

## Delivered

- A rule engine with stable rule identifiers, versions, severity policies and rule-level error isolation, so one failing rule does not stop the others.
- Dependency rules: unresolved internal imports (external packages are not flagged), circular dependencies from actual graph edges and unused exports where the analysis supports the conclusion.
- Complexity and structure rules: cyclomatic complexity, large modules, empty modules and repeated structural patterns, with explicit and configurable thresholds.
- Security indicator rules. Results are indicators that warrant attention, never described as confirmed vulnerabilities.
- Findings with categories, severity assigned by the rule, evidence references (file, symbol, location) and recommendations.
- Duplicate prevention within a run, and isolation between runs.
- A findings dashboard with overview counts, search, severity and category filters, detail views and navigation to source.
- Review status management that is independent of whether the rule detected the finding.
- Snapshot comparison that classifies findings as new, persistent or resolved. Missing or partial analyses are not interpreted as resolution.

## Decisions locked

Severity is set by rules, never by AI. Finding status and snapshot-comparison status are separate concepts. Comparison uses stable rule and evidence identity rather than file path alone.

## Verification

Rule tests, determinism tests, evidence integrity, partial-snapshot behaviour, comparison and API ownership tests.

## Handover

Sprint 06 explains findings using their evidence. Sprint 07 offers research for supported findings.
