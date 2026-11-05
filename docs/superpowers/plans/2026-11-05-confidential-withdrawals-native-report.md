# Confidential withdrawal native/backend implementation report

Task 1 implementation is frozen for integration review. No Git mutation, deployment, phone interaction, signing with a user wallet, or funded transaction was performed.

## Implemented contract and authority

Android advertises `confidentialWithdrawals` and `confidentialSaleProceeds`. The Expo contract is the five methods in the approved plan: `getConfidentialWithdrawal`, `prepareConfidentialWithdrawal`, `executeConfidentialWithdrawal`, `resumeConfidentialWithdrawal`, and `cancelConfidentialWithdrawal`. Public progress aggregates transport children by receiving-wallet slot. JavaScript supplies only wallet ID, exact amount, operation ID and revision; it supplies no confidential account, public receiver, weights or source allocation.

The Rust planner consumes the existing native catalogue (swap C2 and saved/recovered Earn-cycle C accounts), authenticated generic available Monad-USDC balances, one existing allocation-algorithm result and freshly allocated registry receiving roles. Exact source debits and exact receiver budgets both sum to the chosen amount, including route fees. The native encrypted journal persists the distribution before requesting spend signatures. Rust validates the actual request, raw quote, exact private input, single-token transfer payload, source derivation, destination, fresh balance, nonce, deadline, reservation evidence and native approval. No returned-child legacy signer contract was loosened.

Native confirmation now shows human USDC input, guaranteed net minimum, maximum fee/route deduction, receiving-wallet summaries, exact atom values and each signed child review. Each signature is written durably before submit, and retries submit the original stored string rather than reconstructing signed JSON. Unknown children remain reserved. Resume first checks authenticated operation history and canonical receipt evidence; completed children never resubmit or reroll. An interrupted local signing marker without durable signed bytes can be cleared safely because transport strictly follows the signed-byte write. Reapproval uses the same saved distribution.

The conservative private-execution guard reads existing native swap, deposit, payout, sponsored-return and legacy-withdrawal journals. Competing starts/resumes reject while a cashout is active. Unsigned legacy `status: cancelled` records release exclusion, while cancelled records carrying spend/signing evidence remain blocked. Completed private returns persist `finalized` and are admissible. New `executeEarnWithdrawal` creation rejects with instructions to use Withdraw from Gizu; existing legacy recovery methods remain available.

Private-balance observations are invalidated before signing/submission/reconciliation and on settlement. While a cashout is active, its source observations are excluded from the public portfolio total and completeness is false. This prevents fresh public receivers from being added to a still-complete predebit private cache.

## Backend and durable receipt binding

New routes are `POST /v1/earn/native/cashout/prepare` and `/status`; submission uses the existing Aurora submit-intent route. Preparation authenticates generic private funds independently of sale-credit or returned-child proofs. The smallest shared sale extension is `POST /v1/swap/aurora/history` with `{accessToken, depositAddress}`, a constrained authenticated history filter, and limit 100.

Cashout status binds the authenticated private history record to its source, deposit, asset, recipient, refund, exact debit, timestamp and source-intent identity. Invalid/NaN timestamps fail closed. Paid additionally requires successful canonical finalized chain-143 USDC transfer evidence after the saved reference block, including its exact transaction hash and log index. Ambiguous multiple matching transfers fail closed.

Receipt replay protection deliberately retains durable **opaque keyed commitments**, rather than being stateless. The existing PostgreSQL `OperationCoordinator.bind` atomically binds `(chain143, USDC, transaction hash, log index)` to the immutable child/source/receiver/payload/source-intent identity. An identical child retry is idempotent; the same event cannot complete another equal-value child across backend restarts or replicas. Raw wallet catalogues, addresses, payloads and history are not stored in this table. Receipt commitments have effectively permanent authority (year 9999 expiry); retain the durable database and stable HMAC/recovery key. There is no production in-memory fallback.

Backend deployment is required before this APK can use cashout/history. Production wires the existing PostgreSQL coordination store and recovery secret. Missing coordination/key fails closed; database failure fails the receipt commitment before native accepts paid. No live provider qualification or deployment success is claimed by these tests. Existing production Aurora same-asset quote/history compatibility still requires operational qualification.

## Bounds and recovery limitations

- Exact chosen budget is positive canonical u64 atoms, matching the existing allocation algorithm.
- At most 32 selected confidential sources and 1–5 fresh receivers. The matrix has at most sources + receivers - 1 transport children (36 maximum).
- Receiver registry high-water is 8192; exhausted allocation fails before signing. Reserved receiving indices are never reused, including unsigned preparation failures.
- The cashout journal is limited to less than 8 MiB plaintext with envelope headroom. It retains terminal payload/nonce/receipt history; no compaction was introduced during this change. Once full, further writes fail closed with the existing encrypted recovery state intact. A failed write never replaces saved signed/unknown state or submits bytes that were not durably saved. This is a finite local capacity limit, not an unbounded scalability claim.
- Quotes expire within 60 seconds. Up to 36 child preparations are sequential and may need retry; refresh preserves the allocation. Fresh validated quotes with more than 15 seconds remaining are reused, while failed-validation needsReview/minimum-zero candidates are re-prepared. A malformed quote remains displayable, resumable and cancellable when wholly unsigned. Partial signed plans cannot be cancelled.
- There is no automatic public withdrawal or user-funded test transaction.

