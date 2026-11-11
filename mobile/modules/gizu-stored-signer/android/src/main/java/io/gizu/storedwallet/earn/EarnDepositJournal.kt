package io.gizu.storedwallet

import android.content.Context
import java.util.UUID
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

internal fun earnDepositJournal(context: Context, record: WalletRecord) =
  EarnDepositJournal(
    AndroidWalletFile(context, "gizu-earn-deposit-${record.journalId}.enc", 4 * 1024 * 1024),
    { checkNotNull(AndroidWalletKeys().existing()) },
    record.id,
    record.journalId,
  )

/**
 * Atomic encrypted identities and progress; signing evidence remains in the existing child
 * journals.
 */
internal class EarnDepositJournal(
  private val file: WalletFile,
  private val key: () -> SecretKey,
  private val walletId: String,
  private val generation: String,
) {
  private val aad = "gizu-earn-deposit:v1:$walletId:$generation".toByteArray()

  companion object {
    private val lock = Any()
  }

  fun all(): List<JSONObject> =
    synchronized(lock) {
      if (!file.exists()) return@synchronized emptyList()
      val clear = CryptoEnvelope.decrypt(key(), file.read(), aad)
      try {
        val root = JSONObject(String(clear, Charsets.UTF_8))
        check(
          root.getInt("version") == 1 &&
            root.getString("walletId") == walletId &&
            root.getString("generation") == generation
        )
        root.getJSONArray("journeys").objects().also { rows ->
          check(
            rows.size <= 100_000 &&
              rows.map { it.getString("journeyId") }.distinct().size == rows.size
          )
          rows.forEach {
            check(
              it.getString("walletId") == walletId &&
                it.getString("generation") == generation &&
                it.getInt("revision") > 0
            )
          }
        }
      } finally {
        clear.fill(0)
      }
    }

  private fun write(rows: List<JSONObject>) {
    val clear =
      JSONObject()
        .put("version", 1)
        .put("walletId", walletId)
        .put("generation", generation)
        .put("journeys", JSONArray(rows))
        .toString()
        .toByteArray()
    try {
      check(clear.size <= 15 * 1024 * 1024)
      file.write(CryptoEnvelope.encrypt(key(), clear, aad))
    } finally {
      clear.fill(0)
    }
  }

  fun get(id: String): JSONObject = all().single { it.getString("journeyId") == id }

  /** Older cleanup could drop a private-only review after recording local source credit. */
  fun recoverMissingReview(id: String): JSONObject =
    synchronized(lock) {
      val row = get(id)
      if (row.has("review") || row.getString("phase") == "invested") return@synchronized row
      if (row.getJSONObject("children").length() > 0) {
        if (row.optString("pauseReason") == "recoveryRequired") return@synchronized row
        return@synchronized pause(id, "recoveryRequired")
      }
      if (row.getJSONArray("completedSteps").length() == 0 && row.getString("creditedAtoms") == "0")
        return@synchronized row
      // Every signer requires a durably attached child first. With none, this is local bookkeeping.
      update(id, row.getInt("revision")) {
        it.put("phase", "draft").put("completedSteps", JSONArray())
        for (field in
          listOf(
            "creditedAtoms",
            "holdReceivedAtoms",
            "investReceivedAtoms",
            "depositedAtoms",
            "sharesAtoms",
          )) it.put(field, "0")
        it.optJSONArray("investments")?.objects()?.forEach { investment ->
          investment
            .put("status", "pending")
            .put("receivedAtoms", "0")
            .put("depositedAtoms", "0")
            .put("sharesAtoms", "0")
          investment.remove("transactionHash")
        }
        it.remove("pauseReason")
        it.remove("message")
      }
    }

  fun loadOrCreate(record: WalletRecord, profile: Int, draftId: String?): JSONObject =
    synchronized(lock) {
      check(
        record.id == walletId &&
          record.journalId == generation &&
          record.verified &&
          !record.earnRecoveryRequired &&
          profile == 4663 &&
          record.earnChain == profile
      )
      val rows = all()
      val distribution = savedCycleDistribution(record)
      val existing =
        if (draftId != null) rows.singleOrNull { it.getString("journeyId") == draftId }
        else rows.singleOrNull { it.getInt("cycleIndex") == record.earnCycleIndex }
      if (existing != null) {
        check(
          existing.getInt("cycleIndex") == record.earnCycleIndex &&
            existing.getInt("profileChainId") == profile
        )
        check(nativeJsonEqual(existing.opt("distribution"), distribution))
        return@synchronized existing
      }
      check(rows.count(::journalEntryPending) < 256)
      val allocated =
        JSONArray(record.earnCycles).objects().singleOrNull {
          it.getInt("cycleIndex") == record.earnCycleIndex
        }
      if (draftId != null) check(allocated?.optString("depositJourneyId") == draftId)
      check(rows.none { it.getInt("cycleIndex") == record.earnCycleIndex })
      val id =
        draftId
          ?: allocated?.optString("depositJourneyId")?.takeIf { it.isNotBlank() }
          ?: "deposit_" + UUID.randomUUID().toString().replace("-", "")
      val row =
        JSONObject()
          .put("version", 1)
          .put("journeyId", id)
          .put("revision", 1)
          .put("walletId", walletId)
          .put("generation", generation)
          .put("cycleIndex", record.earnCycleIndex)
          .put(
            "intentId",
            if (record.earnCycleIndex == 0) "earn-v1:${record.id.lowercase()}:robinhood-usdg"
            else "earn-v2:${record.id.lowercase()}:robinhood-usdg:${record.earnCycleIndex}",
          )
          .put("profileChainId", profile)
          .put("profileId", "robinhood-usdg")
          .put("phase", "draft")
          .put("budgetAtoms", "0")
          .put(
            "destinations",
            JSONArray(
              cycleAddresses(record).mapIndexed { n, address ->
                JSONObject()
                  .put("role", if (distribution != null || n > 0) "invest" else "hold")
                  .put("chainId", profile)
                  .put("address", address)
                  .also { if (distribution != null) it.put("slot", n) }
              }
            ),
          )
          .put("children", JSONObject())
          .put("completedSteps", JSONArray())
      for (field in
        listOf(
          "creditedAtoms",
          "holdReceivedAtoms",
          "investReceivedAtoms",
          "depositedAtoms",
          "sharesAtoms",
        )) row.put(field, "0")
      if (distribution != null) {
        row.put("distribution", JSONObject(distribution.toString()))
        allocated
          ?.optString("distributionBudgetAtoms")
          ?.takeIf { it.isNotBlank() }
          ?.let { row.put("distributionBudgetAtoms", depositAtoms(it, true).toString()) }
        row.put(
          "investments",
          JSONArray(
            cycleAddresses(record).mapIndexed { slot, recipient ->
              JSONObject()
                .put("slot", slot)
                .put("recipient", recipient)
                .put("receivedAtoms", "0")
                .put("depositedAtoms", "0")
                .put("sharesAtoms", "0")
                .put("status", "pending")
            }
          ),
        )
      }
      write(rows + row)
      row
    }

  fun update(id: String, revision: Int, action: (JSONObject) -> Unit): JSONObject =
    synchronized(lock) {
      val rows = all()
      val row = rows.single { it.getString("journeyId") == id }
      check(row.getInt("revision") == revision) { "Stale deposit journey" }
      val distribution = row.optJSONObject("distribution")?.toString()
      action(row)
      check(row.optJSONObject("distribution")?.toString() == distribution)
      row.put("revision", Math.addExact(revision, 1))
      write(rows)
      row
    }

  /** Persist the batch owner before any leg becomes a sticky operation reservation. */
  fun bindPreparationReservation(id: String, revision: Int, batchId: String): JSONObject =
    update(id, revision) { row ->
      check(row.getString("phase") == "preparing" && row.getJSONObject("children").length() == 0)
      check(!row.has("preparationBatchId") || row.getString("preparationBatchId") == batchId)
      check(batchId.matches(Regex("[-a-zA-Z0-9_]{1,128}")))
      row.put("preparationBatchId", batchId)
    }

  /** No children means signing cannot have started: attachChild is durable before every signer. */
  fun cancelUnsignedReview(id: String, release: (String) -> Unit): JSONObject =
    synchronized(lock) {
      val rows = all()
      val row = rows.single { it.getString("journeyId") == id }
      if (
        row.getJSONObject("children").length() > 0 ||
          row.getString("phase") == "invested" ||
          (row.has("review") &&
            (row.getJSONArray("completedSteps").length() > 0 ||
              row.getString("creditedAtoms") != "0"))
      )
        return@synchronized row
      val batch =
        row.optString("preparationBatchId").takeIf { it.isNotBlank() }
          ?: row.optJSONObject("review")?.getJSONObject("reservation")?.getString("id")
      if (batch != null) release(batch) // A failed release preserves ownership for the next retry.
      if (batch == null && !row.has("review")) return@synchronized row
      row.remove("preparationBatchId")
      row.remove("review")
      row.remove("pauseReason")
      row.remove("message")
      row.put("phase", "draft").put("revision", Math.addExact(row.getInt("revision"), 1))
      write(rows)
      row
    }

  fun saveReview(id: String, revision: Int, review: JSONObject): JSONObject =
    update(id, revision) { row ->
      check(row.getJSONObject("children").length() == 0) {
        "Reconcile saved children before replacing the review"
      }
      check(
        review.getString("journeyId") == id &&
          review.getString("walletId") == walletId &&
          review.getString("generation") == generation
      )
      check(review.getInt("cycleIndex") == row.getInt("cycleIndex"))
      check(nativeJsonEqual(row.opt("distribution"), review.opt("distribution")))
      row.put("budgetAtoms", depositAtoms(review.getString("sourceBudgetAtoms"), true).toString())
      if (row.has("preparationBatchId"))
        check(
          row.getString("preparationBatchId") == review.getJSONObject("reservation").getString("id")
        )
      row.put("review", JSONObject(review.toString())).put("phase", "review")
      row.optJSONArray("investments")?.objects()?.forEach { it.put("status", "pending") }
      row.remove("indicativeReview")
      row.remove("pauseReason")
      row.remove("message")
    }

  fun saveRemainingReview(id: String, revision: Int, review: JSONObject): JSONObject =
    update(id, revision) { row ->
      check(row.getString("phase") == "paused")
      val old = row.getJSONObject("review")
      for (field in
        listOf(
          "journeyId",
          "walletId",
          "generation",
          "cycleIndex",
          "profileChainId",
          "confidentialAccount",
          "destinations",
          "sourceBudgetAtoms",
        )) check(nativeJsonEqual(old.get(field), review.get(field)))
      check(nativeJsonEqual(old.opt("distribution"), review.opt("distribution")))
      check(nativeJsonEqual(row.opt("distribution"), review.opt("distribution")))
      val before = old.getJSONArray("sources").objects()
      val after = review.getJSONArray("sources").objects()
      check(before.size == after.size)
      for (source in before) {
        val next = after.single { it.getString("operationId") == source.getString("operationId") }
        for (field in listOf("operationId", "accountIndex", "address", "budgetAtoms")) check(
          nativeJsonEqual(source.get(field), next.get(field))
        )
      }
      row.put("review", JSONObject(review.toString()))
    }

  fun attachChild(id: String, revision: Int, stage: String, childId: String): JSONObject =
    update(id, revision) { row ->
      check(
        (stage in
          if (row.has("distribution"))
            setOf("funding", "deposit") +
              distributionWeights(row.getJSONObject("distribution")).indices.map { "invest:$it" }
          else setOf("funding", "hold", "invest", "deposit")) &&
          childId.matches(Regex("[-a-zA-Z0-9_]{1,128}"))
      )
      val children = row.getJSONObject("children")
      check(
        children.keys().asSequence().none { name ->
          children.getJSONArray(name).let { a ->
            (0 until a.length()).any { a.getString(it) == childId }
          }
        }
      )
      val list = children.optJSONArray(stage) ?: JSONArray()
      check(
        list.length() <
          if (stage == "deposit")
            row.optJSONObject("distribution")?.let { distributionWeights(it).size } ?: 1
          else 256
      )
      list.put(childId)
      children.put(stage, list)
    }

  fun pause(id: String, reason: String, message: String? = null): JSONObject {
    check(reason in depositPauseReasons)
    val row = get(id)
    return update(id, row.getInt("revision")) {
      if (it.getString("phase") != "invested") {
        it.put("phase", "paused").put("pauseReason", reason)
        it.optJSONArray("investments")?.objects()?.forEach { investment ->
          if (investment.getString("status") != "invested") investment.put("status", "paused")
        }
        if (message != null) it.put("message", message.take(1024))
      }
    }
  }

  fun publicSnapshot(id: String): Map<String, Any> {
    val row = get(id)
    val public = JSONObject()
    for (field in
      listOf(
        "version",
        "journeyId",
        "revision",
        "walletId",
        "intentId",
        "profileId",
        "phase",
        "destinations",
        "budgetAtoms",
        "distributionBudgetAtoms",
        "creditedAtoms",
        "holdReceivedAtoms",
        "investReceivedAtoms",
        "depositedAtoms",
        "sharesAtoms",
        "completedSteps",
        "pauseReason",
        "message",
        "depositTransactionHash",
      )) if (
      row.has(field) &&
        !(field == "depositTransactionHash" &&
          row.optJSONObject("distribution")?.let { distributionWeights(it).size > 1 } == true)
    )
      public.put(field, row.get(field))
    row.optJSONObject("distribution")?.let { distribution ->
      distributionWeights(distribution)
      public.put("distribution", JSONObject(distribution.toString()))
      public.put(
        "investments",
        JSONArray(
          row.getJSONArray("investments").objects().map { investment ->
            JSONObject().also { out ->
              for (field in
                listOf(
                  "slot",
                  "recipient",
                  "receivedAtoms",
                  "depositedAtoms",
                  "sharesAtoms",
                  "status",
                  "transactionHash",
                )) if (investment.has(field)) out.put(field, investment.get(field))
            }
          }
        ),
      )
    }
    row.optJSONObject("review")?.let { public.put("review", depositPublicReview(it)) }
    row.optJSONObject("indicativeReview")?.let { summary ->
      public.put(
        "indicativeReview",
        JSONObject().also { out ->
          for (field in
            listOf(
              "quotedAtMs",
              "sourceBudgetAtoms",
              "holdEstimatedAtoms",
              "investEstimatedAtoms",
              "sourceMaximumFeeAtoms",
            )) out.put(field, summary.get(field))
        },
      )
    }
    return depositJsonMap(public)
  }
}

