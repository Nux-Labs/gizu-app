package io.gizu.storedwallet

import kotlinx.coroutines.*

/** Native execution outlives the short confirmation promise; public reads never take its lease. */
internal class EarnDepositHost(
  private val scope: CoroutineScope,
  private val journal: EarnDepositJournal,
  private val loadRecord: () -> WalletRecord,
  private val coordinator: () -> EarnDepositCoordinator,
  private val approve: suspend (WalletRecord, EarnDepositApproval, Boolean) -> Unit,
  private val foreground: () -> Unit,
  private val now: () -> Long = System::currentTimeMillis,
  private val wait: suspend (Long) -> Unit = { delay(it) },
  private val releaseUnsigned: (String) -> Unit = {},
  private val reportFailure: (String, String) -> Unit = { _, _ -> },
) {
  private var ownedId: String? = null
  private var grant: EarnDepositApproval? = null
  private var approvalJob: Job? = null
  private var job: Job? = null
  val busy: Boolean
    get() = ownedId != null

  fun status(id: String): Map<String, Any> {
    val snapshot = journal.publicSnapshot(id)
    return if (ownedId == id && approvalJob != null) snapshot + ("phase" to "authorizing")
    else snapshot
  }

  suspend fun confirm(
    id: String,
    revision: Int,
    remaining: Boolean,
    nowMs: Long = now(),
  ): Map<String, Any> {
    check(!busy)
    val row = journal.get(id)
    check(
      row.getInt("revision") == revision &&
        row.getString("phase") == if (remaining) "paused" else "review"
    )
    ownedId = id
    approvalJob = currentCoroutineContext()[Job]
    var started = false
    try {
      foreground()
      val authority =
        loadRecord().use { r ->
          val a =
            if (remaining)
              EarnDepositApproval.fromRemainingReview(r, row.getJSONObject("review"), nowMs)
            else EarnDepositApproval.fromReview(r, row.getJSONObject("review"))
          grant = a
          approve(r, a, remaining)
          foreground()
          currentCoroutineContext().ensureActive()
          check(journal.get(id).getInt("revision") == revision)
          a.approveAfterPasskey(now())
          a.assertRead(r, now())
          a
        }
      approvalJob = null
      val approvedAt = now()
      val execution = coordinator()
      job =
        scope.launch(start = CoroutineStart.LAZY) {
          try {
            withTimeout(900000) {
              if (remaining) execution.resume(id, revision, authority)
              else execution.confirmed(id, revision, authority)
              var attempt = 0
              while (journal.get(id).getString("phase") != "invested") {
                val snapshot = journal.get(id)
                if (
                  snapshot.getString("phase") == "paused" &&
                    snapshot.optString("pauseReason") !in
                      setOf("settlementPending", "submissionUnknown")
                )
                  break
                foreground()
                loadRecord().use { authority.assertRead(it, now()) }
                check(now() - approvedAt in 0L until 900000L)
                val interval = listOf(2000L, 4000L, 8000L, 16000L, 30000L)[minOf(attempt++, 4)]
                wait(interval)
                foreground()
                loadRecord().use { authority.assertRead(it, now()) }
                execution.advance(id, authority)
              }
            }
          } catch (_: CancellationException) {
            if (journal.get(id).optString("pauseReason") !in setOf("cancelled", "approvalExpired"))
              runCatching { journal.pause(id, "approvalExpired") }
          } catch (failure: Exception) {
            val diagnostic = depositFailureDiagnostic(failure)
            runCatching { reportFailure(diagnostic.first, diagnostic.second) }
            runCatching { journal.pause(id, "approvalExpired") }
          } finally {
            authority.invalidate()
            grant = null
            ownedId = null
            job = null
          }
        }
      started = true
      job!!.start()
      return status(id)
    } finally {
      approvalJob = null
      if (!started) {
        grant?.invalidate()
        grant = null
        ownedId = null
      }
    }
  }

  fun cancel(id: String, revision: Int): Map<String, Any> {
    val row = journal.get(id)
    check(revision in 1..row.getInt("revision"))
    if (ownedId == id) revoke("cancelled") else journal.pause(id, "cancelled")
    releaseUnsigned(id)
    return status(id)
  }

  fun onBackground(providerActive: Boolean) {
    if (!providerActive || approvalJob == null) revoke("approvalExpired")
  }

  fun revoke(reason: String) {
    val id = ownedId ?: return
    grant?.invalidate()
    // Storage failure must never prevent revocation/cancellation of the in-memory signer.
    runCatching { journal.pause(id, reason) }
    val approving = approvalJob
    val executing = job
    approving?.cancel()
    executing?.cancel()
    runCatching { releaseUnsigned(id) }
  }

  fun close() = revoke("approvalExpired")
}

/** Retained history cannot fill up between source spending and its required future children. */
internal fun requireDepositCapacity(
  review: org.json.JSONObject,
  sponsored: List<org.json.JSONObject>,
  payouts: List<org.json.JSONObject>,
  payoutJournalBytes: Long = org.json.JSONArray(payouts).toString().toByteArray().size.toLong(),
  payoutGroupGrowthBytes: Long =
    if (review.has("distribution")) EARN_PAYOUT_GROUP_STORAGE_BYTES.toLong() else 0L,
) {
  val sources = review.getJSONArray("sources").objects().map { it.getString("operationId") }.toSet()
  val sponsoredIds = sponsored.map { it.getString("operationId") }.toSet()
  val depositIds =
    if (review.has("distribution"))
      depositReviewDeposits(review).indices.map {
        depositChildId(review.getString("journeyId"), it)
      }
    else listOf(depositChildId(review.getString("journeyId")))
  val newSponsored =
    sources.count { it !in sponsoredIds } + depositIds.count { it !in sponsoredIds }
  val existingPayouts =
    payouts
      .map {
        it.getJSONObject("proposal").let { p ->
          p.getString("operationId") + ":" + p.getString("leg")
        }
      }
      .toSet()
  val newPayouts =
    sources.sumOf { source ->
      depositReviewLegs(review).count { "$source:$it" !in existingPayouts }
    }
  check(
    sponsored.count(::journalEntryPending) + newSponsored <= 256 &&
      payouts.count(::journalEntryPending) + newPayouts <= 256
  ) {
    "Pending activity has no space for the complete deposit. Reconcile saved activity before funding."
  }
  // Reserve the bounded provider envelope, signature and JSON overhead for every future child.
  val reservePerChild = 2L * 1024 * 1024
  val reservePerPayout =
    if (review.has("distribution")) DISTRIBUTION_PAYOUT_STORAGE_BYTES.toLong() else reservePerChild
  check(
    org.json.JSONArray(sponsored).toString().toByteArray().size + newSponsored * reservePerChild <=
      15L * 1024 * 1024 &&
      payoutJournalBytes + newPayouts * reservePerPayout + payoutGroupGrowthBytes <=
        EARN_PAYOUT_JOURNAL_STORAGE_BYTES
  ) {
    "Encrypted recovery storage has no space for the complete deposit. No funding was authorized."
  }
}
