# Swap failures and recovery

**Complexity: 2 — Technical.** For engineers investigating a paused or stalled swap.
Phase/code mappings checked against the shared Rust engine on **2026-11-14**.
This is a source-based guide, not evidence that any provider route works today.
For device setup, see [Swap debugging](SWAP_DEBUGGING.md).

## First response

1. Record app version/platform, time, buy/sell direction, token/network, phase,
   **step**, `pausedCode`, and payout/order counters. Expand Swap details if needed.
2. Preserve the existing wallet and encrypted operation journal. Do not uninstall,
   clear app data, replace the wallet or start another funded operation to clear an error.
3. Determine whether funding, a payout or an order may already have been submitted.
   A timeout or disconnected phone does **not** prove nothing was sent.
4. Inspect the matching native and backend evidence below. Choose the action from
   the phase/code tables; do not repeatedly tap Resume without understanding the stop.

The public status field is `pausedCode`. `PAUSED` describes the overall state;
`step` identifies the boundary that failed. Keep both when reporting an issue.

## Three different recovery actions

| Action         | Meaning                                                                                      | When appropriate                                                                     |
| -------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Retry          | Explicitly resume the saved operation at its current step; inputs are validated again        | A temporary service problem is resolved, or an unsigned quote can be requested again |
| Reconciliation | Check the existing submission, receipts, balances and provider status against saved evidence | A submission may have happened, results disagree, or delivery is still pending       |
| Fresh approval | Read the new native review and authorize it with the passkey                                 | Terms changed outside approved limits, or signing authorization expired              |

These are not three interchangeable buttons. Pull-to-refresh/status reads may only
show saved public state; they are not proof of a fresh provider reconciliation.
Native Resume drives the saved state machine and may poll, ask for approval or
perform an allowed saved-payload retry. It is not guaranteed to be read-only.

Core `retry()` clears the pause, failure counter and wait timer. It does not repair
invalid data, reset the operation lifetime, undo transfers or change the approved
plan. Never bypass a validation check to make Resume succeed.

## Phases and what they mean

| Phase       | Common steps                                                                                                                                                                      | What is happening                                                                                                                          | Next action if stalled                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `PLANNING`  | `assets`, `sourceChain`, `targetChain`, `fundingProbe`, `fundingQuote`, `fundingPrepare`, `payoutEstimate`, `fusionEstimate`, `holdings`, `recoveryScan`, `privateHistoryProbe`   | Validate networks, available funds, fees and route feasibility before approval. Recovery and payout-only flows may also authenticate here. | Inspect the failed service or validation; retry only after it is resolved.                           |
| `REVIEW`    | `review`, or the step needing reapproval                                                                                                                                          | Initial native approval or changed terms awaiting approval.                                                                                | Read the actual amount, fees and limits; approve explicitly or stop.                                 |
| `FUNDING`   | `fundingSign`, `fundingSubmit`, `fundingReceipt`, `credit`; post-approval preparation also maps here                                                                              | Fund the confidential route and wait for provider credit. A source receipt alone is not confidential credit.                               | Reconcile the existing submission; do not fund a second time.                                        |
| `CREDITED`  | `authSalt`, `authenticate`, `balances` after approval                                                                                                                             | Obtain authenticated private-balance evidence after route credit.                                                                          | Inspect authentication/balance errors. An aggregate balance is not proof every later payout settled. |
| `PAYOUTS`   | `payoutQuote`, `payoutIntent`, `payoutSubmit`, `payoutStatus`, `payoutBalance`                                                                                                    | Prepare/sign confidential payouts, wait for settlement, then check destination balances.                                                   | Distinguish an unsigned quote error from a submitted payout needing reconciliation.                  |
| `FUSION`    | `fusionBalance`, `fusionPreview`, `fusionPermit`, `fusionOrder`, `fusionSign`, `fusionSubmit`, `fusionStatus`, `fusionReceipts`, `fusionAfter`, `privateCredit`; sell quote steps | Prepare and execute token orders, validate fills and resulting balances.                                                                   | Reconcile existing orders/fills before authorizing remaining execution.                              |
| `PAUSED`    | Any; inspect `step`                                                                                                                                                               | The engine has a specific stop reason.                                                                                                     | Use the pause-code table below.                                                                      |
| `COMPLETE`  | `done`                                                                                                                                                                            | The engine reached its completion checks for this operation.                                                                               | Read portfolio/holdings separately; a cached Home balance can lag.                                   |
| `CANCELLED` | Saved last step                                                                                                                                                                   | Future signatures are stopped.                                                                                                             | Reconcile any already-submitted work; cancellation is not a refund.                                  |