private val depositPauseReasons =
  setOf(
    "quoteUnavailable",
    "previewUnavailable",
    "providerUnavailable",
    "sponsorshipUnavailable",
    "insufficientFunds",
    "uneconomicAmount",
    "termsChanged",
    "approvalExpired",
    "settlementPending",
    "submissionUnknown",
    "recoveryRequired",
    "unsupportedCapability",
    "cancelled",
  )

internal fun depositPublicReview(review: JSONObject): JSONObject {
  fun pick(row: JSONObject, fields: List<String>) =
    JSONObject().also { out -> fields.forEach { out.put(it, row.get(it)) } }
  val out = pick(review, listOf("policyVersion", "quotedAtMs", "expiresAtMs", "sourceBudgetAtoms"))
  review.optJSONObject("distribution")?.let {
    distributionWeights(it)
    out.put("distribution", JSONObject(it.toString()))
  }
  val legFields =
    listOf(
      "recipient",
      "inputAtoms",
      "estimatedOutputAtoms",
      "minimumOutputAtoms",
      "providerFeeBps",
    )
  val depositFields =
    listOf(
      "estimatedAssetsAtoms",
      "minimumAssetsAtoms",
      "minimumSharesAtoms",
      "shareDecimals",
      "maximumFeeAtoms",
      "withdrawalReserveAtoms",
    )
  out.put(
    "sources",
    JSONArray(
      review.getJSONArray("sources").objects().map { s ->
        pick(
            s,
            listOf(
              "operationId",
              "accountIndex",
              "address",
              "budgetAtoms",
              "amountAtoms",
              "maximumFeeAtoms",
              "retainedAtoms",
              "minimumCreditAtoms",
            ),
          )
          .also {
            if (s.optString("kind") == "private") it.put("kind", "private").put("address", "")
            if (review.has("distribution")) {
              it.put(
                "allocations",
                JSONArray(
                  s.getJSONArray("allocations").objects().map { allocation ->
                    pick(allocation, legFields)
                  }
                ),
              )
            } else
              for (leg in listOf("hold", "invest")) it.put(
                leg,
                pick(
                  s.getJSONObject(leg),
                  listOf(
                    "recipient",
                    "inputAtoms",
                    "estimatedOutputAtoms",
                    "minimumOutputAtoms",
                    "providerFeeBps",
                  ),
                ),
              )
          }
      }
    ),
  )
  out.put(
    "deposit",
    pick(
      review.getJSONObject("deposit"),
      listOf(
        "estimatedAssetsAtoms",
        "minimumAssetsAtoms",
        "minimumSharesAtoms",
        "shareDecimals",
        "maximumFeeAtoms",
        "withdrawalReserveAtoms",
      ),
    ),
  )
  if (review.has("distribution"))
    out.put(
      "deposits",
      JSONArray(
        review.getJSONArray("deposits").objects().map {
          pick(it, depositFields + listOf("slot", "recipient"))
        }
      ),
    )
  return out
}

internal fun depositJsonMap(json: JSONObject): Map<String, Any> =
  json.keys().asSequence().associateWith { key -> depositJsonValue(json.get(key)) }

private fun depositJsonValue(value: Any): Any =
  when (value) {
    is JSONObject -> depositJsonMap(value)
    is JSONArray -> (0 until value.length()).map { depositJsonValue(value.get(it)) }
    else -> value
  }
