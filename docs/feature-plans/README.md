# Technical feature plans

**Complexity: 3 — Detailed.** Include the technical depth needed to assess and
implement a design: contracts, state transitions, alternatives, tradeoffs,
constraints, migration steps and acceptance criteria. Existing detailed designs
may live here too; distinguish them from proposed or unfinished work.

**Audience:** engineers and technical reviewers planning implementation.

Use this folder for detailed feature specifications, technical improvements,
architecture decisions and migration plans.

A plan should explain:

1. The problem, intended user behavior and success criteria.
2. Current implementation and supporting evidence.
3. Scope and explicit exclusions.
4. Proposed architecture, contracts and platform responsibilities.
5. State transitions, errors, security and recovery where applicable.
6. Implementation steps, dependencies and rollout or migration needs.
7. Tests, acceptance criteria and open decisions.

Identify the owner when known, status (`draft`, `approved`, `in progress`,
`implemented` or `superseded`), and last review date. Link to implementation and
verification evidence when complete; a completed plan is not automatically a
current description of the system.

Debugging details belong in [Internal](../internal/README.md).
Instructions for running the delivered feature belong in
[App guide](../app-guide/README.md).

## Plans

- [Landing-only AWS deployment](LANDING_AWS_DEPLOYMENT_PLAN.md): approved S3/CloudFront/ACM architecture; implementation prepared, with provisioning/publication and launch inputs pending.

- [AWS production deployment plan](AWS_DEPLOYMENT_PLAN.md): cost-conscious, production-facing hackathon proposal; single-server options, repository constraints, migration and open decisions; not provisioned or approved.

- [Swap architecture](SWAP_ARCHITECTURE.md): implemented ownership map, with [contracts](SWAP_CONTRACTS.md) and [persistence/recovery](SWAP_PERSISTENCE.md) references.

- [Aurora swap flow](AURORA_SWAP_FLOW.md): current buy/private-sell prose and provider responsibilities; retained diagrams show historical examples and are deferred for visual updates.

| Document                                                          | Role                                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Shared iOS/Android portfolio](GIZU-1_IOS_MONAD_PORTFOLIO.md)     | Historical GIZU-1 scope and dated implementation evidence; links to the current portfolio contract. |
| [Confidential Earn integration](../internal/CONFIDENTIAL_EARN.md) | Current integration behavior and verification boundaries.                                           |
| [Product capabilities and parity](PARITY.md)                      | Supporting capability reference; not a future-work backlog.                                         |

Moving a document here does not reopen completed work or approve a proposal.
Check each document's date, implementation status and current code before planning
new work. Research documents remain under `research/`.