## Verification evidence

All final focused commands below exited zero:

```sh
PATH=/Users/ouyildiz/.cargo/bin:$PATH cargo test --locked --manifest-path mobile/modules/gizu-stored-signer/core/Cargo.toml confidential_withdrawal
# 5 passed; /private/tmp/gizu-cashout-rust-final.log

ANDROID_HOME=/Users/ouyildiz/Library/Android/sdk JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home mobile/android/gradlew -p mobile/android :gizu-stored-signer:testDebugUnitTest --tests io.gizu.storedwallet.ConfidentialWithdrawalEngineTest --tests io.gizu.storedwallet.ConfidentialWithdrawalJournalTest --tests io.gizu.storedwallet.OwnedConfidentialPortfolioTest
# 21 passed: engine 5, journal 6, confidential portfolio 10
# /private/tmp/gizu-cashout-focused-final.log

cd backend
node --experimental-transform-types --test test/adapters/earn/confidential-cashout.test.ts
# 6 passed; /private/tmp/gizu-cashout-backend-final.log
npm run typecheck
# passed; /private/tmp/gizu-cashout-backend-typecheck-final.log
```

Meaningful engine tests inject only network/auth/catalogue/approval boundaries, use actual Rust planning/signing, actual native account derivation and real encrypted WalletStore/journal. They cover multisource exact budgeting and fees, lost response after submission plus process restart without duplicate submission or reroll, rejected approval without spend transport, interrupted local signing without transport, insufficient funds/competing execution before allocation, and malformed quote repair with unchanged allocation. Journal tests cover immutable signed bytes, unknown locks, per-receiver sums, terminal completion, actual legacy cancellation shape, private-return completion, cancellation, and capacity failures retaining saved unknown signatures. Backend tests cover generic availability, exact auth/history binding, restart, changed payload/auth/envelope, cross-child canonical event replay, unavailable durable coordinator and invalid timestamps.

TDD red evidence: the malformed fresh quote reuse regression failed before the final guard (`/private/tmp/gizu-cashout-quote-red.log`); canonical receipt reuse failed before durable binding (`/private/tmp/gizu-cashout-backend-receipt-red.log`).

Earlier host/binding/arm64 generation succeeded (`npm --prefix mobile run stored-signer:build`, `/private/tmp/gizu-cashout-native-bindings.log`), and native module compilation succeeded. That generated host binary predates the latest strict Rust-helper refinements; regenerate host/native bindings before final integrated Android tests. Rust exports have not changed since generation. Parent owns the final full native build/test, formatting pass, integration review and APK; no release APK was built by this task.

## Final review follow-ups awaiting integrated native run

After the focused 21-test run, review identified that legacy swap `cancelled: true` does not retract an existing `data.payouts[].signed` or `intentHash`. The cashout guard now refuses those cancelled states, traversing current/history/funding children as before. The new serialized Machine/Data/Payout fixture regression covers signed, submitted, unsigned cancelled and done states. Legacy aggregate `delivered` alone does not release a cancelled signed child. Such cancelled legacy signatures require explicit recovery remediation; this change retains the lock rather than fabricating private terminal evidence.

Also after that run, authenticated vault/source credit commits in `GizuStoredSignerModule` now call `invalidateEarnPrivateCreditCaches` **before** saving the credited settlement. That helper invalidates origin stable/vault groups (plus native/WETH where appropriate) using Task 2's `NativeOwnedPortfolio.invalidateTokens`, and invalidates the private C observation. This prevents stale public origin value from being combined with refreshed private credit. These last hook/guard edits were formatted and passed `git diff --check`; parent owns their integrated compilation/full native test run. No additional Gradle invocation was made while the parent coordinated the final build.

A final cache review also found the separate Monad public-USDC snapshot could retain a fresh pre-credit zero for 30 seconds after cashout. `MainnetPortfolio.invalidate(record)` now uses the exact shared `mainnetUsdcBalanceSync` factory used by `read` (wallet-ID AAD, chain 143, canonical USDC, native `decodePortfolioBalance`). The cashout callback invalidates this public snapshot before private invalidation/paid commit, and sourceFunding credit invalidation now reaches this actual public-USDC snapshot. Two new in-memory `MainnetPortfolioInvalidationTest` cases cover refresh after a recently cached zero/restart and incomplete stale observations on failed refresh. These final cache edits were formatted and passed diff check; tests are handed to the parent’s coordinated native run without an overlapping Gradle invocation.
