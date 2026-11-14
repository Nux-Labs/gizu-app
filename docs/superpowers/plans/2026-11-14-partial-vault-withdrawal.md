# Requested vault withdrawal implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation with focused independent review before completion.

**Goal:** Withdraw a requested USDG portion to private USDC Account 2 while keeping the remainder invested.

**Architecture:** Extend existing immutable redemption/return proposals and receipt reconciliation with explicit portion/source bindings. A saved UI request allocates the vault-level amount across existing investment wallets; native code retains all financial authority.

**Tech Stack:** React Native/TypeScript, Fastify/viem, Kotlin, Rust native signer.

**Spec:** `docs/superpowers/specs/2026-11-14-partial-vault-withdrawal-design.md`

## Global constraints

Use exact base units; preserve native approval lifetimes and independent read sessions. Account 2 remains the private return destination. No account/history fallback. Old full withdrawals and saved terminal returns stay compatible. Do not send a live financial transaction or deploy AWS; install the hosted production build and prepare backend changes for owner deployment.

## Review focus

- A changed or substituted share amount must not exceed the user-reviewed requested portion.
- Remaining shares must not block its legitimate private return or become a full-exit completion.
- A return must not reuse another redemption's proceeds or use a different wallet/cycle/slot.
- Restart/retry must resume a saved requested portion without duplicating a redemption.
- Old completed returns and pending payouts must retain their existing terminal/recovery behavior.

## Tasks

### 1. Backend portion planning

Files: `backend/src/adapters/earn/robinhood-exit-planner.ts`, `robinhood-vault.ts`, `backend/src/http/routes/earn-planning.routes.ts`; existing exit/fork/route tests.

- [x] Add failing tests for requested assets -> previewWithdraw shares, partial simulation residual, full legacy/Max, over-balance and retained-share proceeds-bounded return.
- [x] Implement optional portion request/response fields, read-only per-owner capacities, exact share selection and gross-proceeds return budget; keep absent-field legacy checks unchanged.
- [x] Run backend focused tests and typechecks.

### 2. Native portion authorization and lifecycle

Files: Rust `core/src/earn_sponsored.rs`; Kotlin `EarnSponsoredEngine`, `EarnSponsoredRpc`, `EarnSponsoredReconciler`, `EarnSponsoredJournal`, `EarnInvestmentPositions`, module bridge; their existing tests.

- [x] Add failing tests for selected-share approval, modified share/asset rejection, retained-share return, source binding/replay, partial receipt status and remaining investment completion.
- [x] Implement strict optional proposal parsing, independently loaded previewRedeem(selected shares), exact selected-share calls, finalized redemption source validation and public portion fields.
- [x] Keep legacy full-share checks and spending approval guards; expose an explicit partial-withdrawal capability.
- [x] Run affected Rust/Kotlin suites and rebuild Android native library from source.

### 3. Amount selection and request recovery

Files: domain/services Robinhood contracts, native bridge, vault screen/controller, withdrawal panel, scoped request storage; functional and adapter tests.

- [x] Add failing functional tests for entering a vault-level amount, Max, multiple wallets, requested-portion completion with remainder, retry and reopening.
- [x] Implement capacity reads, deterministic allocation, saved wallet/profile-scoped selection and request-aware position selection.
- [x] Carry selected amounts/request IDs to plans and native proposals; carry actual redemption ID/proceeds to return plans and proposals. Treat each requested portion as complete without accepting a full-exit proof for remaining assets.
- [x] Preserve historical mode and pending native recovery; run app affected tests and TypeScript/lint.

### 4. Regression, review and installation

- [x] Review affected consumers, run full app/backend/Rust/Kotlin suites, and record all baseline failures.
- [x] Obtain focused independent review of proposal/source bindings and lifecycle/amount recovery; address concrete findings.
- [x] Build release with native hosted mode and api.gizu.io, install preserving data and verify amount UI plus existing balances without signing a live withdrawal.
- [x] Commit/push on the current feat branch without co-author; report backend deployment requirement and actual validation limits.

## Review corrections

Independent native/UI/backend review found and corrected protected-expiry source reuse, repeated-partial gas-reserve depletion, missing amount disclosure in a delegation-first prompt, latest holdings being mistaken for receipt completion, lost-cache retry amount expansion (including native-retired expired records), and a canceled read suppressing its replacement. Tests cover these paths. Legacy pending payouts still use the existing saved-withdrawal controller; completed request IDs are derived from native receipts without creating a full-exit cache proof.

## Validation

- Full app final suite: 112 suites / 1,099 tests passed (including the nonce-cancelled polling regression).
- Full backend: 497 tests, 485 passed, 12 optional skips, zero failures; typecheck passed.
- Full Rust signer: 249 passed. Android native library rebuilt from this source.
- Full Kotlin after retry correction: 579 tests, 572 passed, seven pre-existing deposit-preparer fixture failures (0.099 USDC fixtures below the existing 0.17 routing minimum). The production floor remains unchanged. Final affected native tests also pass after adding the noncanonical-receipt guard.
- Changed mobile TypeScript/TSX ESLint: zero errors/warnings. Mobile and backend typechecks passed.
- Real disposable Robinhood fork: passed at block 113744529, including full and partial redemptions plus source-bounded returns preserving shares. The test uses an explicitly verified fork-only token-balance fixture and a test-only 30-second RPC timeout; production never overrides real balances. Official checksum-verified Anvil v1.8.3 is isolated in /tmp. No live financial transaction was sent.
- Native expiry regressions first reproduced failed same-source retry, duplicate-source admission and skipped late canonical receipt. Same-nonce replacement and canonical nonce-consumption closure now prevent duplicate credit/outflow and false pending state. A noncanonical expired receipt retains its retired status. Replaced/expired attempts exit automatic polling, reload saved progress, and require fresh review of the winning source; approval is never transferred to a different redemption ID. The final functional/service rerun passed 87 tests.

## Delivery

Commit `35db242` was pushed without a co-author. The release was installed preserving app data on 2026-11-14, the owner deployed its backend, and the production capacity endpoint returned HTTP 200. Normal wallet login, live amount selection, available balance and Max were inspected on device. No withdrawal was signed by the agent.

A subsequent owner-initiated full withdrawal revealed incomplete active-return/refund presentation. Its correction and validation are tracked in [withdrawal progress and refunds](2026-11-14-withdrawal-progress-refunds.md), reusing the existing deposit ladder as requested.
