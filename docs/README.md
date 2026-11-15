# Gizu documentation

Documentation is organized by complexity, intended reader and purpose.

| Folder                                   | Complexity        | Expected depth                                                                                            |
| ---------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| [App guide](app-guide/README.md)         | **1 — Simple**    | Practical setup and operating steps, brief explanations and expected results.                             |
| [Internal](internal/README.md)           | **2 — Technical** | How the system works, debugging, implementation boundaries and verification evidence.                     |
| [Feature plans](feature-plans/README.md) | **3 — Detailed**  | Deep technical designs, contracts, alternatives, tradeoffs, implementation steps and acceptance criteria. |

The updated editable [system diagrams](diagrams/Gizu-System-Diagrams-SVG.drawio)
cover the system overview and flows. Shared rendered assets and historical
illustrations live in [images/](images/README.md).

Physical-iPhone testing and AWS deployment/networking are complete
(maintainer-confirmed, 15 November 2026). See the [verification record](internal/NATIVE_SIGNER_VERIFICATION.md#current-maintainer-confirmed-status).

## Where a document belongs

- **How do I run, configure or distribute it?** → `app-guide/`
- **How does it work internally, or why did it fail?** → `internal/`
- **What should we build or change, and how will we validate it?** → `feature-plans/`

Use technical depth and required background to judge complexity, not word count.
When a document mixes levels, keep the simple procedure in `app-guide/` and link
to deeper explanations in `internal/` or detailed designs in `feature-plans/`.
Highly detailed existing designs can also live in `feature-plans/`; label them as
implemented or reference material so placement does not imply pending work.

Keep one canonical document for each topic and link across categories rather than
copying content. Add feature subfolders when needed, such as `internal/swap/` or
`feature-plans/swap/`.

Folder names describe audience and purpose, not access controls. Never store
credentials, private keys, wallet backups or unredacted sensitive logs here.

## Current reference map

- Setup, deployment, signing and passkey configuration guides are in
  [App guide](app-guide/README.md).
- Debugging and implementation references are in [Internal](internal/README.md).
- Technical plans and supporting parity reference are in
  [Feature plans](feature-plans/README.md).
- Research documents remain under `research/`; indexes link to relevant evidence.
- Project/module READMEs and agent instructions remain alongside their code.

Current runtime references are [Confidential Earn](internal/CONFIDENTIAL_EARN.md),
[withdrawals and private returns](internal/CONFIDENTIAL_WITHDRAWALS.md),
[native storage and authorization](internal/NATIVE_SIGNER_STORAGE.md) and
[AWS backend deployment](app-guide/AWS_BACKEND_DEPLOYMENT.md).

The prose was audited against repository source on 14 November 2026. Historical
research, migration proposals and verification records retain their original
dates and evidence limits; they do not define today's app capabilities. Provider
availability remains a runtime observation.