The path is not always linear. Current full-token sells interleave holder orders
and authenticated operation-bound private credit, then finish without public payouts.
Legacy saved public-return sells retain their return-payout stages. Recovery can
start from existing funds rather than a new deposit. Check `completionTarget`;
`privateCreditedAtoms` is the verified private-sale amount, and a private sale has
zero payout legs/return addresses. A separate public withdrawal is outside this swap
machine; see [confidential withdrawals](CONFIDENTIAL_WITHDRAWALS.md).

**Counters are not settlement proof:** `payoutsSubmitted` counts payout records with
a saved signature, not confirmed delivery. `ordersComplete` counts orders marked
complete by the engine. `0/3` during `credit` is expected while payouts have not begun;
it does not establish that source funds are untouched. Recipient counts for new
buys vary from one to five; private sells have zero payout counters and can have
many holder orders. A `0/0` payout count is expected for private completion.

## Quote, service and validation pauses

| Code                   | Meaning in the engine                                                                              | Evidence and next action                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NETWORK_UNAVAILABLE`  | More than 20 transient response failures on non-submit steps. Status 0, 429 and 5xx are transient. | Check connectivity, throttling and service logs. Retry the saved operation after recovery; if earlier work was submitted, retain its evidence.                                   |
| `PLANNING_UNAVAILABLE` | Rejected HTTP response while loading assets, source/target chain or holdings.                      | Inspect route, HTTP status and backend error. Fix configuration/service before retry.                                                                                            |
| `FUNDING_UNAVAILABLE`  | Rejected funding probe/preparation response.                                                       | Inspect sponsorship/preparation service and source state. This code alone does not identify Aurora as the cause.                                                                 |
| `QUOTE_REJECTED`       | Rejected HTTP response at `fundingQuote`, `payoutEstimate`, `payoutQuote` or `sellQuote`.          | Match the exact step to gateway/provider logs. Retry after route/service recovery. At payout/sell stages, funds may already have moved.                                          |
| `QUOTE_EXPIRED`        | Quote validation returned an expiry error.                                                         | Inspect deadline and saved step. Resume may revalidate the same step and fail again; fix stale quote preparation if needed. Do not extend deadlines manually.                    |
| `TARGET_ILLIQUID`      | The Fusion estimate/preview cannot satisfy the required amount or minimum output.                  | Check the executable quote, not just token-catalog membership. Wait for liquidity; a different token/amount requires a separately reviewed plan after reconciling current funds. |
| `FUSION_UNAVAILABLE`   | Rejected HTTP response at Fusion estimate, preview, order or permit preparation.                   | Inspect the Fusion gateway/provider response status; retry after recovery.                                                                                                       |
| `PROVIDER_<status>`    | Other rejected HTTP response, with the numeric status appended.                                    | Inspect the step and backend mapping. Do not interpret the suffix as a provider's business-error name.                                                                           |
| `REJECTED_<step>`      | Native parsing, chain/amount/binding or other validation failed while handling a response.         | Inspect sanitized diagnostics and reproduce with a fixture. Treat repeated rejection as an integration issue; do not disable the guard.                                          |

For example, `REJECTED_targetChain` points to the target-chain validation boundary.
It does not prove that an upstream service was unreachable. Likewise,
`QUOTE_REJECTED` at `payoutEstimate` is a different route from the initial funding quote.

## Funds, fees and credit pauses

| Code                                              | Meaning                                                                                                | Next action                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWAITING_DEPOSIT`                                | Selected source budget is zero.                                                                        | Read the actual selected source balance/network; a portfolio total can include other accounts. Retry after confirmed funding.                             |
| `INSUFFICIENT_SOURCE_BALANCE`                     | Requested amount exceeds the selected source balance during planning.                                  | Confirm spendable funds and choose an affordable amount in a new reviewed plan.                                                                           |
| `SOURCE_BALANCE_CHANGED`                          | Source no longer covers the saved budget at execution-time validation.                                 | Reconcile other spending/reservations first. Restore sufficient available funds or prepare a revised plan; approval does not override this check.         |
| `FEE_EXCEEDS_BUDGET`                              | Funding fee cap consumes the budget.                                                                   | Recheck fees later or revise the budget before approval. Do not reduce the fee guard.                                                                     |
| `FEE_UNSTABLE`                                    | Funding preparation exhausted its bounded fee/requote attempts.                                        | Wait and inspect sponsorship fees. Retry may encounter the same bound; persistent failures need engineering review.                                       |
| `FUNDING_REVERTED`                                | Funding receipt reports execution failure.                                                             | Inspect the saved transaction/UserOperation result and actual balances before a replacement operation.                                                    |
| `FUNDING_FAILED`, `FUNDING_REFUNDED`              | Route status reports failure or refund.                                                                | Reconcile source funds and provider status. “Refunded” is not sufficient evidence that Home's displayed balance is current.                               |
| `PRIVATE_BALANCE_UNAVAILABLE`                     | Payout-only authentication/balance request returned 401.                                               | Fix private-balance authentication and retry. Do not assume a balance or substitute a deposit quote.                                                      |
| `PRIVATE_CREDIT_UNAVAILABLE`                      | Pre-approval authenticated-history probe did not return 2xx.                                           | Check `/v1/swap/aurora/history`, adapter capability and provider configuration; no sale order should start until this boundary succeeds.                  |
| `PRIVATE_CREDIT_AUTH_REQUIRED`                    | Private-sale authentication/history returned 401; access is cleared and the core returns to auth salt. | Preserve verified sales/credits; explicitly Resume after restoring authentication. Never substitute aggregate balance growth or a route-minimum fallback. |
| `NO_PRIVATE_BALANCE`                              | Authenticated payout-only balance is zero.                                                             | Check the correct wallet/asset and prior credit evidence; do not sign a payout with invented funds.                                                       |
| `NO_HOLDINGS`                                     | Selected sell holders have no target-token balance.                                                    | Refresh holdings and verify the selected token/owned holders. Do not repeat sell authorization for an empty holding.                                      |
| `NOTHING_TO_RECOVER`                              | Recovery scan found no USDG in its bounded range.                                                      | Inspect previous operations and allocation history. This is not proof that every wallet or asset has zero funds.                                          |
| `HOLDER_<n>_HOLDS_ETH`, `RECIPIENT_<n>_HOLDS_ETH` | Unexpected native ETH violates the selected holder/recipient assumptions.                              | Engineering reconciliation is needed; do not sweep funds or bypass the condition as a debugging shortcut.                                                 |

