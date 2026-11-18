<!-- docs/sprints/sprint-03.md -->
# Sprint 03 — Code Intelligence Engine

**Status:** Complete

## Objective

Produce a deterministic, non-executing, structured model of a stored snapshot: symbols, imports, exports, dependencies, function calls and a graph.

## Delivered

- Parsing of JavaScript, TypeScript, JSX, TSX, MJS and CJS with the TypeScript Compiler API. Syntax errors become diagnostics and do not stop the analysis.
- Extraction of functions, classes, methods, interfaces, types, variables and enums, with parent-child containment and source locations.
- Import, export, re-export and CommonJS analysis.
- Stable symbol identities, so identical inputs produce identical identifiers and duplicate names in different scopes stay distinct.
- Module resolution: relative imports, extensions, index files, path aliases, package metadata and CommonJS. Each result is `RESOLVED`, `UNRESOLVED`, `AMBIGUOUS` or `EXTERNAL`.
- Static function-call extraction. Confirmed calls (`CALLS`) are kept separate from possible calls (`POSSIBLY_CALLS`), and dynamic calls are never marked as confirmed.
- A dependency graph with validated nodes and edges, and a derived graph JSON read model that can be regenerated from relational records.
- Relational persistence of analyses, symbols, dependencies, calls and diagnostics.
- Immutable analysis runs: every execution creates a new analysis, and failed runs stay inspectable.
- Engine and parser versions recorded for each run, as the foundation for future incremental analysis.
- Authenticated, owner-scoped analysis and result retrieval.

## Decisions locked

| ID | Area | Decision |
| --- | --- | --- |
| S03-D01 | Persistence | Relational records are the source of truth. Graph JSON is a derived read model. |
| S03-D02 | Module resolution | Relative imports, aliases, package metadata and CommonJS |
| S03-D03 | Function calls | Extract static calls and mark uncertain ones |
| S03-D04 | Repeated analysis | Every execution creates a new immutable run |
| S03-D05 | Incremental analysis | Foundation only. Optimisation is later work. |

## Verification

Parser, extraction, symbol registry, resolver, call resolution, graph and end-to-end analysis tests. Fixtures cover circular imports, aliases, CommonJS, re-exports, invalid syntax, partial snapshots and oversized files.

## Handover

Sprint 04 makes this intelligence explorable. Sprint 05 evaluates rules against it.
