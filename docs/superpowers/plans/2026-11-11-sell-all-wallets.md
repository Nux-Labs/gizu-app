# Sell all wallet groups implementation plan

> **For agentic workers:** Use superpowers:executing-plans for implementation and one independent final review.

**Goal:** A single Swap action sells the selected token across every eligible locally allocated wallet, matching the existing total-balance estimate.

**Architecture:** Use an opaque `<token>:all` selection validated in the shared native core. One confidential sale journal contains all eligible holder indices, reads balances in bounded RPC batches, skips empty holders, and resumes existing signed work without replaying it. Retain legacy individual batch identifiers for compatibility. Swift and Kotlin use the same confidential plan; JavaScript never supplies wallet indices.

**Tech stack:** React Native/TypeScript, Swift, Kotlin, Rust/UniFFI.

**Spec:** User request in this chat: fix PR #52 selling all wallet groups, retain the total-balance estimate, merge latest main, push the PR branch.

## Constraints

- Preserve native ownership, tracked-token checks, Earn withdrawal exclusions and passkey approval.
- Keep existing buy/legacy sell leg limits and existing persisted journals compatible.
- Keep quote amounts as exact integer strings and explain provider dust limits.
- Do not change generated bindings or deploy/merge the PR.

## Review focus

- More than five holders and incomplete final three-wallet groups must participate.
- Empty wallets must not prevent funded wallets selling; unrelated Earn accounts stay excluded.
- Interrupted work in later groups must retain operation identity and never repeat earlier submissions.
- All-wallet reads must fit existing backend batch/response limits.
- Existing single-batch calls and historical sell plans remain resumable.

## Tasks

1. Merge main; retain Earn header and PR Holdings empty-state assertion. Verify no conflict markers remain.
2. Write failing shared-core tests for all-wallet selection (including partial groups/exclusions), a sale exceeding five holders, bounded reads, and restoring after an earlier wallet has completed. Implement all selection and confidential-only larger holder plans with bounded balance reads. Run Rust suite.
3. Wire Swift/Kotlin native sell startup to all-wallet selection and confidential plans without new receiver allocation; extend platform tests. Wire the form to `<token>:all`, keeping full-balance quote; add rendered regression coverage. Run focused tests first, then full Jest/typecheck/native checks available locally.
4. Update portfolio behavior documentation, independently review the complete fix, address findings, verify final diff, commit and push existing PR branch. Report device/provider verification limits.
