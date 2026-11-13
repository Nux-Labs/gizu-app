# Historical return status consistency

Goal: Home and vault details expose the same historical verification state without claiming that a new redemption is pending. A user can check old return status separately from starting or continuing a withdrawal.

Evidence: installed main `960113c`; Home shows `checking`, vault overview omits it. Explicit read-only historical reconciliation returns HTTP 503 while balance and exit-snapshot reads return 200. ECS service is healthy. CloudWatch records the 503 but no failure code: the error handler logs through a request logger whose settlement route is `silent`. The client also lacks the new minimum-history error mapping. None of this proves an active redemption or authorizes declaring an old credit complete.

Scope:

- Reuse one status notice and per-profile decision on Home and vault overview.
- Provide an explicit past-return status mode that filters historical targets and never mounts financial review/execution panels. Do not select an untouched current investment in that mode.
- Keep missing historical confirmation distinct from an active withdrawal, including zero-vault button eligibility.
- Preserve the known sanitized history-unavailable native code and log safe backend failure codes even on silent routes.
- Retain native verification, immutable receipts, full exit checks and all spending approvals. Do not erase journals or infer completion from the current balance or the user's report.
- Prepare backend changes for the owner's deployment. Do not deploy or modify AWS resources. Runtime 503's exact provider cause remains unverified until safe diagnostics are available.

Tasks:

- [x] Observe failing UI, zero-balance classification, native mapping and silent-route diagnostic regressions.
- [x] Implement the shared notice, read-only history mode and error mappings.
- [x] Run full app/backend suites and affected native checks; retain documented baseline failures.
- [x] Obtain independent review and prepare the updated production app against api.gizu.io.

Work is in the isolated `feat/return-status-consistency` branch (renamed at the user's request). User's prior request to fix this return-state problem supplies implementation scope; no further design approval loop is needed. Live completion of the old return cannot be claimed without authenticated proof.

Review caught a case where a missing return receipt belongs to an invested or pending row, and an earlier unresolved record could prevent checking later history. Three additional regressions failed before correction and now pass. History-only checks all saved targets, keeps active withdrawal attention ahead of historical uncertainty, and never records a full-exit completion based only on a private receipt. The normal withdrawal/full-exit path is unchanged.

Verification: all 1,078 app tests across 111 suites, app/backend TypeScript and scoped ESLint pass; 33 affected native tests pass; backend suite passes 485 with 12 explicit skips. The sandboxed backend run cannot bind the shutdown test servers; rerunning with localhost access passed. The production release build succeeded with native hosted mode, DEBUG=false and api.gizu.io. The APK certificate matches the prior installed release. APK SHA256: `4fbacde106032b45ec4a10ea7712c89df38e180ac5403871e41aa54a600e7150`.

Backend-only diagnostics are committed separately as `ba9b27f` and pushed. The deployed backend source was `e259e58`; the user clarified that only our prior backend changes were deployed, not all merged work. The user subsequently chose to merge the full fix branch to main and deploy from there, rather than cherry-pick the diagnostic commit. Deployment is owner-operated and pending; no AWS resource was changed.

The production APK is installed on the reconnected Samsung SM-S911B. Its installed SHA256 matches the prepared APK exactly. Gizu opened to its normal passkey login screen; the user must sign in before the live Home/vault check can resume. The new remote branch retains both implementation commits; the old `codex/return-status-consistency` remote name was removed only after confirming that it pointed to the same preserved head.
