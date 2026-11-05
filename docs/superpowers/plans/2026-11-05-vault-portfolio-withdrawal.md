# Vault portfolio and withdrawal correction

**Goal:** Include vault positions in portfolio value, display one combined position
per vault in the app's existing design language, and open the correct saved vault
withdrawal flow. This implements the user's requested correction.

**Architecture:** Reuse native chain/vault aggregates and pinned Earn profiles.
Keep Monad spendable `totalAtoms` unchanged; compute a separate display valuation
from liquid balances, owned assets and vault underlying amounts without overlap.
Use fresh prices from the deployed read-only exit snapshot API for USDG; never
assume a stablecoin peg or use residual balances as vault value. One aggregate
vault entry routes into existing native-reviewed cycle/slot withdrawal operations.

**Scope and constraints:** No backend deployment, seed/backup changes or automatic
financial execution. Preserve signed/uncertain work, legacy deposits, recovery
gates, freshness/partial states and per-wallet signing ownership. Current native
withdrawal is full redemption; preserve that policy. User-facing positions are
grouped by vault; underlying execution steps are managed internally. Rebuild and
update the connected phone in place after verification, retaining its signing key
and app data.

## Root causes

- Headline uses `snapshot.totalAtoms`, which means Monad liquid USDC only.
- USDG `valueUsdcAtoms` is null and native valuation completeness is hardcoded false.
- Vault aggregates render inside a generic token accordion using token symbols.
- Vault Withdraw navigates to generic Earn rather than the vault's saved cycle.
- Native operation lists expose only the selected cycle/slot, so aggregate
  withdrawal discovery needs an explicit read-only inventory.

## Work

1. Add failing unit tests for display valuation, de-duplication, unsupported prices,
   expiry/partial observations and large exact integer amounts. Add a bounded
   read-only pricing adapter and separate portfolio total. Record total-value
   history independently from older liquid-only balance history.
2. Replace the Home token accordion with compact asset rows and one position card
   per supported vault. Show aggregate deposited underlying/current value on the
   catalog card and detail page. Keep zero, unavailable and stale observations
   distinct; never render wallet addresses as position entries.
3. Expose a read-only native investment activity inventory without changing the
   active cycle or signing. Route vault Withdraw to its saved cycles/slots, show
   aggregate position plus progress, and reuse existing native full-redemption,
   return and recovery controls. Never select or operate on a different vault.
4. Add functional tests covering Home -> vault -> withdrawal, multiple deposits
   and distribution slots, empty/foreign/recovered states and interrupted work.
   Verify full mobile checks, affected native tests/build and independent review.
5. Build a standalone Render-configured APK, match the installed signing
   certificate, install with replacement and verify the app on the connected phone.

## Review corrections

- Paid receiving withdrawals prove only their own returned amounts. Native
  journal inventory keeps these portions `redeemed`, so unswept ETH/USDG cannot
  disappear behind a premature completed state. Advancement consumes a fresh
  residual check with every return paid. Accepted checkpoints are local to this
  screen and revoked by new investment, pending work or recovery.
- Externally priced display values carry an expiry. The provider removes expired
  values before refreshing, retaining independently read token/share balances.
- Backend exit snapshots now default to the same pinned public Robinhood RPC as
  the other existing planners when `ROBINHOOD_RPC_URL` is absent. The transport
  regression failed before the fix and passes afterward. Deployment remains a
  separate step.

## Live verification limits

Render `/v1/health` returned healthy, but read-only exit snapshot requests for both
supported profiles returned an internal error. A separate read-only diagnostic
using local server configuration verified chain reads and found upstream USDG/
USDC price observations older than the existing five-minute safety limit. Price
and withdrawal policy were not relaxed. Live valuation and exit completion still
depend on fresh server/provider evidence; unavailable values remain explicit.

The standalone release APK targets Render and matches the existing local signing
certificate. The phone disconnected before replacement installation; no data was
cleared and no financial transaction was submitted.

## Verification

- Mobile: all 855 tests in 97 suites pass; TypeScript, ESLint and changed-file
  formatting pass.
- Android native signer: all 375 tests in 65 suites pass. Rust: all 204 tests pass.
- Backend exit snapshot: all seven affected tests and backend TypeScript pass.
- Standalone arm64 release build passes; embedded Render URL and existing signing
  certificate verified. Independent review findings were corrected and rechecked.
