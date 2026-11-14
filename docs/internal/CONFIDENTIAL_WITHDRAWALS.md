# Confidential proceeds and public withdrawals

The Android app separates exiting an investment from making funds public.
Incoming public USDC and the existing public funding paths remain unchanged.
Reviewed against repository source on 14 November 2026; dated test/device
results below are historical, not a new execution or deployment check.

## User flows

- New vault exits redeem the saved investment portions and finish after their
  return routes have verified confidential USDC credit. Vault positions aggregate
  the value across their investment wallets, with sequential exit progress.
  The USDG withdrawal screen guides users through withdrawal and private return
  with one next action. An unfinished unsigned review can be replaced with fresh
  terms; native cancellation must succeed first. Signed or uncertain transactions
  retain their saved recovery path. Expired on-screen reviews refresh before
  approval, and final private credit is verified before continuing to another part.
  Full native financial reviews have a separate five-minute reading window that
  starts when shown, rather than sharing the preparation timeout. Outside taps
  do not dismiss them, and the screen stays awake during review. Cancel, Back,
  screen lock and app departure still cancel approval. Reading time never extends
  signing terms: exact details, current state and expiry are checked again before
  signing. Network work before and after review retains its own timeout.
- New token sales finish with confidential USDC. Completion requires authenticated
  credit for each inbound route, including partial fills; an aggregate private
  balance or a successful route status alone does not prove sale-specific credit.
- **Withdraw from Gizu** makes an explicitly chosen private-USDC amount public.
  The existing distribution algorithm selects 1–5 fresh user-owned receiving
  wallets on Monad. The input budget includes route fees, so the native review
  shows both the exact debit and guaranteed minimum net output.

Confidential cash uses the existing swap confidential account and saved or
discovered Earn-cycle confidential accounts. The supported asset is Monad-origin
USDC in the existing confidential Intents environment, rather than a native NEAR
balance. Public payouts use chain 143 and USDC
`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`.

## Requested Robinhood vault withdrawals

The amount selector accepts a vault-level USDG amount before fees, with **Max**
for a full withdrawal. Fresh per-wallet shares and `previewRedeem` observations
provide capacity. Allocation follows existing cycle/slot order: full earlier
wallets and, if needed, a partial final wallet. Unselected shares stay invested;
there is no full redemption followed by redeposit. Integer base units and
ERC-4626 rounding apply throughout.

The optional proposal fields `requestedWithdrawalAtoms`, `withdrawalRequestId`
and `withdrawAllShares` bind the requested portion. `amountAtoms` remains the exact
selected shares; absent portion fields preserve legacy full-withdrawal rules.
Ordinary amounts use `previewWithdraw`; Max selects every held share directly.
Native preparation and signing independently verify held shares and
`previewRedeem(selected shares)`, with assets bounded from requested minus one
base unit through requested plus the greater of one base unit or 10 bps. The
native review displays shares, asset preview, tolerance and fees. UI observations
cannot authorize spending.

Each private return binds `withdrawalOperationId` and `returnBudgetAtoms` to the
canonical redemption receipt in the same wallet/cycle/slot. The actual Withdraw
event establishes its gross proceeds. Only those proceeds fund the return;
unrelated public reserves remain outside its budget. With shares remaining, the
planner retains the next-withdrawal reserve of 2.6 times the source redemption's
approved fee cap. Native admission rechecks that reserve, available funds,
source identity and non-reuse by another signed return. The return credits
private USDC in Account 2 under the existing quote and minimum-credit checks.

A wallet/profile-scoped saved UI request records the request ID, total and
allocated portions without signing authority. Pending native work is recovered
before another amount can be entered; missing UI cache falls back to native
recovery without widening the amount. A completed request stays complete across
later partial withdrawals. The remaining position stays invested, and another
withdrawal requires a new amount and approval. Existing signed retries preserve
their EntryPoint nonce; only one canonical winner can advance. Expired attempts
recover receipts without becoming sendable again.

