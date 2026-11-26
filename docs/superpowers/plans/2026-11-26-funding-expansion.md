# Base and Arbitrum Funding Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one chain-abstracted Swap or Earn journey spend USDC held across Monad, Base and Arbitrum, using the existing Account 1 and pooling confirmed credits at Account 2.

**Architecture:** Extend existing funding adapters and native planners with exact source-chain identities. Persist each source's independently reconciled Aurora credit, then pass the approved combined amount into the existing private-funded Earn or Swap path. Preserve downstream execution, distribution, return policy, legacy journals, native authorization and current platform availability.

**Tech Stack:** TypeScript/Fastify/viem/Postgres backend; Rust/UniFFI signer core; Kotlin and Swift native hosts; Expo/React Native; existing Pimlico and Aurora integrations.

**Spec:** [Proposed design and product contract](../specs/2026-11-26-funding-expansion-design.md). Read it before executing this plan; it records the pooling decision, exact assets, known limitations and release gates.

**Feasibility:** [Audit, live evidence and remaining gates](../feasibility/2026-11-26-funding-expansion.md). Base/Arbitrum canonical-private route quotes and public Pimlico token support passed. Existing recovery facilities are reused; a new funding-credit database and standalone Rust pool object are not baseline requirements. Ethereum Earn needs an explicit private-balance handoff adaptation.

## Implementation record — 2026-11-26

Tasks 1–10, including the Ethereum handoff in task 5b, are implemented on
`feat/funding-expansion`. Existing adapters, native grants, parent/child journals,
private payout engines and UI are reused. The additional iOS source ledger fills
the previously missing native reservation boundary. No separate pool service or
credit database was introduced.

