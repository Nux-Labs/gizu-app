# Funding expansion feasibility audit

Date: 2026-11-26, Europe/Istanbul. Branch: `feat/funding-expansion`.
Audited application source: main `23a82ec77bf568b277b01f8d004497798cafcd40`.
This audit changes documentation only. It does not qualify a production release.

## Decision

Base and Arbitrum funding into the **existing canonical private USDC asset** is
supported at the live quote/API level. Reuse the existing Account 1,
EIP-7702/Pimlico signing infrastructure, encrypted source journals, portable
credit envelopes and private-funded execution paths. Do not add the proposed
standalone Rust funding-pool object or backend funding-credit table as a
prerequisite: their necessity was not established, and existing mechanisms cover
the ordinary ordered, resumable funding journey.

Implementation can proceed with the remaining native/adapter gaps below. A real
USDC-paid source transaction, its private settlement, subsequent spending and
interrupted recovery still need funded qualification on each new network before
enablement. No transfer, signed intent, UserOperation submission or deployment
was performed during this audit.

## Public provider checks performed

Probes ran around 02:06–02:16 Istanbul time (2026-11-25 23:06–23:16 UTC).
The accompanying [public evidence JSON](2026-11-26-funding-expansion-public-checks.json)
contains the exact observed timestamps, token quotes and deployment fingerprints.
These observations are time-sensitive, not hardcoded operating fee/minimum values.

| Check                                                 | Monad control | Base               | Arbitrum One |
| ----------------------------------------------------- | ------------- | ------------------ | ------------ |
| RPC `eth_chainId`                                     | 143           | 8453               | 42161        |
| Exact USDC `decimals()`                               | 6             | 6                  | 6            |
| Pinned EntryPoint 0.8 deployed                        | Yes           | Yes                | Yes          |
| Pinned Simple7702 deployed                            | Yes           | Yes                | Yes          |
| Pinned ERC-20 paymaster deployed                      | Yes           | Yes                | Yes          |
| Public Pimlico advertises EntryPoint 0.8              | Yes           | Yes                | Yes          |
| Public Pimlico gas-price RPC                          | Success       | Success            | Success      |
| Public Pimlico exact-USDC token quote                 | Success       | Success            | Success      |
| Aurora registry exact origin asset                    | Listed        | Listed             | Listed       |
| Aurora quote to canonical private USDC, 10-USDC input | Success       | Success            | Success      |
| Same route, 5-USDC input                              | Success       | Success            | Success      |
| Same route, 0.10-USDC input                           | Success       | Rejected, HTTP 422 | Success      |

Public chain RPCs: `https://rpc.monad.xyz`, `https://mainnet.base.org`,
`https://arb1.arbitrum.io/rpc`. Public Pimlico URL:
`https://public.pimlico.io/v2/<chainId>/rpc`; methods:
`eth_supportedEntryPoints`, `pimlico_getUserOperationGasPrice`,
`pimlico_getTokenQuotes` with exact USDC, EntryPoint 0.8 and source chain ID.
The token quotes returned the existing pinned paymaster on all three networks.
Delegate/paymaster runtime SHA-256 fingerprints matched across the three probes.
EntryPoint runtime fingerprints differed; do not require equality with Monad's
runtime as a shortcut for qualifying another deployment.

Aurora asset registry was read through
`GET https://api.gizu.io/v1/swap/aurora/tokens`. Route requests used
`POST https://api.gizu.io/v1/swap/aurora/quote`, synthetic recipient/refund
addresses, `ORIGIN_CHAIN` deposits, `CONFIDENTIAL_INTENTS` recipient,
`ORIGIN_CHAIN` refund, `EXACT_INPUT`, zero slippage and `advanced` confidentiality.
The destination was always
`nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx`.

These were **unfunded `dry: false` quotes**, because the deployed generic proxy
accepts only that value. They allocated deposit addresses but were never funded.
They are not dry previews, transactions or proof of completed private settlement.
For 5-USDC/0.10-USDC successes, assertions checked every submitted request field
in the echo, positive minimum/output bounds, exact input, EVM deposit-address
format and future deadline/inactivity timestamps. The initial 10-USDC responses
were inspected for the same source/destination/mode and positive output; the
raw bindings were not retained in this sanitized evidence artifact.

Observed route outputs, in six-decimal USDC units:

| Exact route input | Monad → private | Base → private | Arbitrum → private |
| ----------------- | --------------- | -------------- | ------------------ |
| 10.000000         | 9.996000        | 9.973975       | 9.973975           |
| 5.000000          | 4.998000        | 4.986987       | 4.986987           |
| 0.100000          | 0.099960        | Rejected       | 0.099737           |

