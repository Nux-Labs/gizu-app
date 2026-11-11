# History-free Earn delivery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resume already signed vault deposits and complete their delivery verification without any history API access.

**Architecture:** Reuse signed-route status and canonical destination receipts from existing Earn payouts and the whole-recipient receipt accounting from grouped withdrawals. A separate Earn group describes the immutable review membership; it does not introduce signing authority. Backend and native independently verify all receipt events and native commits the proof and child allocations atomically.

**Tech Stack:** TypeScript/Fastify/viem backend, Kotlin native signer, existing encrypted journals and native read authorization.

**Spec:** User requirements in this conversation override prior history-dependent behavior in `docs/internal/CONFIDENTIAL_EARN.md`: Aurora history is inaccessible; preserve signed transactions and existing UI components; handle public-funded and existing-private sources consistently.

## Global constraints

- Work on `fix/confidential-earn`; preserve existing uncommitted spinner and single-route changes. No merge, AWS change, wallet signing, submission, storage reset or destructive device action.
- No history call for this delivery flow, including legacy saved signed private-funding quotes.
- Do not fabricate per-child transaction attribution. Group delivery proves recipient totals, not exact private ledger history.
- Signing proposals, nonce reservations, budget/gas approval and saved signed bytes retain their existing authority boundaries.
- Backend persists keyed commitments only. Transmit only this approved journey's payout members, not the wallet catalogue.
- Preserve already paid allocations and freeze accepted receipt sets so later gifts do not change completed delivery.
- Existing Monad cashout remains finalized; Robinhood uses the canonical receipt policy already used by Earn/Swap.

## Shared wire contract

Endpoint: `POST /v1/earn/native/payout/group-status` (read-only verification; no submission).

Request:

```ts
{
  group: {
    version: 1,
    journeyId: string,
    cycleIndex: number,
    distribution: {version: 1, weightsBps: number[]},
    recipients: string[], // native-derived investment addresses, one per slot
    members: Array<{
      operationId: string, // source operation ID, not native payout journal row UUID
      leg: string,        // invest:0 ... invest:4
      kind: 'private' | 'funded',
      recipient: string
    }>
  },
  children: Array<null | {
    recoveryEnvelope: string,
    submittedIntent: {standard:'erc191',payload:string,signature:string},
    revision: number, // quote/core revision, not mutable journal revision; private uses 1
    intentHash?: string
  }>,
  owners: Array<{standard:'erc191',payload:string,signature:string}>,
  destinationTransactionHashes: string[][] // per slot; bounded 128 per slot
}
```

Group members: sources ordered by accountIndex as the review, then slot order. Include every public-funded and existing-private child that pays any group recipient. Duplicate `(operationId,leg)` is invalid. Maximum 256 members, 5 slots, 128 owner proofs. Members of each source cover every slot. Group ID = `0x` + SHA256 of recursively key-sorted JSON of exactly `group` (arrays keep order), matching native `depositDigest(depositCanonical(group))`.

Response:

```ts
{
  groupId: string,
  verification: 'signed-route-receipt-group-v1',
  authenticated: true, operationScoped: true, observedAtMs: number,
  status: 'pending' | 'awaitingReceipt' | 'paid',
  routes: Array<{index:number,status:string}>,
  slots?: Array<{
    slot:number, destinationRecipient:string,
    minimumDestinationAtoms:string, receivedAtoms:string,
    receipts:Array<{transactionHash:string,logIndex:number,receivedAtoms:string,blockNumber:string,blockHash:string}>
  }>
}
```

Pending/missing unsigned members cannot yield paid. Once every saved signed member's route is SUCCESS, each slot requires canonical receipt total >= sum of its saved quote minima. No receipt-to-source assignment. All members' saved seals, signed payloads, nonce/deposit uniqueness and owner authentication must validate. Bind exact signed membership to group and global receipt events to group durably, only after all members validate and all routes succeed. Do not create exclusive recipient-global group reservations: source authentication does not establish recipient ownership. Existing exact legacy per-child claims may migrate only when their owner is a member; never overwrite another owner. Existing historical receipt bindings that include purpose/intentHash must remain recoverable using the exact saved owner.