The implementation also covers older Monad-only backends, qualification rollback
with signed recovery retained, source-qualified cache invalidation, interrupted
handoff recovery and canonical-private asset validation. Final independent review
reported no remaining actionable P1/P2 issues. Automated results and environment
limits are recorded in
[native signer verification](../../internal/NATIVE_SIGNER_VERIFICATION.md#funding-expansion-verification-2026-11-26).

Task 0's public qualification evidence is recorded. Task 11's documentation,
admission controls and deterministic checks are implemented; its funded provider
and physical-device qualification remains the agreed step before general
enablement. Use the explicit feature-build network opt-in to perform those checks.
No deployment or paid transaction was performed. The checklists below retain the
original procedure and do not claim live checks that were not run.

## Global Constraints

- Work in `feat/funding-expansion`, based on main `23a82ec77bf568b277b01f8d004497798cafcd40`; do not move changes to an unrelated branch.
- Funding networks: Monad `143`, Base `8453`, Arbitrum One `42161`; USDC only, six decimals, exact contracts/asset IDs from the spec.
- Account 1 is `m/44'/60'/0'/0/1` on all funding networks; Account 2 remains the shared confidential owner. Preserve existing eligible Monad return accounts and legacy private-owner recovery.
- Network is visible only within funding. Main balances and downstream actions are chain-abstracted. Internal identity is always chain + token + owner + account index.
- Amounts use integer atoms/decimal strings. The user confirmed that **15 USDC is the total budget, including fees**. Preserve existing fee review and minimum-result rules; do not add fees on top, introduce a net-target mode or silently reduce the requested budget to fit one source.
- This expands source funding and its handoff to private USDC. Reuse existing private-funded Earn/Swap execution and recipient distribution. Sales and investment exits still return to private USDC; public cashout remains the separate explicit Withdraw from Gizu action.
- `/history` is not used. Preserve authenticated bounded balance evidence; ambiguous or unavailable evidence cannot authorize pooled spending.
- Keep keys, signatures and approval enforcement native. Provider credentials remain backend-only. Reuse existing SDKs, grants, journals, distribution and payout engines.
- Signed/uncertain operations require reconciliation. Preserve v1 journals and signed payloads; do not reinterpret them as pooled operations.
- Android guided Earn expands; iOS retains current Earn availability, per the user's explicit answer. Both platforms get the new funding networks and multi-source Swap.
- Respect `mobile/AGENTS.md`; regenerate bindings. Backend Node >=22.22; mobile Node >=24.15 <25/npm 11; pinned Rust 1.94.1 and existing native build tooling.

## Review Focus

- Same Account 1 address on three chains must represent distinct sources; duplicate rows on one chain must not inflate funds. Tests: tasks 1, 3, 8.
- Source debit and private credit observed at different times must not double the balance or available budget. Tests: tasks 4, 5, 8.
- An unrelated private inflow during a pending route must not be claimed beyond the original evidence bounds; uncertainty must remain recoverable. Tests: tasks 4, 6.
- An old app/journal or partial backend rollout must neither expose unsupported networks nor rewrite signed Monad operations. Tests: tasks 2, 6, 7, 9.
- A request affordable only in aggregate must work above iOS's existing 10 USDC limit while respecting per-source gas and downstream minimums. Tests: tasks 3, 7, 10.

## Implementation order and file responsibilities

Execute tasks in dependency order. Task 0 verifies the route assumption before
substantial implementation. Tasks 1–4 establish shared contracts and safe
accounting; tasks 5–7 connect existing native journeys; tasks 8–10 expose the
behavior; task 11 qualifies and releases it. Each task starts with regression
tests and ends with focused verification and a commit on the requested branch.

Existing files are listed below each task. Reuse the existing source planner,
encrypted parent/child journals, source-credit recovery envelopes and operation
coordination. New files are limited to pinned backend source configuration, the
missing iOS source reservations and focused route/test boundaries. Do not add a
standalone Rust pool object, new funding-credit database or global lease system
without first demonstrating an unmet requirement in those existing mechanisms.

### Task 0: Qualify the canonical-private route before building the flow

**Files:** Read the source pins, Aurora gateway and existing provider integration
tests listed in tasks 1–2. Record results in the accompanying design document;
no transaction, production configuration or implementation change is required.

**Interfaces:** Qualification input is the exact source token/chain and canonical
private destination from the spec, not generic USDC. Output is per-network
`qualified`, `unavailable` or `blocked` evidence with timestamp and limitations.

- [x] Verify public RPC chain ID and pinned deployments, supported EntryPoint,
      registry asset identities and documented ERC-20 paymaster support for each
      selected network. This evidence alone does not mark the end-to-end route qualified.
- [x] Check the exact Base/Arbitrum → canonical private asset with Aurora quotes
      through Gizu's deployed proxy. Successful 5- and 10-USDC quotes are recorded
      in the audit. These were unfunded `dry: false` quotes using synthetic
      addresses, not dry previews or settled deposits. Local credentials were not
      needed for these checks. Preserve that distinction in qualification reports.
- [x] Probe a small route input: 0.10-USDC Base was rejected while 5 and 10 USDC
      passed; Arbitrum accepted that small quote. This does not establish a fixed
      minimum or prove source-gas affordability. Route input is principal after
      source gas, not a source budget to which gas can be added later.
- [ ] Qualify actual cold/delegated UserOperation estimates and funded private
      settlement/refund/recovery under task 11. Those are remaining release gates,
      not blockers on source-contract implementation now that quote availability
      has been established.
- [ ] If the exact destination is unsupported, stop this design's route-dependent
      tasks and review the provider result with the user. Do not silently substitute
      another private asset or add a public consolidation bridge.
- [ ] Commit recorded evidence as `docs: qualify funding origins and private routes`.

### Task 1: Pin source identities and version the contracts

**Files**

- Create: `backend/src/adapters/pimlico/funding-chains.ts`.
- Modify: `backend/src/adapters/aurora/assets.ts`, `backend/src/env.schema.ts`.
- Modify: `mobile/modules/gizu-stored-signer/core/src/swap/pins.rs`, `mobile/modules/gizu-stored-signer/core/src/swap/funding.rs`, `mobile/modules/gizu-stored-signer/core/src/source_planner.rs`.
- Modify: `mobile/src/domain/wallet/storedSigner.ts`, `mobile/src/domain/earn/types.ts`, `mobile/src/domain/earn/sourceFunding.ts`, `mobile/src/domain/earn/depositJourney.ts`.
- Test: create `backend/test/adapters/pimlico/funding-chains.test.ts`; extend `backend/test/env.schema.test.ts`; Rust tests beside the affected source.

**Interfaces**

- Backend `FundingChainId = 143 | 8453 | 42161`; `fundingChain(id: number): FundingChain` returns pinned RPC configuration key, exact USDC, Aurora origin asset, six decimals, EntryPoint, delegate and paymaster. Reject other IDs.
- Mirror exact pins in native Rust `FundingChain`; no caller-supplied RPC URLs or arbitrary token/delegate addresses.
- Public `FundingSourceKey = { sourceChainId, token, accountIndex, owner }`; new funding requests/journals are `version: 2`. Existing `chainId` continues to mean the action's destination.
- Preserve the legacy Earn intent's Monad `sourceChainId` semantics for v1. Represent v2 selected sources explicitly as a list; a three-network action cannot be described by repurposing one old chain field.
- Add a capability declaration containing `fundingContractVersion: 2` and supported `fundingChainIds`; old native/backend versions imply Monad-only support.

- [ ] Write `source_identity_distinguishes_same_owner_across_chains`: Account 1/address A on 143, 8453 and 42161 yields three identities; a second A/8453/native-USDC row is rejected. Verify unknown chain, wrong USDC, USDC.e and non-six-decimal inputs fail.
- [ ] Run `cd backend && node --experimental-transform-types --test test/adapters/pimlico/funding-chains.test.ts`; run `cd mobile && npm run stored-signer:test -- source_planner`. Confirm the new assertions fail before changing production behavior.
- [ ] Implement the pinned configuration, native types and additive v2 contracts. Add Arbitrum RPC configuration; reuse existing Base RPC configuration where suitable. Preserve old defaults as explicit Monad v1 decoding, not inferred target-chain behavior.
- [ ] Run focused tests and both packages' `npm run typecheck`. Verify old request fixtures still decode unchanged.
- [ ] Commit as `feat: define versioned multi-chain funding identities`.

### Task 2: Generalize the existing Pimlico and Aurora funding boundaries

**Files**

- Modify: `backend/src/adapters/pimlico/monad-funding.ts`, `backend/src/adapters/pimlico/source-funding.ts`, `backend/src/adapters/evm/gas-policy.ts`, `backend/src/adapters/evm/token-paymaster.ts`.
- Modify: `backend/src/adapters/earn/native-gateway.ts`, `backend/src/adapters/earn/fee-policy.ts`, `backend/src/http/routes/swap.routes.ts`, `backend/src/http/routes/earn-native.routes.ts`, `backend/src/app.ts`.
- Create: `backend/src/http/routes/funding.routes.ts`, `backend/test/http/funding.routes.test.ts`.
- Test: `backend/test/adapters/pimlico/source-funding.test.ts`, `backend/test/adapters/pimlico/source-funding.integration.test.ts`, `backend/test/adapters/evm/gas-policy.test.ts`, `backend/test/adapters/earn/native-gateway.test.ts`, `backend/test/http/swap.routes.test.ts`.

**Interfaces**

- New allowlisted routes: `POST /v1/funding/:chainId/plan`, `/prepare`, `/submit`, `/receipt`. Their schemas reuse existing funding payloads plus v2 source identity; responses bind the selected network and token.
- Existing `/v1/swap/monad/*` and `/v1/earn/monad/funding-plan` remain v1 wrappers with identical behavior and serialized proofs.
- Source quote input separates `originAsset` from fixed canonical `privateAsset`; refund owner is Account 1 on the selected source network. All source proofs include `sourceChainId` and exact origin asset.

- [ ] Add `base_and_arbitrum_use_source_rpc_and_token`, `funding_chain_is_not_swap_target`, and `legacy_monad_proofs_remain_stable`. Assert source 42161 with target 8453 still signs/looks up the UserOperation on 42161. Wrong RPC chain ID, receipt chain and paymaster token fail closed.
- [ ] Run the affected backend test files with `node --experimental-transform-types --test <files>` and confirm the new cases fail.
- [ ] Parameterize the existing watch-only Pimlico adapter rather than copying it per chain. Keep server signing disabled. Preserve code/delegate, nonce, EntryPoint, calldata, allowance and fee-cap checks; derive fees from each chain's estimate, including rollup overhead, rather than a Monad constant.
- [ ] Extend source-chain admission in native quote/binding schemas and the existing native bundler route, not just the new generic funding route. Destination profile admission remains separate.
- [ ] Qualify each exact Aurora origin → canonical private pair in the existing gateway/fee policy. Reject unavailable routes and unqualified fee proofs; never replace the canonical private asset with the origin token ID.
- [ ] Run affected tests, `npm run typecheck` and `npm run gas:check` from `backend/`. Provider integration cases requiring credentials are reported separately, not treated as deterministic passes.
- [ ] Commit as `feat: reuse funding infrastructure on Base and Arbitrum`.

### Task 3: Make native planning and reservations chain-aware

**Files**

- Modify: `mobile/modules/gizu-stored-signer/core/src/source_planner.rs`.
- Modify: `mobile/modules/gizu-stored-signer/android/src/main/java/io/gizu/storedwallet/NativeFundingPlanner.kt`, `FundingReservations.kt`, `SavedSourceReservations.kt`, `WalletDiscoveryRegistry.kt` (same directory); `earn/EarnSponsoredRpc.kt` under that directory for source-qualified chain/token reads and bundler dispatch.
- Test: corresponding `NativeFundingPlannerTest.kt`, `FundingReservationsTest.kt`, `EarnFundingCapacityTest.kt` under `android/src/test/java/io/gizu/storedwallet/`.

**Interfaces**

- Extend `plan_public_source_allocation(registry: String, requested_budget_atoms: String, sources_json: String) -> Result<String, SignerError>` with versioned, chain-qualified input/output; leave v1 decoding intact.
- `NativeFundingPlanner.plan(...)` returns source rows with stable `sourceId` and `FundingSourceKey`. Persist deterministic source order; do not sort solely by account index.
- Reservation v2 key is `(sourceChainId, token, owner)` within wallet generation; bind parent/source operation and gross budget. Version 1 records default to Monad/exact existing USDC.

- [ ] Add `ten_plus_ten_can_budget_fifteen`: balances 10,000,000 on 143 and 10,000,000 on 8453, requested 15,000,000; assert exact gross sum 15,000,000, each debit fits its balance, and gas/reserves reduce principal rather than silently reducing the requested budget. Repeat with 42161.
- [ ] Add tests for private-first allocation, one sufficient public source, cross-source fee/minimum constraints, a dust source that cannot fund its overhead, a reserved source, and legacy Monad returned balances. Test reserving A/8453 does not reserve A/143; concurrent requests cannot overbook either.
- [ ] Run focused Rust tests and Android `NativeFundingPlannerTest`/`FundingReservationsTest` using the native command in task 11; confirm new behavior fails first.
- [ ] Extend existing planner/reservations. Read Account 1 on new networks only; retain existing Monad eligible return accounts. Bound probes and quote requests. Prefer private balance, then one sufficient source using bounded fee estimates, then a deterministic economical split. Register/reserve the full approved source set atomically before signing.
- [ ] Preserve sticky signed reservations across expiry/restart. Resume adopts exact saved chain/token/owner; never moves an old signed operation to a newly cheaper source. Run focused tests to pass.
- [ ] Commit as `feat: allocate funding budgets across source networks`.

### Task 4: Reuse existing journals and credit envelopes for combined funding

**Files**

- Modify: `mobile/modules/gizu-stored-signer/core/src/source_planner.rs` for shared checked amount aggregation, if the existing planner output cannot supply it directly.
- Modify: `mobile/modules/gizu-stored-signer/android/src/main/java/io/gizu/storedwallet/earn/EarnPrivateCredits.kt`, `EarnSponsoredSettlement.kt`, `EarnDepositJournal.kt`; `android/src/main/java/io/gizu/storedwallet/swap/SwapFundingBatch.kt`, `SwapStore.kt`; corresponding existing iOS `Swap/SwapStore.swift` and `SwapEngine.swift`.
- Modify: `backend/src/adapters/aurora/settlement.ts` only for explicit source-origin admission/binding. Reuse `backend/src/adapters/earn/recovery-envelope.ts`, `operation-coordinator.ts` and existing Postgres coordination.
- Test: `backend/test/adapters/aurora/balance-settlement.test.ts`, `backend/test/adapters/aurora/settlement.test.ts`, `backend/test/adapters/postgres/pg-operation-coordination.test.ts`; existing native funding/recovery tests.

**Interfaces**

- Extend existing parent journals with v2 content binding wallet generation, parent ID, feature, Account 2, canonical asset, approved existing-private amount, ordered source keys/budgets, per-source credit bounds, saved action/recipients and fee caps.
- Each existing source child retains its baseline, quote, transaction identity and validated `settlementEnvelope`. Completed child credit is replayed through the existing sealed `source-credit` proof, not re-derived from today's private balance.
- The handoff amount is `approvedExistingPrivateAtoms + sum(uniqueConfirmedChildCredits)` less recorded consumption. Bind that amount and the one downstream child to the parent review/journal. If a shared arithmetic export is needed, extend `source_planner.rs` with `funded_private_amount(approved_existing_private_atoms: String, credits_json: String) -> Result<String, SignerError>`; it validates unique source IDs and checked atom sums. It is arithmetic, not authorization.
- Extend existing pending-credit/payout/private-deposit guards to recognize every new source child and the same parent's handoff. Existing native grants/reservations and immutable operation claims remain authoritative. Do not equate an expiring backend claim with permanent signed-work ownership.

- [ ] Add `next_source_requires_persisted_previous_credit`: B cannot submit or capture its active baseline while A is unresolved; after A's credit is durably saved, B's baseline includes A. Replaying A's exact saved envelope after later spending does not perform a fresh delta attribution. Changed origin/bounds/baseline binding fails.
- [ ] Add `pool_budget_excludes_unrelated_private_funds`: existing private balance 50,000,000, approved private debit 2,000,000, two verified credits 9,900,000 and 4,900,000; spending ceiling is 16,800,000, not 64,800,000. Allocate once; replay cannot spend again.
- [ ] Add over-bound/unrelated inflow, negative delta, missing baseline, route pending/refunded, process death and expired-auth tests. Duplicate source IDs/receipts cannot increase the parent sum. Require ambiguity/pending status; do not assert uniquely attributable credit from an indistinguishable in-bound external inflow.
- [ ] Run these backend/Rust tests and confirm failures before implementation.
- [ ] Extend the existing journal/guard paths; preserve baseline-before-signature and credit-before-next-child persistence ordering. Keep `minimum-return-v1` distinct from bounded source credit. Refuse new private spending while unrelated signed work is unresolved; the same parent's verified handoff must not deadlock on its own completed source children.
- [ ] Run existing sealed-credit replay and coordination tests, adding source-qualified recovery and duplicate-parent cases. Run real Postgres races when `TEST_DATABASE_URL` is configured. If a test proves these mechanisms insufficient, document that specific failure before proposing another store/lease system; do not expand scope from an unsupported assumption.
- [ ] Commit as `feat: recover combined funding through existing source journals`.

### Task 5: Hand combined private USDC to the existing Earn path

**Files**

- Modify: `mobile/modules/gizu-stored-signer/core/src/earn_sponsored.rs` for source-network funding. Reuse existing `core/src/private_earn_payout.rs` and `core/src/earn_auth.rs` for downstream authorization/execution.
- Modify: `mobile/modules/gizu-stored-signer/android/src/main/java/io/gizu/storedwallet/earn/EarnDepositPreparer.kt`, `EarnDepositCoordinator.kt`, `EarnDepositApproval.kt`, `EarnDepositJournal.kt`, `EarnDepositEngineAdapter.kt`, `EarnSponsoredSettlement.kt`, `EarnFundingBatchApproval.kt` (same directory).
- Reuse unchanged Robinhood downstream contracts in `backend/src/adapters/earn/confidential-cashout.ts` (`ConfidentialPrivateFundingGateway`) and `robinhood-deposit-preview.ts`. The older `private-payout.ts` uses per-source credit proofs and is not the existing balance-funded gateway.
- Test: existing `EarnDepositCoordinatorTest.kt`, `EarnDepositRecoveryTest.kt`, `EarnPrivateDepositFlowTest.kt`, `EarnDepositAllocationTest.kt`; `backend/test/adapters/earn/private-payout.test.ts`, `private-payout-routes.test.ts`.

**Interfaces**

- The parent funding journal retains the ordered public source children and their confirmed credits. Those records are funding provenance, not new downstream payout sources.
- After the credit barrier, construct the existing private-source review row for Account 2 (`kind: "private"`, `amountAtoms` limited to the approved combined amount). Reuse `EarnDepositEngineAdapter.privatePayoutEngine` and the existing private-funding endpoint/proof shape; do not add a `fundingPool` payout source union or endpoint.
- The parent keeps the original total budget, funded amount, saved cycle/recipients and remaining fee bounds. Its handoff to the private-funded child must not allocate another cycle, charge source gas again or grant access to unrelated Account 2 funds.

- [ ] Add `combined_funding_reuses_private_earn_flow`: compare an already-private-funded investment with an otherwise identical investment funded from two public networks. After confirmed private credit, both use the same existing private-source contract, saved recipient distribution and execution path. No downstream action is repeated per funding network.
- [ ] Add partial-credit failure/resume, mixed approved-private/public input, quote expiry after first credit, insufficient net minimum and changed-recipient cases. Terms outside the saved caps require review; completed credits and chosen weights survive it.
- [ ] Run focused native and backend tests and confirm new cases fail.
- [ ] Extend the existing preparer/coordinator only at the funding-to-private handoff. Prepare and approve the existing private-funded child using the confirmed amount and original saved distribution. Keep its payout calculations, group receipt verification, vault execution and fee/minimum rules. Changed terms outside the approved bounds require the existing review transition.
- [ ] Preserve v1 source × recipient journals and legacy confidential owners. Reauthentication uses existing approval/read-auth transitions while retaining saved settlement evidence. Assert that selling or exiting an investment returns to private USDC, and no public cashout starts without explicit Withdraw from Gizu approval. Run affected Earn suites and existing sell/cashout regression suites.
- [ ] Commit as `feat: connect multi-chain funding to existing private Earn execution`.

#### Task 5b: Adapt the existing funding handoff for Ethereum Earn

This is a discovered integration gap, not a new Earn product or vault redesign.
The current private-balance adapter/native operation is profile-4663-only. The
legacy Ethereum controller still expects individual public-source proofs; do not
pretend it accepts the pooled private source unchanged or silently omit it.

**Files:** Modify `mobile/src/features/earn/useLegacyEthereumDeposit.ts`,
`mobile/src/domain/earn/privatePayout.ts`, `mobile/src/services/earn/privatePayout.ts`,
`mobile/modules/gizu-stored-signer/core/src/private_earn_payout.rs`,
`android/src/main/java/io/gizu/storedwallet/earn/EarnPrivatePayoutEngine.kt` and
the native module bridge under `mobile/modules/gizu-stored-signer/`;
`backend/src/adapters/earn/confidential-cashout.ts`,
`backend/src/http/routes/confidential-cashout.routes.ts`.
Test in `mobile/tests/functional/earn/legacy-deposit.functional.test.tsx`, native
private-payout tests, and `backend/test/adapters/earn/confidential-private-funding.test.ts`.

**Interface:** Generalize the existing balance-funded adapter with an allowlisted
`profileChainId: 1 | 4663`. For profile 1, pin the existing Ethereum USDC contract
and Aurora asset; validate its derived saved recipient, private debit and quoted
minimum with native authority. Preserve 4663 defaults/v1 proofs and keep public
cashout destination controls separate. The original parent budget/distribution
and legacy Ethereum stage approvals remain in force.

- [ ] Add a test proving the current 4663-only operation rejects profile 1,
      then implement the explicit pinned Ethereum private-balance admission.
      Wrong token/chain/recipient, excessive debit and cashout-purpose confusion
      must remain rejected.
- [ ] Connect the confirmed private amount to this existing adapter in the legacy
      controller. Preserve existing ETH-liquidity preparation, gas reserve, vault
      execution, cycle identity and per-stage reviews. Do not manufacture a Monad
      source transaction/credit proof for funds received from Base or Arbitrum.
- [ ] Route list/resume/reconcile/cancel through the correct saved operation kind.
      Current legacy native bridge methods exclude `privateEarnPayout`; changing
      only the Rust profile allowlist would leave new Ethereum work invisible or
      non-resumable. Keep old source-proof operations on their original handlers.
- [ ] Apply the existing `payoutEthereum` fee qualification and Ethereum receipt
      verification for profile 1, keeping `payoutRobinhood`/4663 behavior intact.
      Version any added request fields and preserve strict legacy decoding.
- [ ] Test public-only, mixed private/public, restart at handoff and already-private
      Ethereum funding. Compare downstream balances/receipts with its existing
      liquidity/vault contracts. Run affected backend/native/functional tests.
- [ ] Commit as `feat: connect combined private funding to Ethereum Earn`.

### Task 6: Extend Swap with fund-only children and a pooled execution

**Files**

- Modify: `mobile/modules/gizu-stored-signer/core/src/swap/engine.rs`, `engine_tests.rs`, `funding.rs`, `aurora.rs`, `mod.rs` (same directory).
- Modify: `mobile/modules/gizu-stored-signer/android/src/main/java/io/gizu/storedwallet/swap/SwapFundingBatch.kt`, `SwapBatchApproval.kt`, `SwapEngine.kt`, `SwapStore.kt` (same directory).
- Test: `android/src/test/java/io/gizu/storedwallet/swap/SwapFundingBatchTest.kt`, `SwapBatchApprovalTest.kt`; Rust engine tests.

**Interfaces**

- Native plan v2 separates `sourceChainId`, `originAsset`, fixed `privateAsset` and destination `chainId`. Add a fund-only mode to the existing operation that terminates at confirmed private credit.
- Swap batch v2 persists funding pool + fund-only child states + one downstream execution state. Hand the approved amount and saved distribution to the existing private-funded Swap operation. Restrict its amount if necessary at that boundary rather than redesigning its payout/trading logic or reading/spending the whole private balance.
- Public parent status reports aggregate gross budget, verified private credit and downstream result without claiming success when only funding finished.

- [ ] Add `mixed_network_swap_waits_for_all_credits`, `funding_chain_does_not_change_target`, and `payout_spends_only_approved_pool`. Assert no Fusion order/private payout before the final required credit; repeat target 4663 and 8453.
- [ ] Add restore at every submission/credit boundary, ambiguity → reauthenticate → Resume, saved source quote expiry and cancel-after-first-credit tests. Assert one submission per saved UserOperation and no baseline replacement. Replay the previously fixed private-sale Resume case.
- [ ] Run `cd mobile && npm run stored-signer:test -- swap`; focused Android Swap batch/approval tests must fail for the new assertions first.
- [ ] Extend the existing Rust state machine and Android batch, preserving persistence-before-transmission. Keep v1 hashes, fixed Monad fields, batch execution and encrypted-envelope AAD readable unchanged; new batches use explicit v2 decoding.
- [ ] Run Rust swap tests and Android batch/approval tests to pass, including old saved-journal fixtures. Confirm private balance alone can fund a new Swap without public-source signatures.
- [ ] Commit as `feat: execute one Swap from pooled multi-chain funding`.

### Task 7: Bring iOS funding and Swap to the same contract

**Files**

- Modify: `mobile/modules/gizu-stored-signer/ios/Swap/SwapEngine.swift`, `SwapStore.swift`, `SwapReconciler.swift`.
- Modify: `mobile/modules/gizu-stored-signer/ios/Access/WalletCeremony+Swap.swift`, `ios/GizuStoredSignerModule.swift`.
- Create: `mobile/modules/gizu-stored-signer/ios/Swap/FundingReservations.swift`, `ios/Tests/FundingReservationsTests.swift`, `ios/Tests/SwapFundingBatchTests.swift`.
- Test: `mobile/modules/gizu-stored-signer/ios/Tests/OperationJournalTests.swift`, `MainnetPortfolioTests.swift`, `SwapHoldingsTests.swift`.

**Interfaces**

- iOS consumes the same Rust source allocation/checked amount rules as Android; `SwapEngine` persists v2 parent/children and confirmed credit envelopes through the existing encrypted `StoredSwapFile`.
- iOS source reservation operations match task 3's chain-qualified contract and sticky signed ownership, using existing wallet files/keys and wallet-generation scoping.
- Expose only capabilities actually implemented: new funding/Swap contract yes; existing unavailable guided Earn functions remain unavailable.

- [ ] Add `fifteen_usdc_swap_uses_two_account_one_sources` and a 15,000,000-atom input validation case. Add legacy single-state journal restore, same-address/different-chain reservation, two simultaneous intents, expired auth and restore-after-one-credit cases.
- [ ] Run `cd mobile && npm run stored-signer:test:ios`; confirm new cases fail before implementing the host changes.
- [ ] Remove the hardcoded 10,000,000-atom ceiling for new reviewed operations; use the shared checked numeric bounds, fee constraints and actual capacity. Retain bounded payload sizes. Extend the existing host to drive fund-only children then the pooled execution; do not reimplement Rust signing or payout calculations in Swift.
- [ ] Version `StoredSwapFile` content without changing old encryption AAD or invalidating v1 records. Persist reservations/children before outbound actions. Resume reconciles saved source operations before planning another source.
- [ ] Run iOS tests and `npm run stored-signer:check:ios`; verify capability tests still keep guided Earn unavailable. Regenerate UniFFI bindings using existing build scripts and check both hosts compile.
- [ ] Commit as `feat: support pooled funding for iOS Swap`.

### Task 8: Observe and display one correct cash balance

**Files**

- Modify: `mobile/modules/gizu-stored-signer/android/src/main/java/io/gizu/storedwallet/swap/MainnetPortfolio.kt`, `android/src/main/java/io/gizu/storedwallet/portfolio/OwnedPortfolio.kt`, `PublicPortfolioMapping.kt`.
- Modify: `mobile/modules/gizu-stored-signer/ios/Portfolio/MainnetPortfolio.swift`, `MainnetPortfolioRPC.swift`.
- Modify: `mobile/src/domain/wallet/storedSigner.ts`, `portfolioValue.ts`, `mobile/src/features/wallet/MainnetWalletProvider.tsx`.
- Test: `mobile/tests/unit/wallet/portfolioValue.test.ts`, `mobile/tests/functional/wallet/sourceUsdc.functional.test.tsx`; Android `PublicPortfolioTest.kt`, `OwnedPortfolioTest.kt`; iOS `MainnetPortfolioTests.swift`.

**Interfaces**

- Add `fundingSources` to the native snapshot: rows carry `FundingSourceKey`, `balanceAtoms: string | null`, observed amount, reservations, stale/complete flags and timestamp. Add `fundingContractVersion`/supported chain IDs.
- Add `fundingCash` aggregate with observed total, complete flag and available-to-plan observation; preserve legacy Monad `totalAtoms`, `fundingAtoms`, `returnAtoms` until callers migrate.
- Update `portfolioUsdcBalance(snapshot)` to derive public USDC from canonical per-source observations once and combine the existing private observation once. Native fresh checks, not this helper, authorize spending.

- [ ] Add balances 10,000,000 Monad + 10,000,000 Base + 5,000,000 Arbitrum + 2,000,000 private = 27,000,000. An identical Base USDC holding represented in `ownedAssets` must not count twice. Different legitimate owners on one chain must not be collapsed by token identity.
- [ ] Add RPC failure on one chain with cached funds, a late result from another wallet generation, source debit before private credit, private credit before source refresh, and pending/reserved states. No failed read becomes a verified zero; no transition creates two spendable copies.
- [ ] Run affected Jest and native portfolio tests and confirm the new assertions fail.
- [ ] Extend current caches/read budget and snapshot validator. Read Account 1 on each new chain in bounded parallel calls, publish partial observations without waiting for the slowest network, and preserve freshness independently. Deduplicate the aggregate by chain/token/owner and journal transfer identity, not symbol or chain/token alone.
- [ ] Refresh/invalidate affected source and private observations after funding, sell, Earn return, payout and cancel. Do not mark current funds complete from stale cached values. Run tests to pass.
- [ ] Commit as `feat: aggregate funding cash without duplicate balances`.

### Task 9: Extend existing funding UI and keep downstream screens chain-abstracted

**Files**

- Modify: `mobile/src/domain/wallet/depositNetworks.ts`, `mobile/src/features/wallet/AddFunds.tsx`, `NetworkPicker.tsx`.
- Modify: `mobile/src/features/swap/useNativeSwap.ts`, `NativeSwapScreen.tsx`, `TokenDetail.tsx`, `components/ChainMark.tsx`.
- Modify: `mobile/src/features/earn/DepositJourneyScreen.tsx`, `useDepositJourney.ts`, `SourceFundingPanel.tsx`.
- Modify: `mobile/src/services/earn/sourceFunding.ts`, `mobile/src/domain/earn/depositJourney.ts`, `mobile/src/domain/wallet/portfolioValue.ts`.
- Test: `mobile/tests/functional/wallet/sourceUsdc.functional.test.tsx`, `mobile/tests/functional/earn/deposit-journey.functional.test.tsx`, `mobile/tests/functional/swap/nativeSwapLayout.functional.test.tsx`; create `mobile/tests/functional/wallet/funding-networks.functional.test.tsx`.

**Interfaces**

- `DepositNetworkId = "monad" | "base" | "arbitrum"`; visible choices are the intersection of backend enablement and native funding capabilities. All three resolve to existing Account 1 with the selected network context.
- Swap/Earn controllers request an aggregate budget; native planning selects sources. Funding review/status may identify networks and show extra approvals; ordinary balance, token/action and completed-result views do not require chain selection.

- [ ] Add functional receiving tests for each network: same address, correct network context, copy/QR, back navigation and unsupported-build gating. Backend-only readiness cannot expose a network unsupported by the native build.
- [ ] Add Home → 15 USDC action from 10+10, review showing gross amount/maximum fees/minimum net, extra funding signatures, progress and Resume. Assert no downstream chain picker or network badges; retain useful asset issuer/product labels when symbols collide.
- [ ] Run focused functional tests and confirm new cases fail.
- [ ] Extend existing screens/controllers and native review data. Update all balance/max validators and preview helpers that currently assume one funding address on Monad; use the prepared pool's minimum private amount for reliable action estimates. Catalog metadata and screen rendering must not wait for all source RPCs.
- [ ] Handle fee/minimum changes, unavailable source, biometric rejection, partial credit and additional approval through existing review/status states. Show funding-specific errors at the affected funding step; keep one parent journey in ordinary navigation/history.
- [ ] Run affected functional/unit tests and typecheck. Audit visible strings/accessibility labels for chain leakage outside funding, including token details, Earn names and completed activity; preserve internal chain/address selection so the earlier catalog race cannot regress.
- [ ] Commit as `feat: expose funding networks through a chain-abstracted journey`.

### Task 10: Prove recovery and compatibility across the complete journey

**Files**

- Extend: `mobile/modules/gizu-stored-signer/core/src/swap/engine_tests.rs` and pool/planner tests.
- Extend: Android `EarnDepositRecoveryTest.kt`, `EarnDepositJournalTest.kt`, `swap/SwapFundingBatchTest.kt`; iOS `OperationJournalTests.swift`, `SwapFundingBatchTests.swift`, `BackupTests.swift`.
- Extend: `backend/test/adapters/aurora/balance-settlement.test.ts`, `backend/test/adapters/earn/confidential-private-funding.test.ts`, `backend/test/adapters/earn/confidential-cashout.test.ts`, `backend/test/adapters/earn/private-payout.test.ts`.
- Extend: `mobile/tests/functional/earn/deposit-journey.functional.test.tsx`, `mobile/tests/functional/wallet/funding-networks.functional.test.tsx`, `mobile/tests/support/mainnetWallet.ts`, `mobile/tests/support/depositJourney.ts`.

**Interfaces:** No new product API. Exercise production planners, journals and controllers with provider/transport/storage boundaries mocked; retain real native policy/cryptographic checks in native tests.

- [ ] Build a deterministic matrix for source sets `{Monad}`, `{Base}`, `{Arbitrum}`, each pair, all three and approved-private + public. Include 15,000,000 from 10,000,000 + 10,000,000; first-use versus delegated Account 1; zero native gas token; both Swap destinations and existing Android Earn profiles.
- [ ] Assert exactly-once effects across interruption before/after source signature, submission, receipt, credit record, final pool readiness, payout submission, destination receipt and vault deposit. Retry cannot create a new deposit or move already funded money to another source.
- [ ] Assert safe cancellation at unsigned, signed-unknown and partially credited stages; reservations release only after terminal evidence. Test expired authorization, app restart, backend restart/replica races, wallet lock/switch/recovery and unavailable local journal. Funds recovered by wallet discovery are not automatically declared an attributable completed pool.
- [ ] Replay v1 journal fixtures, prior ambiguous-sale reauthentication regression, normal private sells, existing withdrawal/cashout and late catalog responses. Missing/unknown protocol versions fail visibly without deleting evidence. No `/history` request is introduced.
- [ ] Run the full backend, Rust, Android, iOS and JS suites using task 11's commands. Fix behavior, not only fixtures; report deterministic tests separately from provider/device qualification.
- [ ] Commit as `test: cover multi-chain funding recovery and legacy operations`.

### Task 11: Qualify providers, document behavior and enable deliberately

**Files**

- Modify: `docs/internal/CONFIDENTIAL_EARN.md`, `docs/internal/NATIVE_SIGNER_PORTFOLIO.md`, `docs/internal/NATIVE_SIGNER_EARN.md`, `docs/internal/WALLET_DISCOVERY_RECOVERY.md`, `docs/internal/GAS_MANAGEMENT.md`.
- Modify: `docs/feature-plans/SWAP_ARCHITECTURE.md`, `docs/feature-plans/SWAP_PERSISTENCE.md`, `docs/feature-plans/PARITY.md`.
- Extend: existing Pimlico integration test and gas-doctor script reached by `backend/package.json` (do not create another measurement framework). Extend `.github/workflows/mobile-release.yml` only if new native tests are not discovered by its existing commands.

**Interfaces:** Backend capability enablement is per network. Enable only when the deployed backend, release native host and exact provider route are qualified. Monad v1 routes remain available for old clients.

- [ ] Record read-only evidence for 143/8453/42161: RPC chain ID, pinned bytecode/delegate/EntryPoint, exact USDC token/paymaster support, Aurora origin → canonical-private quote, fees, minimums, expiry and refund semantics. Check cold/delegated gas estimates and rollup data fees. Do not mistake a token registry entry or generic guide for an executable route.
- [ ] With credentials and explicit funded-test authorization, execute tightly budgeted single-source Base and Arbitrum journeys, then mixed-source Swap and Android Earn. Confirm canonical private credit, source USDC-paid gas, bounded fees, no duplicate effects on Resume and preserved old operations. If credentials are absent, leave this release gate blocked and keep the network disabled.
- [ ] Verify network-specific finality/reorg treatment through the existing receipt logic. Bound polling and preparatory work; instrument preparation and time-to-credit separately. Do not impose an arbitrary two-second budget on an actual settlement or hide a pending operation as failed.
- [ ] Run the commands below on supported hosts; record versions, pass/fail/blocked and test reports. Native device checks cover biometrics, real prompts, background/foreground, process death and funding network display; mocked JS tests do not prove them.
- [ ] Update the listed docs with exact scope, private-pool accounting, additional signatures, fees, recovery limits and iOS Earn availability. Include deployment ordering and rollback: disable new starts per network while retaining reconciliation routes and handlers for existing v2 operations. Do not roll back to a backend unable to resume signed v2 journals.
- [ ] Commit as `docs: document qualified multi-chain funding and rollout`. Push/PR/deploy only as subsequently requested; do not merge this branch as part of planning.

## Verification commands for implementation

Use package scripts and lockfiles; these are future execution checks, not checks
claimed to have passed during planning.

Backend, from `backend/`:

```bash
npm run typecheck
npm test
npm run gas:check
npm run gas:check:native
```

Mobile shared/native, from `mobile/`:

```bash
npm run stored-signer:test
npm run stored-signer:build
npm run format:kotlin:check
npm run check
npm run stored-signer:build:ios
npm run stored-signer:test:ios
npm run stored-signer:check:ios
```

The Android build/test commands match the existing release workflow. After its
documented JDK/SDK/NDK setup and native build, from `mobile/`:

```bash
npx expo prebuild --platform android --no-install
```

Then from `mobile/android/`:

```bash
./gradlew :gizu-stored-signer:testDebugUnitTest :gizu-stored-signer:testReleaseUnitTest assembleDebug --no-daemon -PreactNativeArchitectures=arm64-v8a
```

For focused Android iterations, use the same Gradle test task with `--tests`
and the existing `io.gizu.storedwallet.*` test class. iOS tests require macOS,
Xcode and an installed iPhone simulator; CI already defines those prerequisites.
Use the repository's existing Postgres integration harness for real transactions
and two-client races; do not replace those assertions with an in-memory mock.

## Completion criteria

- One reviewed 15 USDC gross-budget action can consume two 10 USDC source balances,
  with explicit fees/minimum net result and the required native signatures.
- Base/Arbitrum Account 1 funds converge into exact canonical Account 2 private
  USDC before handing off to the existing private-funded Earn/Swap path. Its
  downstream execution/distribution and private-return behavior remain unchanged;
  source count does not repeat the action or reroll investment wallets.
- Balances, available budget and pending ownership remain correct through stale
  observations, partial completion, cancellation and restart.
- The app asks for a network only within funding, and still identifies tokens
  correctly internally. Unsupported builds/networks remain gated.
- Legacy Monad funding, current sells, withdrawals, cashout and saved journals
  continue to work. iOS guided Earn remains at its current availability.
- Deterministic/native/device checks and provider qualification have separate,
  truthful results. No deployment or paid operation is implied by this plan.