Whole-request preflight checks every portion's simulated redemption and route
feasibility before approval, so a predictably unroutable small portion does not
strand earlier portions. Its conservative fee envelope is four times the
redemption cap with shares remaining, or 2.6 times for a full exit. The final
private-USDC minimum still comes from a fresh quote after canonical redemption.
Capability negotiation rejects unsupported native clients; older strict backend
schemas fail visibly rather than falling back to a full redemption.

### Progress, refunds and completion

Withdrawal reuses the deposit's `ProgressLadder` presentation with four stages:

1. Withdraw funds from vault.
2. Quote ready for confidential transaction.
3. Funds sent to confidential wallet.
4. Funds received.

Read-only polling reconciles signed origin receipts and supported Aurora route
status while the screen remains open. Provider SUCCESS alone never completes
**Funds received**; the native minimum-credit receipt does. Polling cannot plan,
execute or resume a financial action. Completion is saved once in the encrypted
native journal and remains terminal after the private USDC is spent.

REFUNDED means the route returned public USDG, not that private USDC was received.
Home and the withdrawal view show **Aurora returned your funds. You can try
again.** and the available public USDG. **Try private return again** requests a
fresh quote against the original redemption proceeds; it never redeems the vault
again. Confirmation and fresh spending approval remain mandatory, including for
legacy returns that had a cached grant. A validated refund releases only that
failed incoming-credit/source reservation. A later successful private-return
receipt is still required to complete the withdrawal.

Native refund observations bind wallet, generation, full proposal, state binding
and origin transaction. A bound refund is terminal for origin reconciliation
but is not private-credit evidence. Authenticated encrypted recovery validates
the terminal record under its source generation before rebinding to the current
generation; nonterminal observations and read errors are discarded. Neither
refund restore nor lifecycle correction creates a credit receipt or approval.

