# Feature Architecture

Codebase Detective uses a modular feature architecture.

## Analysis

Responsible for deterministic source code analysis.

## Research

Responsible for retrieving and managing external technical
and scholarly evidence.

## AI

Responsible for explaining existing findings using
verified evidence.

## Architecture Rules

1. Analysis must work without AI.
2. AI cannot independently create analysis findings.
3. Every finding must have a stable rule ID.
4. Every code finding must reference a source location.
5. External research must retain source metadata.
6. Provider implementations must be replaceable.
7. Repository source code must never be executed.