These inputs **exclude source paymaster gas**, so a 15-USDC total-budget plan
must first reserve each selected source's gas and quote the remaining principal.
Do not transfer 10 + 5 USDC and charge gas on top. The observed quote `appFees`
contained the same 4-bps provider collector as the Monad control; the larger
cross-asset output reduction is not explained by that field alone. Preserve the
quoted minimum and qualify the complete route cost; do not assume 1:1 credit.
The 0.10-USDC Base rejection does not establish an exact minimum or its cause:
the public proxy returns a generic rejection. Never hardcode a threshold from it.

The earlier plan overstated the credential blocker for quote checks. Local keys
are absent, but Gizu's already-configured proxy and Pimlico's public read APIs
were sufficient for this audit. Authenticated private-balance/settlement and real
funded wallet checks remain outstanding.

The existing private-USDC outbound routes were also checked with unfunded quotes
for 10-USDC input: private USDC → Ethereum USDC, Robinhood USDG and Base USDC all
returned HTTP 200 with the requested `CONFIDENTIAL_INTENTS` deposit,
`DESTINATION_CHAIN` recipient and confidential refund. Echo/input/minimum bounds
were validated. No private balance was accessed and no transfer intent generated
or signed. This supports reusing the existing execution assets; it does not make
the currently 4663-only private-balance Earn adapter accept Ethereum automatically.

The Ethereum bridge also needs explicit dispatch work: existing legacy
list/resume/reconcile/cancel methods exclude `privateEarnPayout` operations.
Changing only the profile allowlist would leave the new handoff non-resumable.

Provider references, checked during the audit:

