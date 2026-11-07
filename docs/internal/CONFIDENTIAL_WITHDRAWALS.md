# Confidential proceeds and public withdrawals

The Android app separates exiting an investment from making funds public.
Incoming public USDC and the existing public funding paths remain unchanged.

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
Native sponsored withdrawal and retry validation bind the full canonical share
balance rather than treating this view as a liquidity limit. The planner still
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

Aurora's quoted `amountOut` is an expected output, rather than a maximum execution
amount. The historical `maximumCreditAtoms` field remains the bound for ordinary
balance-delta evidence. If the authenticated credit exceeds that estimate, an
updated client requests `operation-history-v1` using the
`x-gizu-settlement-proof` header. The backend requires one exact authenticated
history record matching the saved route, owner, recipient, input asset/amount and
origin transaction, with output equal to the observed balance delta and at least
the approved minimum. Missing access or ambiguous history leaves verification
pending; there is no tolerance increase or credit clamping. The sealed proof keeps
its verification method across restart and balance consumption, and subsequent
funding/payout checks revalidate it. Older clients continue using the existing
bounded balance-delta method. Deploy the backend before relying on the new history
path; older backends safely ignore the capability header.

Home offers a read-only wallet unlock when private balance read permission has
expired. It refreshes the aggregate across native confidential accounts after
authentication. Previously checked amounts stay visible with an explicit label;
incomplete observations remain excluded from current portfolio valuation and
cannot authorize spending or prove settlement.

Robinhood return planning estimates gas using a temporary, full nonzero-byte
recipient whose USDG balance is verified as zero at the reference block. The old
burn-address probe already held USDG, so it underestimated the cost of creating a
fresh route recipient's token balance and caused `EARN_RETURN_QUOTE_FEE_CHANGED`
after redemption. The probe never receives a live transfer. The planner still
issues one immutable route quote, checks the exact recipient's fee against the
bounded budget, and simulates the final calls. Return-specific errors identify
the USDG already held in the investment wallet; they do not suggest redeeming
the vault again. The review displays the verified routing fee instead of a
hardcoded 0.02%. Deploy the updated backend planner to Render for this correction
to take effect; updating the APK alone only changes the messages and fee display.

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

The implementation supports Android through the `confidentialWithdrawals` and
`confidentialSaleProceeds` native capabilities. Older builds and unsupported
platforms must not simulate successful execution. A native rebuild is required;
backend deployment alone does not update an installed app.

| Boundary                             | Current limit                                                             |
| ------------------------------------ | ------------------------------------------------------------------------- |
| Chosen input                         | Positive canonical u64 atoms, six USDC decimals                           |
| Private sources per cashout          | 32                                                                        |
| Fresh receiving wallets              | 1–5                                                                       |
| Transport children                   | At most sources + receivers − 1, maximum 36                               |
| Public receiving registry high-water | 8192                                                                      |
| Encrypted journal plaintext          | Less than 8 MiB; terminal history is retained without compaction          |
| Quote lifetime                       | At most 60 seconds; large sequential preparations may need another review |

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
