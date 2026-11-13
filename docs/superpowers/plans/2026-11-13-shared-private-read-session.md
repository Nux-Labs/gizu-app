# Shared Private Read Session Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Share one native private-balance read grant across Android wallet features and retain it across app switching.
**Architecture:** `PrivateUsdcRead` owns the in-memory wallet/generation grant. Native lifecycle handlers revoke spending independently, while screen lock and explicit wallet lock revoke both. React Native refreshes on foreground without starting authentication unless reads are locked.
**Tech Stack:** Kotlin, React Native/TypeScript, JUnit, Jest.
**Spec:** `docs/superpowers/specs/2026-11-13-shared-private-read-session-design.md`

## Global Constraints

- No fixed read-session expiry; revoke on screen/wallet lock, sign-out or restart.
- Preserve every spending review, passkey requirement and expiry.
- Keep credentials and empty-intents signing inside native code.
- Preserve existing checkout edits; install standalone release using api.gizu.io.

## Review Focus

- Background retains read permission while still revoking spending.
- Screen lock during a system credential prompt revokes read access.
- New wallet/generation and process restart cannot reuse the grant.
- Foreground refreshes must ignore results from an earlier background request.
- Read-only access never satisfies an operation's spending approval.

### Task 1: Native shared grant and lifecycle

Files: `PrivateUsdcRead.kt`, `GizuStoredSignerModule.kt`,
`earn/EarnDepositRemaining.kt`; tests `PrivateUsdcReadTest.kt`,
`EarnDepositRecoveryTest.kt`, existing spending/lifecycle tests.

- [x] Write regressions for background vs screen lock, restart, wallet/generation,
  and using the same grant for reconciliation after arbitrary elapsed time.
- [x] Observe failures; replace timed read permission with `PrivateUsdcRead`.
- [x] Route all balance-only authentication through shared grant; keep spending
  confirmation methods intact. Keep background cancellation separate from read revocation.
- [x] Run affected native tests and check existing spending/lifecycle coverage.

### Task 2: Unlock UI and foreground refresh

Files: `PrivateBalanceRefresh.tsx`, `MainnetWalletProvider.tsx`,
`PrivateBalancePanel.tsx`; functional wallet and Earn tests.

- [x] Add failing functional tests for unlock labels and automatic foreground
  refresh without another wallet unlock, including interrupted reads.
- [x] Implement labels/copy and foreground refresh with stale-result protection.
- [x] Run affected functional tests, typecheck and scoped lint.

### Task 3: Review, release and device verification

- [x] Run complete JS/native suites; distinguish the seven established native fixture failures.
- [x] Review the incremental patch independently and address material findings with regressions.
- [x] Build standalone arm64 release with hosted backend and verify app identity/signature.
- [x] Install with `adb install -r`, open app, verify switching retains reads;
  user handles any authentication. Do not confirm or submit a deposit.

## Execution record

Authorization: user approved the policy and explicitly requested implementation
and device installation. Execute inline without another approval checkpoint.
Preserve the existing `fix/confidential-earn` checkout and earlier changes; source
baseline saved at `/tmp/gizu-read-session-before` for incremental review. No commit
or worktree migration is needed for the requested local build/install.

Native/functional regressions failed before implementation. The stale-result test
was strengthened and verified by removing background invalidation temporarily:
the UI incorrectly changed from 3 USD to 4 USD; restoring invalidation passes.
Initial affected verification: 37 native checks and 59 functional checks passed.

Independent incremental review found missing screen-off observer registration in
the Home-only path. Read-session activation now requires registering the device
lock observer before opening a grant. Tests cover a lock/unlock completed while
backgrounded and failure to register observation. An adjacent fresh-cache state
could report ready after permission revocation; its regression failed first and
the state now prioritizes locked while retaining cached observations.

The first full native run had 536 tests and only the seven established
`EarnDepositPreparerTest` fixture failures listed in the earlier shared-private-USDC
plan. No route minimum, spending approval or quote expiry was relaxed. The first
full JavaScript run found a locked-button fixture expecting the old Refresh label;
the expectation now correctly uses Unlock private balance.

Final native run: 539 tests, 532 passed, the same seven baseline fixture failures.
The lock-observer, revoked-cache and shared reconciliation regressions all pass.
The reviewer found no spending-authorization regressions. The full JS run also
identified an old expectation that foreground never refreshes; updated that test
to require one foreground refresh while still proving price expiry alone does
not fetch balances. The final full JS suite is running after these fixture updates.

Integration found that feature adapters used native `lock` for operation cleanup.
Added optional native `cancelWalletOperation` and routed feature cancellation to
it, preserving read permission while retaining queue invalidation and spending
revocation. Explicit wallet lock/sign-out still use `lock`; older native builds
fall back to full lock. A bridge regression failed with reads incorrectly revoked
before the fix; all 39 affected bridge/compatibility tests now pass. Native
spending cancellation reuses the original body, without changing approval limits.

Final JavaScript verification: 107 suites / 1,015 tests passed, including the new
cancellation regression. TypeScript and scoped ESLint passed. The affected native
identity, read-session, reconciliation, portfolio, withdrawal and spending-host
checks pass. The final full native rerun again completed 539 tests with precisely
the seven established fixture failures and no additional failures. Their names
are recorded in the earlier shared-private-USDC plan; failure output is in
`/tmp/gizu-read-session-native-complete.log`.


Release/device: final arm64 standalone build passed (879 tasks); DEBUG=false,
hosted native backend, api.gizu.io bundled, existing package and signing certificate
verified. `adb install -r` succeeded and a cold launch of MainActivity succeeded.
App/wallet data was preserved. Backend working tree is unchanged. Login itself grants private read access; no additional balance unlock is needed
following successful login. Device verification brought Gizu Home to the background
and returned with a HOT launch. The existing session stayed on Home without
another authentication prompt. Device screen-lock revocation was covered by the
observer/lifecycle regressions, without forcing the user through another lock.
No spending approval was accepted or financial operation executed during this task.
