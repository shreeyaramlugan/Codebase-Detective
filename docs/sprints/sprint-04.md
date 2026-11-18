<!-- docs/sprints/sprint-04.md -->
# Sprint 04 — Interactive Codebase Explorer

**Status:** Complete

## Objective

Make the analysis results usable: let a user open an analysed repository, browse its structure, read source, find symbols and navigate relationships.

## Delivered

- Repository overview with snapshot, commit and analysis status, and statistics taken from persisted analysis data.
- Hierarchical file explorer with folder navigation and file selection. Skipped and unavailable files are visibly distinct.
- Source viewer with syntax highlighting, line numbers and navigation to specific lines, served only through the authenticated, owner-scoped source service. Source is rendered as text and never executed.
- Symbol explorer with search by name and qualified name, filters by kind and file, and parent-child navigation.
- Interactive dependency graph (React Flow) with zoom, pan, selection, node and edge filters and navigation to source.
- Visual distinction between confirmed and possible calls. Unresolved dependencies are not drawn as invented connections.
- Unified codebase search across files, paths, symbols, modules and exports, with pagination limits.
- Loading, empty, partial-analysis and error states throughout.

## Key design points

- The explorer is a presentation layer. It reuses Sprint 03 data and does not re-run analysis.
- All queries are scoped to one repository and one analysis, so runs are never mixed.

## Verification

Explorer service, file tree, graph view, highlighting, navigation and API route tests, including ownership and generic-error behaviour.

## Handover

Sprint 05 links findings to the source viewer, and Sprint 06 cites source locations that open in it.
