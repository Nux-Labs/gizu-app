# Vault deposit completion implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement the steps below.

**Goal:** A confirmed deposit ends at the invested position; opening that position
does not start or resume an old withdrawal workflow.

**Architecture:** Keep the current native deposit and withdrawal services intact.
Make VaultPosition a position overview and move the existing withdrawal screen
onto a separate protected VaultWithdrawal route, reached by an explicit Withdraw
action. Native navigation back returns to the position. Retain old withdrawal
recovery and its existing checks inside the requested withdrawal route.

**Tech stack:** Existing React Native screens, typed React Navigation, shared
portfolio provider, Jest/RNTL functional tests and Android release build.

**Spec/evidence:** User says deposit completion is the objective. Phone currently
shows a new USDG vault position alongside an older private USDC return. Public balanceOf on the
current saved investment wallet confirms positive vault shares. VaultPosition
automatically mounts useVaultPosition, which sorts cycles oldest-first and selects
unfinished old withdrawals before showing the current investment.

## Constraints

- No wallet/journal resets, backend changes, signing or financial approvals.
- Keep existing withdrawal/return recovery reachable through explicit Withdraw.
- Opening the position must not select an Earn cycle or invoke withdrawal services.
- Back navigation and route protection must remain consistent with existing app.
- Deposit success continues to mean confirmed invested shares, not redemption.

## Work

- [x] Add a failing real-navigation regression: an invested position with an older
      unfinished return shows a position overview, no return steps, no cycle selection.
- [x] Move the existing withdrawal screen intact to VaultWithdrawal; register its
      protected typed route. Show position details and explicit Withdraw on overview.
- [x] Verify explicit Withdraw restores the old saved return and Back returns to
      overview; retain existing withdrawal/recovery functional coverage on its route.
- [x] Run full JS suite/coverage, typecheck/lint/format and build the APK; obtain
      independent review of the navigation and withdrawal recovery boundary.
- [ ] Push the reviewed change and install with adb install-r preserving wallet
      data if the phone is available.

Ruling: Reuse the existing VaultPositionSummary for the overview. Keep the current
withdrawal implementation intact on its own route. Explicit Withdraw in vault
details must navigate directly to that route, rather than asking for Withdraw
again on the overview. Guided deposit View investment opens the overview.

Regressions observed RED before implementation: Withdraw missing on the overview;
completed-deposit navigation selected EarnInvestment instead of VaultPosition;
vault-detail Withdraw did not reach the distinct withdrawal route. All 80 tests
across the three affected functional suites now pass.

Final validation: 978 tests across 105 suites pass with coverage thresholds met;
typecheck, full lint, formatting and Android release assembly pass. Independent
review found no substantive issues. The APK is ready; USB installation is pending
because adb currently lists no connected device.
