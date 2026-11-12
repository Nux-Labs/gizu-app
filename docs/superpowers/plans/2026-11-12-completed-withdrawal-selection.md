# Completed withdrawal selection implementation plan

> For execution inline with superpowers:executing-plans.

**Goal:** A completed private return must not be presented again as an unfinished
withdrawal when the user opens Withdraw for a later investment.

**Evidence:** Native inventory deliberately reports redeemed activity even after
authenticated return evidence is committed. It cannot attest current residual
balances. The selection hook only skips a redeemed portion after a manual check
in that mounted screen; remounting loses the accepted proof. The final verifier
already combines native operation-specific return evidence with public shares
and residual valuation, without consulting current private balance or history.

**Approach:** Reuse that verifier during withdrawal selection for redeemed rows.
Skip only a complete, fresh exit with authenticated return IDs and no unresolved
legacy public payout. Keep its result screen-local and rederive it from saved
receipts and public state on subsequent visits. Do not add another persistence
format or infer completion solely from paid children/minimum receipts. Position
overview remains free of withdrawal reads. The user's already authorized proper
flow fix supplies scope; no new financial controls or provider contracts.

**Files:** useVaultPosition.ts owns sequential candidate checks and cancellation;
exitCompletion domain shares the existing final-check completion predicate;
ExitCompletionPanel uses the same predicate; vault-position functional tests
exercise real navigation and externally mocked journal/RPC responses.

- [x] Add a failing regression for a completed return followed by a new investment,
      including revisiting Withdraw after Back.
- [x] Reuse fresh exit verification before selecting an unfinished portion; retain
      pending, missing-credit, residual, unavailable and cancellation safeguards.
- [x] Cover all-complete, native/public failure, stale completion, and zero signing.
- [x] Run affected and full JS coverage/type/lint checks; review; build/install and
      push the follow-up on fix/confidential-earn.
- [x] Separate a valid pending settlement from an unavailable verification read;
      unavailable reads show an alert/retry, never an unfinished-return prompt.
- [x] Trace the earlier failure through AWS and RPC logs; establish the price-stage
      dependency while retaining the limit that its exact exception was discarded.

## Durable completion follow-up

AWS now confirms req-38y returned HTTP 500 on exit-snapshot while adjacent requests
passed. The corresponding provider log has 13 successful chain reads, valid
contract metadata, zero shares, zero native/wrapped balances and a fresh block;
the final canonical-block read is absent. Failure is narrowed to the live price
retrieval/validation stage; its exact provider exception was discarded by the
backend. Do not claim an RPC throttle or historical-state failure for this request.

Completed workflow history must not depend on repeatedly obtaining new prices.
Persist a non-secret presentation observation only after the existing complete
exit predicate passes. Bind it to the full native journal and legacy payout
revision/status sets, wallet, intent, profile and slot. Re-read those native sets
on selection; new, pending, changed or recovery activity invalidates the match.
No cached result authorizes spending or removes holdings from portfolio reads.
Offer an explicit read-only recheck of past withdrawals that discards the matched
observation before fresh balance/price verification, preserving access to later
external funds or residuals in a previously completed wallet.

- [x] RED: complete an old exit, revisit/restart with prices unavailable, and still
      select the current investment without calling the price endpoint again.
- [x] Implement bounded wallet-scoped observation storage; use the same revision
      record for automatic checks and the existing final verification panel.
- [x] Verify native revision/pending/payout changes defeat the record; explicit
      past recheck retains residual recovery; corruption/write failure is safe.
- [x] Run release checks, obtain review and build/install.
- [x] Push the verified follow-up on fix/confidential-earn.

The new navigation regression failed on the previous implementation, then passed.
All 55 affected tests pass, including adapter recreation, manual final-check
recording, pending/revision invalidation, later residual recovery, corrupt or
unavailable observation storage and unmount during delayed storage reads.
Independent review found no substantive issue; storage never reaches an execution
authorization boundary. Typecheck, full lint/formatting and Android assembly pass.
Full coverage passes: 994 tests across 106 suites. Replacement installation on the
Samsung succeeded, preserving wallet storage. The first unrecorded completion
check hit the intermittent HTTP 500; a read-only retry passed and recorded the
verified exit. Reopening Withdraw selected the current investment at Step 1 and
kept the old return complete without an additional exit-snapshot request. This
also passed after backgrounding and resuming Gizu. This follow-up is app-only;
it does not claim to repair the separate live pricing
failure. A contemporaneous direct Aurora registry probe passed existing metadata
and price freshness validation; the exact server exception remains unavailable.

**Constraints:** No history API, no wallet reset or secret extraction, no AWS
mutation, and no financial approval/signing/submission. A private balance that has
since been spent is irrelevant to an authenticated historical return receipt.

Validation so far: the new real-navigation regression failed on the old behavior,
then passed with the shared verifier. All 45 affected functional/unit tests,
typecheck, full lint and formatting pass; independent review found no substantive
issues. Android assembly passes and replacement installation succeeded, preserving
wallet storage. Before installation, the existing read-only verifier on the phone
confirmed the old return complete with negligible residual value, despite its
initial zero-completed counter. Full coverage passes: 984 tests across 105 suites.
The first code is pushed. A repeated entry exposed a verification fallback:
exceptions silently rendered the old return as unfinished. The follow-up
distinguishes valid pending journal activity from operational read failures.
Regressions cover unavailable/binding/expired reads with status retry, while
unconfirmed credit and real residuals retain recovery. All 984 tests and coverage
thresholds pass on this follow-up; typecheck, lint, formatting, independent review
and Android assembly pass. Replacement installation succeeded. The latest build
recognised the old return on two openings, without financial review or approval.
The prior intermittent read exception itself was not captured. USB disconnected
after these checks; no claim is made that an underlying provider/read failure was
remediated. Wallet storage and existing authorization checks remain intact.
