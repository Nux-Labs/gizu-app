# Gas management

Gas preparation must describe the operation that will actually be signed. A
business-call simulation, a provider token quote and a final UserOperation are
different evidence. Signing authority remains native and binds the user's
reviewed limits; a backend estimate never authorizes a signature.

Reviewed against repository source on 14 November 2026. Commands below are
current; the final verification record describes an earlier implementation run.

## Resolved design faults

The November 2026 audit found live Swap funding using the SDK's ERC-20 preparation
directly, while Earn independently rebuilt approval and re-estimated calldata.
The installed SDK can replace its approval and sponsorship after estimation.
Trusting that intermediate result left Swap's final allowance and gas bounds
out of agreement. Swap also allowed a higher funding fee to reduce principal
after approval without preserving the displayed fee ceiling and minimum credit.

Fee arithmetic was copied between Monad Swap, Earn, Kotlin and Rust. Some copies
calculated the protocol's integer floor; others calculated a conservative ceiling,
without consistently naming that distinction. A protocol charge cap and an
application reserve must remain separate quantities.

USDG return planning required an exact fixed point while replacing its fee
budget on every iteration. A one-atom change could cause a permanent oscillation
despite a feasible budget. The earlier burn-address probe also underestimated
fresh-recipient storage cost; a verified empty recipient is now used.

Plain Ethereum vault signing previously required the prepared block or its immediate child,
even though a user could legitimately spend longer reading the review. Sponsored
Earn and liquidity already reconstruct against fresh native observations while
requiring an identical reviewed digest. Plain vault execution now accepts an
older reference only with the native canonical-reference proof enforced by the
shared Rust gas policy.

## Shared runtime boundaries

- Backend EVM gas helpers own checked integer arithmetic, complete paymaster gas
  accounting, explicit rounding, bounded approval stabilization and monotone fee
  envelopes. Swap and Earn use these helpers through their existing adapters.
  The [ERC-4337 operation fields](https://eips.ethereum.org/EIPS/eip-4337)
  distinguish call, verification, pre-verification and paymaster gas; these are
  included alongside the signed paymaster's token-conversion terms.
- Chain adapters retain token, contract, nonce-lane, fee-asset, provider and
  simulation rules. Native-fee operations require native funds; token-sponsored
  operations require their fee token. Confidential Intents do not acquire an
  invented EVM gas requirement.
- A final preparation re-estimates exact calldata and refreshes sponsorship until
  its relevant fields and allowance are stable within bounded attempts. Unknown
  or changing terms stop preparation; buffers do not replace this check.
- Fresh state binds both the EOA authorization nonce and the selected EntryPoint
  nonce. Reorgs, stale observations and fees above the reviewed maximum require
  a new review. A new review must precede any signature that increases gas cost
  or lowers approved principal or minimum credit.
- Native checked arithmetic and canonical-reference validation are shared by
  native consumers. Historical signed operations retain their exact bytes and
  reconciliation path. New limits never silently reinterpret saved signatures.
- `shared/gas-policy-v1.json` contains conformance vectors, including fractional
  token charges, rather than runtime spending permissions. TypeScript, Rust and
  the diagnostic command check the same vectors.

Swap's existing signed contract uses the protocol's floor token charge and a
strict integer approval ceiling. Earn's reviewed funding reserve uses a
conservative ceiling. Both now select an explicit profile from the shared
implementation. Approval, principal affordability and the final balance check
must use the same profile. Shared tests include a 1000-atom balance funding
993 atoms plus a 7-atom fee; neither an 8-atom reserve nor an 8-atom approval is
silently substituted into that Swap contract. Historical signatures retain
their original fee interpretation.

## Implementation map

- [Backend gas policy](../../backend/src/adapters/evm/gas-policy.ts): checked
  integer arithmetic, explicit rounding and monotone fee envelopes.
- [Token paymaster preparation](../../backend/src/adapters/evm/token-paymaster.ts):
  bounded stabilization of final sponsorship and approval.
- [Native gas policy](../../mobile/modules/gizu-stored-signer/core/src/gas.rs):
  checked arithmetic and canonical reference validation for native consumers.
- [Offline/read-only diagnostic](../../backend/scripts/gas-doctor.ts): production
  helpers and shared vectors, without signing, submission or wallet allocation.

This implementation is merged into `main`. Backend deployment and a rebuilt
native app remain separate release steps; a passing local diagnostic does not
update a deployed server or prove funded execution. Build native bindings before
platform tests and use the existing release workflow for Android/iOS checks.

## Commands

From the repository root, run `just gas-check` or
`npm --prefix backend run gas:check`. This is offline: it runs the production
arithmetic against the shared vectors, tests a changing final paymaster rate
through the production approval stabilizer, and checks an oscillating fee
envelope. It needs no provider key, wallet identity or funds.

Run `just gas-check-native` or `npm --prefix backend run gas:check:native` to add
the complete native Rust core test suite, including review and recovery guards.
Cargo must be on `PATH`. This does not replace Android/iOS platform tests.

For an opt-in provider check, run
`npm --prefix backend run gas:doctor -- --live < /path/to/request.json`.
The bounded stdin object contains `chainId`, `kind`, `owner`, `recipient`,
`amountAtoms` and `budgetAtoms`. `kind` is `token-transfer` or `native-transfer`;
chains 1, 143 and 4663 are supported, with native-only testnet checks on 10143.
Use exact atom strings and a different nonzero recipient. The source address
must have funds for the requested read-only estimate; insufficient balances
block diagnostics rather than injecting fake balances. Passing addresses on
stdin avoids putting them into shell command history. The script does not save
the request, and its output excludes linked addresses, provider URLs, keys and
raw payloads.

Live mode calls the same production Monad/Robinhood preparation adapters used
by the app. It has no signing or submission path, requests no token-route quotes,
and allocates no user wallets. The report states its fee model and asset; a token
paymaster does not require native ETH/MON just because the network uses it.
Ethereum native-fee checks read fees and estimate the exact transfer. These
fixed transfer checks do not certify an arbitrary vault or resolver transaction:
its own production adapter, final calldata and native authorization still apply.

Keep provider credentials in `backend/.env` or the existing server environment.
The CLI reads configuration only in explicit live mode. A failed report exits
nonzero. `ok: true` means the requested checks passed; `signingAvailable: false`
and `submitted: false` apply in every mode.

## Historical verification record

The original gas-management integration passed 372 backend tests (10 environment-gated tests were
skipped), 905 mobile JavaScript tests, 238 Rust tests and 426 Android native tests.
Backend compilation, TypeScript checks, targeted formatting/lint, the shared gas
command and the Android release build passed. The read-only diagnostic also
prepared real Robinhood USDG sponsorship without a signature or submission.
Backend CI now checks both the production TypeScript helpers and the native
core against the shared vectors before merge.

The changed Swift files passed syntax parsing. Full iOS compilation and tests
could not run on the validation host because full Xcode, the iPhone SDK and
`simctl` were unavailable. Run the existing iOS release checks on an equipped
Mac before distributing that platform.
