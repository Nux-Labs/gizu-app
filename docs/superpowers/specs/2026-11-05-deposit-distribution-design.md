# Algorithm-selected investment wallets for deposits

Date: 2026-11-05
Branch: `feat/distribution-algorithm`
Base: `7415714` (latest main when work started)

## User-approved behavior

Replace the fixed 10% hold / 90% investment policy for new deposits. Use the
existing wallet distribution algorithm to choose the number of wallets and their
shares. Every selected wallet invests in the chosen supported vault. Existing
deposits retain their saved wallets, policy, signing payloads and recovery path.

## Current implementation

- `core/src/swap/legs.rs` selects one to five wallets and weights totaling 10,000
  basis points. Native callers supply fresh randomness. Swap persists the result
  before review and never rerolls it during retry.
- Earn derives a holding wallet, investment wallet and confidential identity for
  each cycle. Source funding may use multiple public accounts.
- Earn splits verified confidential credit into two payouts, then deposits only
  the investment wallet's received assets, less gas and withdrawal reserves.
- The two-wallet contract is enforced in TypeScript, Kotlin, Rust and backend
  payout preparation. It also appears in approvals, journals, portfolio reads,
  withdrawals and recovery; this is not a UI-only percentage change.
- Android Robinhood uses a guided native deposit with one bounded passkey
  approval. Ethereum uses separate native approvals for its existing stages.
  Full deposit execution is not currently available on iOS.

## Approaches

1. Retain 10% holding and distribute 90% among investors. The user explicitly
   rejected this behavior.
2. Replace the split with an immutable all-invest distribution plan. Selected
   wallets receive independent confidential payouts and invest in the same vault.
   This is the selected behavior.

Implementation choice: keep one confidential account per Earn cycle and generalize
its destination list, rather than splitting the entered budget into unrelated
deposit cycles. This preserves the existing funding/credit sequence, avoids extra
source-funding operations, and keeps the investment together for progress and
recovery.

## Distribution plan

- Choose the count and weights from the entered source budget, using the existing
  `choose_buy_legs` algorithm unchanged. No separate algorithm or new tier table.
- Persist a versioned plan natively before requesting destination quotes. Bind its
  identity, chain, vault, wallet slots, weights and derived recipients to the cycle.
- Every destination is an investment wallet. There is no intentionally held 10%.
- Apply the saved weights to verified confidential credit, not the original source
  budget. Per-recipient payout fees can make the net received shares differ from
  the input allocation weights.
- With several funding sources, calculate each wallet's share of the cumulative
  credit and subtract its prior cumulative allocation. Give the final wallet the
  integer remainder. This conserves the full input exactly, irrespective of source
  fragmentation and rounding.
- Refuse zero/uneconomic legs before new spending; never silently change wallet
  count, redistribute funds or reroll a persisted plan to make a quote work.

## Wallet identities and compatibility

- Use a new, versioned derivation domain for distribution investment slots. Keep
  the existing confidential account and every legacy derivation unchanged.
- Native policy validates slot bounds, chain, cycle, plan identity and derived
  recipient. JavaScript and backend requests cannot supply arbitrary recipients
  or override the saved native plan.
- Proposals and backend requests explicitly distinguish distribution operations
  from legacy hold/invest operations. Missing distribution fields mean the legacy
  policy, never an implicit migration.
- Saved backups preserve the distribution metadata needed to discover the same
  addresses and positions. Restore retains existing reconciliation requirements.
- Capability checks prevent the new UI from requesting unsupported operations
  from older native builds. Existing legacy records remain readable/resumable.

## Execution, approval and recovery

- Review shows the wallet count, allocation weights, recipient addresses and
  per-wallet minimum investment, maximum fees and withdrawal reserve.
- Preserve Robinhood's single bounded native approval for the whole reviewed
  deposit. Ethereum keeps its existing stage approvals, extended to the selected
  wallets. Do not create extra unchecked signing authority.
- After all funding credits are verified, prepare/submit the per-source,
  per-wallet payouts using the immutable plan. Independently verify receipts.
- Each selected wallet gets its own vault deposit and its own gas/withdrawal
  reserve. The same vault is used by all wallets in the investment.
- Track funding, payout and vault-deposit children by stable plan/slot identities.
  Retry only unresolved work. Completion requires every wallet's investment to be
  independently verified; partial success is shown and retained.
- Expiry, app backgrounding, cancellation, uncertain submission and refreshed terms
  retain existing approval and recovery guarantees. Reading status never spends.
- Portfolio values aggregate all investment wallets. Position detail and withdrawal
  use the matching wallet slot and reserve. Submitted and completed children are
  never repeated because another wallet's operation failed.

## Scope

Implement the above in the currently supported Android deposit paths and shared
Rust/backend/TypeScript contracts. Preserve existing iOS capability gates; do not
claim full iOS deposit support. No live transactions, deployment, branch merge or
push is part of this implementation request.

## Verification

- Baseline shared Rust suite: 188 tests passed before changes.
- Add failing tests before implementation for allocation conservation, stable
  retry/restore, legacy compatibility, wrong slot/recipient/weight rejection,
  approval bounds, partial investment and per-wallet withdrawal ownership.
- Cover one, two and five investment wallets and uneven multi-source credits.
- Exercise real mobile screens/controllers with native/provider boundaries mocked.
- Run Rust, backend and mobile suites, type checks, native Android unit tests and
  applicable build/format checks. Report unavailable checks separately.
- Local and mocked tests do not establish funded device execution.

## Implementation sequence

1. Versioned plan, deterministic derivation and amount allocation rules with tests.
2. Backend payout contracts and native signing validation for plan/slot bindings.
3. Native plan storage, backup compatibility, reviews and per-wallet orchestration.
4. Portfolio/withdrawal ownership and recovery of partial completion.
5. Mobile contracts, review/progress UI, capability gating and functional coverage.
6. Integrated verification and independent whole-change review.
