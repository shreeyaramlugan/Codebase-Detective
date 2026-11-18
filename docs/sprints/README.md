<!-- docs/sprints/README.md -->
# Sprint Documentation

Codebase Detective was built in ten sprints. Each sprint has a record of its objective, what was delivered, the decisions it locked, how it was verified and what it handed to the next sprint.

| Sprint | Title | Record |
| --- | --- | --- |
| 00 | Project foundation and infrastructure | [sprint-00.md](sprint-00.md) |
| 01 | Authentication, repositories and durable jobs | [sprint-01.md](sprint-01.md) |
| 02 | GitHub ingestion and repository snapshots | [sprint-02.md](sprint-02.md) |
| 03 | Code intelligence engine | [sprint-03.md](sprint-03.md) |
| 04 | Interactive codebase explorer | [sprint-04.md](sprint-04.md) |
| 05 | Deterministic findings engine | [sprint-05.md](sprint-05.md) |
| 06 | AI investigation assistant | [sprint-06.md](sprint-06.md) |
| 07 | Research engine | [sprint-07.md](sprint-07.md) |
| 08 | Production worker and infrastructure | [sprint-08.md](sprint-08.md) |
| 09 | Deployment and production release | [sprint-09.md](sprint-09.md) |

## How the sprints fit together

```text
00 Foundation
 +-- 01 Users, repositories, durable jobs
      +-- 02 Immutable snapshots of source code
           +-- 03 Deterministic code intelligence
                +-- 04 Explorer (makes 03 visible)
                +-- 05 Findings (rules over 03)
                     +-- 06 AI assistant (explains 02-05)
                     +-- 07 Research (external evidence for 05)
                          +-- 08 Worker (runs 02, 03, 05, 07 reliably)
                               +-- 09 Deployment
```

## Principles that held throughout

- **Deterministic first.** Analysis establishes facts. AI explains them and never invents code structures, findings or citations.
- **Immutable history.** Snapshots, analyses, findings runs and research runs are never overwritten. Failed runs stay inspectable.
- **Honest uncertainty.** Unresolved, ambiguous, possible and partial results are recorded as such and never presented as confirmed.
- **Ownership everywhere.** Every route checks authentication and repository ownership. Cross-user access returns not found.
- **Repository code is never executed.**
- **Acceptance before progress.** A sprint is complete only when its criteria and verification tests pass.