Robinhood private-return provider deadlines allow 30 minutes for settlement;
local quote/signing expiry remains at most ten minutes. Other routes and native
approval lifetimes are unchanged. Earn uses ordinary route status and its saved
minimum-credit evidence, without the invite-only account-history endpoint. A
read failure is shown as unavailable, not completed, refunded or permission to
send again. Historical owner-confirmed correction is described in the
[Earn integration reference](CONFIDENTIAL_EARN.md#user-actions).

### Recorded verification

On 14 November 2026, the withdrawal correction at `4803364` passed 1,104 mobile
tests in 112 suites and the backend suite (486 passed, 12 optional skips, no
failures). Native results were 577 passed out of 584, with seven pre-existing
`EarnDepositPreparerTest` fixture failures using 0.099 USDC below the established
0.17 routing minimum. Typechecks and the production Android release build passed.
The api.gizu.io build was installed preserving data after owner-confirmed backend
deployment. Device inspection verified the existing refund ladder, Home's USDG
quantity and a fresh read-only retry quote; the quote was dismissed without
approval. A new live private return was not submitted. These are dated results,
not a claim that cleanup reruns native or live financial acceptance.

## Native authority and recovery

Native code derives sources and receivers, authenticates fresh source balances,
and saves the allocation, receiver indices and quote bounds in an encrypted
journal before requesting spending approval. JavaScript supplies the chosen
amount and saved operation identity; it does not select source accounts,
recipient addresses or allocation weights.

Exact source debits and receiver budgets each sum to the chosen amount. Native
review binds the actual private-transfer payloads, fee limits and destinations.
Signed bytes are persisted before submission. A retry reconciles uncertain work
first, keeps the same allocation and destinations, and never repeats paid
children. Changed unsigned terms require fresh review. Partial quote failures
retain a readable saved operation, and completed payouts remain complete.

A shared private-spending exclusion prevents unfinished swaps, deposits,
withdrawals and cashouts from spending the same funds. Signed or uncertain work
retains exclusion; an entirely unsigned cashout can be cancelled. Historical
cancelled swaps containing signed private payouts remain blocked because a
cancellation flag does not retract those signatures; they require separate
recovery handling.

Saved legacy sales without the new confidential completion policy retain their
original public-payout behavior. Previously authorized vault public withdrawals
retain recovery controls, while new public payouts start through Withdraw from
Gizu. Neither legacy signing policy nor saved destinations is reinterpreted.

Portfolio refresh invalidates affected public and private observations after
credits or debits. Stale balances remain visibly incomplete until canonical reads
finish, preventing sold holdings and private proceeds from being valued twice,
or newly credited receiving wallets from retaining a fresh cached zero.

The pinned Robinhood USDG vault uses Morpho Vault V2, whose `maxRedeem` view
[always returns zero](https://docs.morpho.org/developers/contracts/morpho-vaults-v2/).
Native sponsored withdrawal and retry validation bind the exact selected shares
(the full canonical balance for Max/legacy full exits), rather than treating this
view as a liquidity limit. The planner still
simulates the exact redemption, and native code retains its exact router calldata,
owner, nonce, deadline and fee checks. Actual execution can revert if vault gates
or liquidity change before inclusion; a quote is not a guaranteed withdrawal.

Historical bundler lookups normalize provider `null` deployment fields to absent
fields before signature and UserOperation-hash verification. Signed submission
requests retain their strict original schema. Robinhood deposits, redemptions and
returns advance from verified canonical execution receipts, without waiting for
the delayed L1 finalized head. Native reconciliation still checks the exact
signed UserOperation, EntryPoint event, token transfers, fee bound and canonical
block hash twice. Other chains retain their existing receipt policy. Canonical
execution does not prove private credit: the return remains awaiting settlement
until its saved route reports success and authenticated private balance evidence
meets the bound credit amount. A zero share balance alone cannot complete it.

For legacy exact-settlement clients, Aurora's quoted `amountOut` is an expected
output, rather than a maximum execution amount. The historical
`maximumCreditAtoms` field remains the bound for ordinary
balance-delta evidence. If the authenticated credit exceeds that estimate, an
updated client requests `operation-history-v1` using the
`x-gizu-settlement-proof` header. The backend requires one exact authenticated
history record matching the saved route, owner, recipient, input asset/amount and
origin transaction, with output equal to the observed balance delta and at least
the approved minimum. Missing access or ambiguous history leaves verification
pending; there is no tolerance increase or credit clamping. The sealed proof keeps
its verification method across restart and balance consumption, and subsequent
funding/payout checks revalidate it. Older clients continue using the existing
bounded balance-delta method. This compatibility path does not define the current
Earn minimum-return method: that method accepts a verified delta at least the
saved minimum and replays its durable receipt without account history. Keep the
two proof types distinct. New confidential token sales still use authenticated
operation history in the swap core; unavailable provider entitlement blocks that
separate flow rather than justifying weaker credit evidence.

Home offers a read-only wallet unlock when the shared private-balance session is
locked. The in-memory grant survives ordinary app switching, and ends on screen
lock, wallet lock/sign-out or app restart. Earn and cashout reads use the same
grant; spending approvals stay separate. It refreshes the aggregate across native
confidential accounts after authentication. Existing observations can remain
visible, and known cached amounts may contribute an estimated/incomplete USD
portfolio value. They never authorize spending or prove settlement; refresh
failures must not silently replace them with zero. See the shared
[portfolio rules](NATIVE_SIGNER_PORTFOLIO.md).

Robinhood return planning estimates gas using a temporary, full nonzero-byte
recipient whose USDG balance is verified as zero at the reference block. The old
burn-address probe already held USDG, so it underestimated the cost of creating a
fresh route recipient's token balance and caused `EARN_RETURN_QUOTE_FEE_CHANGED`
after redemption. The probe never receives a live transfer. The planner still
issues one immutable route quote, checks the exact recipient's fee against the
bounded budget, and simulates the final calls. Return-specific errors identify
the USDG already held in the investment wallet; they do not suggest redeeming
the vault again. The review displays the verified routing fee instead of a
hardcoded 0.02%. Planner changes require a backend release to the AWS-hosted
`https://api.gizu.io`; updating the APK alone does not publish them.

## Backend and privacy

The matching backend exposes:

- `POST /v1/swap/aurora/history`: bounded authenticated history for one deposit.
- `POST /v1/earn/native/cashout/prepare`: authenticated source availability and
  exact-input quote preparation.
- `POST /v1/earn/native/cashout/status`: operation-specific credit and public
  receipt reconciliation.

Cashout submission reuses the existing Aurora submit-intent route. Backend
processing receives addresses transiently, but adds no readable address catalogue
or user-to-wallet mapping. The native catalogue stays on the device; see
[wallet discovery and recovery](WALLET_DISCOVERY_RECOVERY.md).

Paid settlement requires exact authenticated history and a successful canonical,
finalized chain-143 USDC receipt after the saved reference block. The existing
PostgreSQL coordination store atomically binds each receipt transaction/log event
to one immutable cashout child. Only keyed opaque commitments are retained in
that table. Identical-child retries are idempotent; a receipt cannot pay another
equal-value child across backend restarts or replicas.

## Deployment and limits

Deploy the matching backend routes before using the updated native app. Preserve
the durable PostgreSQL store and stable `EARN_GATEWAY_RECOVERY_KEY`: encrypted
recovery envelopes and effectively permanent receipt commitments depend on them.
Missing configuration, unavailable coordination or ambiguous evidence fails
closed. New sales probe authenticated history before financial review or any
Fusion permit/order, so an unavailable route stops the sale before funds move.

Android advertises `confidentialWithdrawals` and `confidentialSaleProceeds` on
eligible builds. Swift supports its shared-core private sale continuation but
does not expose the Android public-cashout native capability or UI; shared Rust
code is not proof of platform parity. Older builds and unsupported platforms
must not simulate successful execution. A native rebuild is required; backend
deployment alone does not update an installed app.

| Boundary                     | Current limit                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Chosen input                 | Positive canonical u64 atoms, six USDC decimals                                                             |
| Private sources per cashout  | 32                                                                                                          |
| Fresh receiving wallets      | 1–5                                                                                                         |
| Transport children           | At most sources + receivers − 1, maximum 36                                                                 |
| Public receiving index bound | Rust portfolio/swap/cashout paths check a high-water of 8192; this is not the general role-registry maximum |
| Encrypted journal plaintext  | Less than 8 MiB; terminal history is retained without compaction                                            |
| Quote lifetime               | At most 60 seconds; large sequential preparations may need another review                                   |

Reserved receiver indices are never reused, including after unsigned failures.
Storage-capacity failures retain the previously committed journal and do not
permit submission of bytes that were not durably saved. These are finite local
capacity limits. Live provider compatibility and funded settlement remain
operational qualification steps; automated tests and device installation do not
establish successful live cashout.

## Implementation references

- [Cashout planner and signer](../../mobile/modules/gizu-stored-signer/core/src/confidential_withdrawal.rs)
- [Android cashout orchestration](../../mobile/modules/gizu-stored-signer/android/src/main/java/io/gizu/storedwallet/withdrawal/ConfidentialWithdrawalEngine.kt)
- [Swap policy and credit verification](../../mobile/modules/gizu-stored-signer/core/src/swap/engine.rs)
- [Backend cashout gateway](../../backend/src/adapters/earn/confidential-cashout.ts)
- [Cashout screen](../../mobile/src/features/wallet/ConfidentialWithdrawalScreen.tsx)
- [Vault exit completion](../../mobile/src/features/earn/ExitCompletionPanel.tsx)
