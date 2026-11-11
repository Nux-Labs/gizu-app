# Earn RPC throttling implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement the steps below.

**Goal:** Complete a single review when transient RPC throttling recovers, without
creating enough fork traffic to starve the nonce and other live chain reads.

**Architecture:** Reuse viem's bounded transport backoff for an explicitly
allowlisted read-only client. Apply it to shared Robinhood deposit/exit and payout
reads. Keep financial submission transports unchanged. Bound each of the two
existing disposable forks to 150 CU/s instead of 1,000, leaving 200 CU/s of the
observed 500 CU/s account allowance for live reads and other workloads.

**Tech stack:** TypeScript, viem 2.56.9, Node test runner, pinned Anvil 1.8.3.

**Spec/evidence:** User requests a root fix on fix/confidential-earn. Alchemy's
Gizu request log at Nov12 01:36:44 shows HTTP/JSON-RPC429 for EntryPoint08
getNonce(address,uint192), selector0x35567e1a, latest. AWS req-q at the same time
fails at robinhood-paymaster.js:85. The provider reports compute-unit capacity
exhausted. Node reads disable retries; each fork currently allows1,000 CU/s.

## Constraints and review focus

- No AWS interface mutations or deployment by the agent.
- No history API, mainnet signing/submission, invented zero nonce, cached nonce,
  relaxed identity/freshness checks or repeated financial actions.
- Permanent RPC rejection must fail without a nonce fallback or endless retry.
- Both HTTP429 and JSON-RPC429 must recover inside the same bounded read.
- Exhausted retry must fail closed before operation preparation.
- Read transport must reject transaction and signing methods before any request.
- Verify actual spawned fork arguments; retain global concurrency and cleanup.
- Default per-process fork budget assumes the current single backend replica;
  account-wide traffic and replicas still need an operator capacity allowance.

## Work

- [x] Add failing installed-SDK tests for nonce429 recovery, exhausted throttling,
      deterministic nonce rejection and forbidden submission methods.
- [x] Add a shared allowlisted Earn read transport using standard bounded viem
      backoff. Adopt it in Robinhood deposit/exit and payout read clients.
- [x] Add an executable fork-boundary regression, then reduce per-fork CU/s to150.
- [x] Record positive provider429 safely in diagnostics and cover its wrapped form.
- [x] Run affected and complete backend tests, typecheck/build and real unsigned
      fork plans. Review, push the actual fix, and leave release to the user.

Optional live checks do not prove a user-authorized vault deposit has completed.

Ruling: Bound the whole logical read to12seconds with AbortSignal, including SDK
backoff and provider Retry-After. A retry count alone could otherwise wait for a
very large Retry-After. Regression covers deadline cancellation and caller abort.

Evidence: The installed-SDK regression failed with the exact production
ContractFunctionExecutionError under429, then recovered the fixture nonce9 in one
preparation call. Exhaustion is bounded at four attempts; a deterministic revert
does not retry; nonce drift after recovery still rejects. Two complete unsigned
plans with real fork simulations passed at150 CU/s, including controlled429 on
the first two nonce reads of the first plan. No signing or mainnet submission.

Final verification:471 backend tests,468 passed and3 optional live-fork skips;
typecheck/build and focused formatting passed. Fresh reviewer independently ran
23 affected tests and approved the stable diff. Three full unsigned plans passed
with the lower fork budget (including controlled nonce429); no live transaction
was signed or submitted. Release and the real deposit approval remain with user.