Public-funded buys have a specific 401 fallback after route-confirmed credit:
they can use that funding quote's guaranteed minimum as their credit basis; they
must not consume pre-existing private cash. Payout-only flows cannot use that
fallback. Private-completion sells also require authenticated operation history,
matching quote/deposit identity, exact amounts, timing and verified Fusion hashes.
An unmatched history row waits; invalid evidence fails validation; neither is
success merely because public route status is SUCCESS. See the core's `Authenticate`/`Balances` handling before
comparing apparently different behavior between flows.

## Payout and order reconciliation pauses

`<n>` is a one-based payout or order number. Buys use one to five recipients;
full-token private sells may span many owned holders, and create no payout legs.

| Code                                       | Meaning                                                                                                                                  | Next action                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYOUT_<n>_FAILED`, `PAYOUT_<n>_REFUNDED` | Provider reports an unsuccessful payout leg.                                                                                             | Reconcile that leg and private/destination balances before any replacement payout. Other legs may have succeeded.                                                 |
| `FUSION_<n>_ORDER_HASH`                    | Returned order hash disagrees with the locally checked order.                                                                            | Stop and investigate gateway/order construction. Fresh approval cannot legitimize a mismatched hash.                                                              |
| `FUSION_<n>_ORDER_<reason>`                | Unsigned order failed a specific native check. Reasons: `BINDING`, `BELOW_MINIMUM`, `TRAITS`, `EXPIRY`, `SALT`, `EXTENSION`, `RECEIVER`. | Inspect the order validator. Minimum/expiry failures can trigger bounded requotes before pausing; other structural failures require a fix, not repeated approval. |
| `FUSION_<n>_FILL_REVERTED`                 | A reported fill transaction reverted.                                                                                                    | Reconcile provider fills, receipts and balances before trying remaining execution.                                                                                |
| `FUSION_<n>_UNRECONCILED`                  | Reported fills, receipt transfer logs or observed balances disagree with invariants.                                                     | Preserve evidence and investigate. Do not count the order as complete or create a duplicate order.                                                                |
| `FUSION_<n>_UNFILLED`                      | Remaining amount persists after bounded fill attempts.                                                                                   | Reconcile partial fills and residual funds; completing the remainder requires the supported recovery flow and any fresh approval it requests.                     |

## Approval, expiry and unknown submissions

- **“Quote changed outside the approved limits”** is a review request, not a pause
  code. Inspect the replacement terms; approving authorizes those terms. Cancelling
  cannot reverse money already moved.
- Signing authorization lasts 15 minutes in this swap engine. `Unlock` requests
  a new passkey unlock for the same plan; it is different from approving new terms.
- `OPERATION_EXPIRED` means the 24-hour operation lifetime elapsed. Retry does not
  extend it. Reconcile funds and use an appropriate recovery path; do not edit timestamps.
- A transient response at `fundingSubmit`, `payoutSubmit` or `fusionSubmit` switches
  to receipt/status lookup rather than signing again. Some paths permit bounded
  resubmission of saved payloads after polling. Do not manually reproduce a submit
  request or describe Resume as “only checking.”
- Exported engine state contains signed payloads. Keep it encrypted; public status
  is the appropriate diagnostic surface. Never paste an exported journal into a ticket.

## Where to inspect logs

| Layer                    | Location / filter                                                             | What it establishes                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React Native development | Metro `[swap]`                                                                | UI/native call started, returned or failed. A returned call is not settlement.                                                                                                   |
| Android native           | Opt-in `GizuSwap` log tag                                                     | Persisted phase/step/pause, request sequence, response status and duration. Status 0 means transport failure.                                                                    |
| iOS native               | Console subsystem `io.gizu.storedwallet`, category `ceremony`                 | Native ceremony stage and classified failure. Do not assume Android's per-request trace exists on iOS.                                                                           |
| Backend                  | Local backend terminal or deployed service logs: `swap.gateway`, `swap.error` | Route, gateway status/timing and classified application error; gateway events carry request IDs.                                                                                 |
| Aurora adapter           | Backend `swap.provider`                                                       | Fixed operation label, upstream status, header-response latency and transport outcome. These events lack gateway request IDs; time correlation is approximate under concurrency. |

Android capture, for the selected connected device:

```sh
adb shell setprop log.tag.GizuSwap DEBUG
adb logcat -v time -s GizuSwap:D '*:S'
# Disable verbose swap logging after capture:
adb shell setprop log.tag.GizuSwap INFO
```

Record a short time window around one attempt. Never include API keys, bearer tokens,
passkey material, backup contents, signed payloads or raw provider bodies. Keep
addresses and transaction hashes out of general shared logs; inspect necessary
public transaction evidence privately and deliberately.

## Investigation handoff

Include version/platform, time zone, direction/network/token, phase/step/code,
HTTP status, gateway request ID if available, and whether approval/submission had
already occurred. State separately what was observed, inferred and still unknown.
Choose one next action: service fix then retry, reconciliation of existing work,
or fresh native approval of changed terms. If evidence is insufficient, say so.

For design context, see [Swap architecture](../feature-plans/SWAP_ARCHITECTURE.md)
and [persistence/recovery boundaries](../feature-plans/SWAP_PERSISTENCE.md).

## Source map

- [Shared swap engine](../../mobile/modules/gizu-stored-signer/core/src/swap/engine.rs): `public_status`, `respond`, `handle`, `lost_submit`, `retry`, `unlock`.
- [Fusion validation](../../mobile/modules/gizu-stored-signer/core/src/swap/fusion.rs): `OrderReject` and checked order fields.
- [Android orchestration](../../mobile/modules/gizu-stored-signer/android/src/main/java/io/gizu/storedwallet/swap/SwapEngine.kt) and [iOS orchestration](../../mobile/modules/gizu-stored-signer/ios/Swap/SwapEngine.swift).
- [Gateway logging](../../backend/src/http/routes/swap.routes.ts) and [Aurora diagnostics](../../backend/src/adapters/aurora/diagnostics.ts).
- [Swap flow](../feature-plans/AURORA_SWAP_FLOW.md), [portfolio and recovery](NATIVE_SIGNER_PORTFOLIO.md), [device setup](SWAP_DEBUGGING.md).

This documentation review checked source mappings only. It did not rerun provider
probes, functional/native tests, passkeys or funded recovery acceptance.
