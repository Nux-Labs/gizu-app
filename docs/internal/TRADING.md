# Trading and transfers — M4

Source reviewed 2026-11-14. This reference preserves M4's historical fixture
contract, exercised through injected mock services in automated tests. These
fixtures have no real credentials, live quotes or on-chain settlement. They are
not normal startup or a production API specification.

Normal Home Receive/Send shows the public Monad USDC address and unsupported direct
Send. Native Swap uses the [confidential swap contract](../feature-plans/SWAP_ARCHITECTURE.md);
full-holding sells retain verified USDC proceeds privately, and
[Withdraw from Gizu](CONFIDENTIAL_WITHDRAWALS.md) is a separate capability-gated
private payout. Live catalog deposits and saved vault withdrawals use
[Confidential Earn](CONFIDENTIAL_EARN.md). The explicit testnet debug harness retains
its [native MON transfer contract](NATIVE_SIGNER_TRANSFERS.md). None uses the fixture
fee/minimum rules below. User-facing fixture banners remain omitted by product decision.

## Journeys and ownership

- Fixture Home: Deposit and Withdraw. Fixture vault detail: Buy and Sell. Activity
  combines fixture operation receipts and pre-existing investment history. The old
  coming-soon Swap presentation is historical; `MainTabs` now mounts `NativeSwapScreen`,
  independently from the mock transaction ledger.
- `domain/transactions.ts` owns decimal parsing, fee math, quote calculation and
  balance/minimum validation. All asset amounts use six-decimal base-unit integers
  carried as strings; no floating-point amounts or chart data authorize an order.
- `services/transactions.ts` defines load, quote, sign, submit and status boundaries.
  `createMockTransactionService` owns a ledger, stored quotes, signing results and
  idempotency receipts. These are internal prototype contracts, not agreed backend
  endpoints. Future adapters must preserve authoritative validation and identity.
- `TransactionProvider` is session-scoped and retains operation state across modal
  dismissal/navigation. `useOrderController` owns drafts and stale-quote guards.
  Screens compose shared atoms/molecules with common operation feedback.

## Explicit mock rules

- Account starts with 184,204 USDC; passkey wallet starts with 42,180 USDC.
  Deposit debits the passkey wallet and credits the account; withdrawal reverses
  that direction. No arbitrary external recipient or network selector is added.
- Vault prices/minima come from the investment snapshot, with units from holdings.
  Buy spends account USDC principal; sell spends unlocked vault units. Vault-to-vault
  swaps and arbitrary tokens are unsupported. Changing direction opens a fresh draft.
- A 0.42 USDC network fee applies to each operation. Buy/sell also charge 0.05%
  rounded UP to one USDC micro-unit. Buy adds both fees to the entered principal;
  sell deducts them from gross proceeds. Transfers add the network fee to the
  entered credit amount. Review shows total debit, net receive and aggregate fees.
- Buy output and sell gross proceeds round DOWN to six decimals. Input is a plain
  positive decimal, at most 18 integer digits and six fractional digits. Signs,
  exponent notation, separators, repeated dots and excess precision are rejected.
  Zero/negative net output, insufficient funds and invalid vault IDs cannot advance.
- Buy minima are principal amounts: HLX 25,000; OBS 100,000; VTX 10,000; MRD 5,000
  USDC in the current fixtures. Minimums do not apply to redemptions.
- Max selects the largest spendable principal after applicable fees. 25/50/75%
  use that Max and round DOWN to a micro-unit. Sell Max is unlocked units.
- Initial OBS holdings are locked; initial HLX/VTX holdings are mature and redeemable.
  New purchases in a vault with a lockup remain locked for this session; VTX has
  no lockup. No UI clock unlocks positions or invents a production maturity rule.
  Review shows lockup and the amount form distinguishes total versus unlocked units.
- Quotes last 60 seconds and bind the account revision. The mock revalidates at
  signing and submission. An expired/changed quote requires a fresh review.

## Operation lifecycle

1. Validate → request quote → review → explicit Confirm buy/sell/deposit/withdrawal.
2. Sign → submit once using the operation key → pending or unknown → check status.
3. The adapter response determines confirmation or failure. The default mock returns
   pending from submit and confirms when status is checked. Delayed scenarios require
   another status check. There is no UI timer that marks an operation successful.

One unresolved operation is allowed per session. Duplicate confirmation is guarded
synchronously; the mock also binds each quote to one operation key and returns the
same receipt for retries of that key. Unknown submission never offers blind retry.
Check status reconciles its original key; status failures retain that operation.

Before confirmation, closing discards the draft/quote and ignores late quote results.
During signing, Cancel signing invalidates the attempt and ignores late authorization.
Closing alone does not cancel signing or submission. Once submitted, dismissal does
not cancel it: Home, vault details and Activity reopen status. New orders are blocked until
it resolves. Known rejection/non-acceptance/failure allows a new review with the
amount preserved. No auto-dismiss or automatic resubmission occurs.

Balances and holdings update exactly once on confirmed receipts. Available USDC is
shown separately from vault holdings value. Existing fixture valuations are retained
with operation unit-value deltas; synthetic historical charts/daily returns are not
rewritten as live performance. A failed balance reload is shown separately from a
confirmed operation and blocks further orders until recovery. Refreshing investment
history does not overwrite a changed session trading ledger.

Disconnect/restart resets this memory-only mock ledger and operation history.
Native flows already use separate durable journals; fixture dismissal support does
not promise recovery across app restarts or real network execution.

## Deterministic scenarios and tests

Inject a service through `AppRoot.transactionService`, or create one with
`createMockTransactionService(snapshot, {scenario, now})`. The supported scenarios
are normal, rejection (first signature), failure (first submit before acceptance),
delayed (two status checks), unknown (accepted but submit response lost), and
settlement-failure (no balances changed). An injected clock tests expiry without sleeps.
No scenario selector or arbitrary mock controls are included in customer UI.

Functional tests under `tests/functional/transactions/` render real providers,
navigation and controllers with mocked boundaries. They cover all four success
journeys, percentages/Max, minimum/lockup and malformed-input validation,
quote failure/expiry, rejection/retry, cancellation, pending dismissal, status
recovery and duplicate prevention. Unit tests check exact rounding and validation;
mock-adapter integration tests check idempotency and settlement ledger invariants.
These do not prove biometrics, gestures or on-chain execution.

The test coverage described above is retained implementation evidence, not a report
that the suite or funded execution was rerun during this documentation review.