- [Pimlico chain support](https://docs.pimlico.io/guides/supported-chains): Base and Arbitrum advertise EIP-7702 and EntryPoint 0.8 bundler/paymaster support.
- [USDC-paid gas from an existing EOA](https://docs.pimlico.io/guides/how-to/payments/send-usdc-without-eth): reuse the EOA address; source USDC must cover transfer plus gas.
- [Aurora quote contract](https://docs.intents.aurora.dev/api-reference/swap-api-reference/request-a-quote): distinguishes dry from executable quotes, exact input, origin-chain refunds and confidential recipients.

## Every identified gap and its implementation disposition

| Area                           | Evidence / gap                                                                                                                                                                                                 | Disposition                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wallet creation                | Existing Account 1 is an EVM key; network does not change its derivation/address. Account 2 already owns shared private USDC.                                                                                  | No new key, account scheme or wallet provider. Add network contexts only.                                                                                                                                                                                                                                                                              |
| Source identity                | `core/src/source_planner.rs` rejects duplicate indices and addresses globally. `FundingReservations.kt` keys by address.                                                                                       | Extend existing source/reservation keys to chain + token + owner/index; preserve v1 Monad decoding.                                                                                                                                                                                                                                                    |
| Source signing                 | `swap/funding.rs` hashes with chain 143 and validates authorization against 143; `earn_sponsored.rs` admits source chain 143 only.                                                                             | Parameterize exact source pins and domains. Test replay rejection across all three chains. Keep target chain separate.                                                                                                                                                                                                                                 |
| Native transports              | `EarnSponsoredRpc.kt` and `/v1/earn/native/bundler/:chainId` allow only 143/4663. Backend Pimlico adapters pin 143.                                                                                            | Extend existing allowlists/dispatch for funding source 8453/42161; do not add those as new Earn destination profiles.                                                                                                                                                                                                                                  |
| Aurora identity                | Swap uses one `source_asset` for both origin and private cash. Native source gateway selects Monad origin unconditionally.                                                                                     | Separate public origin from fixed canonical private asset. Route quotes prove these pairs are offered.                                                                                                                                                                                                                                                 |
| Source fee policy              | Existing qualified `source` fees do not themselves prove a new chain/token pair or an affordable source gas cap.                                                                                               | Bind source identity in v2 proof/review; qualify route fees and per-source gas before approving an exact total budget.                                                                                                                                                                                                                                 |
| Rollup gas                     | Token quotes prove token support, not the cost of Gizu's concrete UserOperation including rollup overhead.                                                                                                     | Qualify cold/delegated unsigned preparation and funded execution; keep existing bounded approvals and validity/nonce checks. Verify native gas-unit caps against real estimates.                                                                                                                                                                       |
| Credit completion              | `ConfidentialSettlement.balanceCredit` already issues `source-credit` envelopes; replay bypasses current-balance dependence after binding checks. Existing regression covers consumption/restart.              | Extend origin admission/binding for new sources; save/replay the existing envelope in each source child. No mandatory new credit table.                                                                                                                                                                                                                |
| Ordering                       | `requireSequentialSourceCredit`, `EarnPrivateCredits.kt` and signed source journals already guard shared incoming credit.                                                                                      | Reuse ordering; make every v2 child visible to these guards. Persist A's credit before capturing B's baseline/submitting B.                                                                                                                                                                                                                            |
| Shared private spending        | Existing payout/withdrawal guards inspect signed work and active private deposit reviews.                                                                                                                      | Reuse/extend them to recognize new parent/children; allow only the same parent's bounded handoff. Unrelated pending work remains blocked.                                                                                                                                                                                                              |
| Coordination durability        | Existing native journals, sealed recovery envelopes, `OperationCoordinator.bind/bindMany` and Postgres coordination already exist. Backend `occupied` alone is process-local.                                  | Reuse existing durable facilities; do not cite the occupied set as the only current safeguard. Prove recovery/duplicate protection with production parent/child guards rather than introducing a parallel ledger.                                                                                                                                      |
| Cross-device/account ambiguity | Current source-credit attribution is bounded balance evidence, not a unique private ledger event. A different device/external inflow can overlap a baseline. Expiring coordination is not permanent ownership. | Preserve existing fail-closed bounds and unresolved-work policy. Do not claim global/external isolation, history-free unique attribution or indefinite ownership from an expiring lease. Broader cross-device serialization is separate hardening, not an automatic new funding component.                                                             |
| Android Swap batching          | `SwapFundingBatch.kt` currently finishes a complete Swap per source.                                                                                                                                           | New batches stop source children at private credit, then invoke one existing private-funded Swap. Preserve saved v1 behavior.                                                                                                                                                                                                                          |
| Swap amount                    | `payout_base()` returns all `data.available` for private-funded mode.                                                                                                                                          | Add an explicitly approved amount at the handoff. A 15-USDC request cannot sweep unrelated private cash. Keep trading/distribution rules.                                                                                                                                                                                                              |
| Robinhood Earn                 | `EarnDepositPreparer`/adapter and `PrivateEarnPayoutOperation` already support existing-private funding, pinned to profile 4663.                                                                               | Hand confirmed combined amount into that existing path using the same saved cycle/recipients. No new pooled payout proof or endpoint.                                                                                                                                                                                                                  |
| Ethereum Earn                  | Separate legacy controller loops source × recipient. Its private-payout proof requires an individual source; the balance-funded private operation/gateway is currently 4663-only.                              | A zero-change handoff is not available. Adapt the existing private-balance funding adapter/native authorization for the existing Ethereum USDC destination and connect the legacy controller and native resume dispatch. Keep its stage approvals, liquidity and vault execution. Do not fake a Monad source transaction or silently exclude Ethereum. |
| iOS                            | Single-operation Swap store, no Android-style source reservation/batch parity, explicit 10,000,000-atom input limit.                                                                                           | Extend existing host/journal and add missing source reservations; reuse Rust planning/signing. Remove only the artificial reviewed-input ceiling. Preserve iOS Earn availability.                                                                                                                                                                      |
| Portfolio                      | Legacy snapshot/validator/`useFundingWallet` assume Monad public cash. Owned assets also include Base.                                                                                                         | Add per-source observations/aggregate cash; migrate callers explicitly. Dedupe by chain/token/owner, account for in-flight movement and reservations. Preserve unavailable/stale information.                                                                                                                                                          |
| Funding UI                     | `AddFunds` already has a network picker.                                                                                                                                                                       | Extend it with the same Account 1 address and correct selected-network context. Gate by native + backend readiness. No downstream chain picker.                                                                                                                                                                                                        |
| Return/withdrawal policy       | Current sales and investment exits return private USDC; public cashout is separate.                                                                                                                            | No policy change. Regression-test private returns and explicit cashout after multi-chain funding.                                                                                                                                                                                                                                                      |
| Cancellation/refunds           | A signature/submission may settle after UI cancellation; source refund must be distinguished from private credit.                                                                                              | Cancel unused work only; reconcile signed children. Qualify origin-chain refunds per source and release reservations only on terminal evidence. Do not automatically redeposit refunded/unknown funds.                                                                                                                                                 |
| Backup/recovery                | Seed/address recovery is not evidence that a lost funding journal settled. Legacy journal AAD/source identities are already in use.                                                                            | Preserve derivations, old AAD and signed payloads; version content. Discover Account 1 balances on new chains without treating discovery as a completed attributable credit.                                                                                                                                                                           |
| Distribution and fees          | Wallet count/weights already derive from original total budget.                                                                                                                                                | Save/reuse once for the entire action. Do not choose wallets again after credits, charge source gas twice or replace the approved 15-USDC budget with a net-target amount.                                                                                                                                                                             |
| Rollout                        | Old clients use Monad endpoints and old signed journals.                                                                                                                                                       | Keep old wrappers/decoders; enable new starts per chain only when backend + native release are qualified. Rollback must preserve reconciliation for signed v2 work.                                                                                                                                                                                    |

`core/` paths in this table are under `mobile/modules/gizu-stored-signer/`;
native class names refer to the existing Android/Swift implementation.

## Why the additional ledger is not a baseline requirement

The existing sequence can be reused directly:

1. Save A's signed submission and original private baseline in its encrypted child.
2. Reconcile A and save its bound `settlementEnvelope` before advancing.
3. Capture B's baseline after A's credit; reconcile/save B the same way.
4. Save the approved combined amount and the handoff child in the existing parent
   journal. Use existing native approval/reservations for private spending.
5. On restart or after later spending, replay A/B's saved envelopes rather than
   attempting to derive their credits again from the present private balance.

This preserves the current attribution model. It does not prove unique
attribution against an indistinguishable external/private-ledger event. A new
table cannot manufacture that missing evidence. Likewise, native-source receipt
consumption and private authorization must remain authoritative; a JavaScript sum
of displayed balances is never a spending grant.

Existing Postgres coordination can bind immutable operation/recipient claims.
Its `expires_at` behavior means it must not be treated as a permanent signed-work
lock without additional design. If an implementation test demonstrates a gap
that cannot be covered by the existing parent/child journals and coordination,
document that exact failure before proposing a new component. Avoid an upfront
global lease system touching all Earn/sell/cashout behavior for this expansion.

## Verification executed

All checks exercised the existing main source; no production feature was patched.

- Backend focused funding/SDK, balance-settlement, private-funding and coordination
  suites: **95 tests; 94 passed, 1 skipped, 0 failed**. The skipped real-Postgres
  atomicity test requires `TEST_DATABASE_URL`, which was not configured. A skipped
  database race is not a demonstrated database pass.
- Rust core: **260 passed, 0 failed** under installed Rust **1.95.0**, with
  `--locked`. The repository-pinned 1.94.1 is not installed here; this is useful
  baseline evidence, not a substitute for pinned-toolchain release CI.
- Mobile planner/service/portfolio/deposit unit suites: **5 suites, 79 tests
  passed**. These do not demonstrate native prompts or on-chain execution.
- Offline viem EntryPoint-0.8 domain vectors for the same unsigned synthetic
  operation produced distinct hashes for 143/8453/42161. Current Rust's hardcoded
  Monad domain must become source-qualified; preserve the legacy 143 vector.
- Android/iOS full builds, device prompts and a real Postgres race were not run
  for this docs-only audit. They remain implementation/release checks.

Commands used:

```bash
# backend/
node --experimental-transform-types --test test/adapters/pimlico/source-funding.test.ts test/adapters/pimlico/source-funding.integration.test.ts test/adapters/aurora/balance-settlement.test.ts test/adapters/earn/confidential-private-funding.test.ts test/adapters/postgres/pg-operation-coordination.test.ts

# mobile/
cargo +1.95.0 test --locked --manifest-path modules/gizu-stored-signer/core/Cargo.toml -- --test-threads=4
npm test -- tests/unit/wallet/portfolioValue.test.ts tests/unit/earn/sourceFunding.test.ts tests/unit/earn/sourceFundingService.test.ts tests/unit/earn/depositJourney.test.ts tests/unit/earn/depositJourneyService.test.ts
```

## Remaining qualification gates

1. On each new chain, prepare the actual source UserOperation with bounded fee
   approval, fresh nonce/delegation and provider validity; qualify rollup overhead.
   Token quotes alone do not prove an affordable transaction.
2. With a controlled funded wallet and an explicitly approved test budget,
   demonstrate source debit → exact canonical private credit → existing private
   spend, including interruption before/after submission and credit persistence.
3. Demonstrate source-specific refund/late-deposit behavior and reservation
   reconciliation; do not infer it from a successful unfunded quote.
4. Prove the Ethereum private-balance handoff against its pinned native policy
   and existing liquidity/vault stage contracts before advertising support there.
5. Run real Postgres races, pinned-toolchain/native builds and device recovery
   checks during implementation. Provider failures, unqualified fees and partial
   chain reads must remain explicit states rather than guessed success/zero.

No additional product question is required to perform the planned implementation.
The remaining unknowns are technical qualification, not a change to the agreed
15-USDC total-budget or private-return behavior.