Native first requests with empty hashes, then reuses/generalizes existing `scanCashoutGroupReceipts` and `confirmCashoutGroupReceipts` for all relevant recipient transfers. Trusted chain policy chooses finalized Monad vs canonical Robinhood. Independently compare reported canonical events and sums, reject duplicates/mutations. Persist scan cursors between polls, bounded by existing journal storage/capacity rules. Once paid, store normalized shared proof and all pending child allocations in one encrypted payout journal write. Require the total to cover fixed paid amounts plus unpaid minima and require every old paid event exactly once with its saved value. Pending children get their saved minima, with surplus to the last pending child in stable member order; already paid amounts/receipts stay fixed. Child rows reference group ID/proof; they do not invent individual destination hashes. No individual ambiguous scans for distribution journeys.

## Review focus

- Multiple private sources and mixed private/public-funded payouts with indistinguishable receipts must complete without history or double counting.
- Crash/restart between proof receipt and journal persistence must be atomic and recover exact signed bytes.
- Paid historical siblings, changed recipient/group/membership, wrong chain/token/amount, reorgs, stale references, duplicate claims and later gifts must remain safe.
- A partially signed group must allow remaining signing and must never attest completed delivery.
- Native read authorization, foreground interruption and user cancellation must retain existing rules; no background updates should drive pull-to-refresh UI.

### Task 1: Backend grouped delivery

Ownership: `backend/**` only. Preserve current shared canonical verifier extraction and history-free single-private status changes; do not reformat unrelated minified code.

- [x] Add failing tests for history unavailable, mixed/multiple sources sharing recipient, batched same-recipient transfers, saved seals/restart, missing member, changed signed payload, duplicate nonce/deposit/event, cross-group claims, legacy claims, reorg and chain finality.
- [x] Implement the shared contract using existing seal validation in ConfidentialPrivateFundingGateway and PrivatePayoutGateway, existing signed intent verification and grouped canonical receipt logic. Expose narrow internal restore helpers if needed; never trust JavaScript proposal amounts instead of saved signed/sealed evidence.
- [x] Register endpoint using existing private request logging/no-store/body bounds and app gateways.
- [x] Run backend typecheck and focused then full backend tests. Do not commit or push; root will review the integrated tree.

### Task 2: Native grouped delivery

Ownership: `mobile/modules/gizu-stored-signer/android/**` only. Preserve current spinner tests outside native and current single-route receipt changes.

- [x] Add failing realistic multi-source/mixed receipt tests plus atomic journal failure/restart and mutation tests.
- [x] Reuse/generalize grouped receipt scanner/confirmer with explicit chain policy; build exact shared wire group from saved review and its child journal rows.
- [x] Reconcile distribution deliveries once after all payout signatures are saved, before coordinator consumes receipts. Adapt interface/coordinator/engine adapter and read-only remaining-review recovery. Defer individual distribution payout scans to group verification.
- [x] Persist group proof/cursors and child allocations atomically in EarnPayoutJournal, reference proof from child rows and payoutReceipt; preserve paid amounts and signed bytes, enforce bounded storage.
- [x] Run focused native tests then full native tests; avoid concurrent Gradle runs with root. Do not commit/push/build APK; root packages after integration.

### Task 3: Integration and release preparation

Ownership: root, shared contract review, docs, JS regression checks and packaging.

- [x] Review backend/native contract parity and ensure all current and saved signed private-funding execution avoids history.
- [x] Independent review and resolve material findings; re-run affected tests.
- [x] Update `CONFIDENTIAL_EARN.md` and release guidance, preserve signer security boundaries.
- [x] Full backend/native tests, mobile coverage/typecheck/lint, targeted formatting and diff checks; build APK and install update preserving wallet if USB connected.
- [x] Commit/push reviewed fix on requested branch. User releases backend via existing main pipeline; no AWS interface changes by agent. Report honest live validation limits and how to resume saved deposit after release.

Verification: 452 backend tests passed (three optional live-fork skips), 500 native tests passed, and 969 mobile tests passed. Backend build, mobile typecheck/lint, staged checks and the Android release build passed. The Samsung update used `adb install -r` to preserve app data. Two optional online Expo Doctor metadata checks could not run; 19 local checks passed. Live saved-deposit completion awaits the matching backend release through the user-controlled AWS pipeline.
