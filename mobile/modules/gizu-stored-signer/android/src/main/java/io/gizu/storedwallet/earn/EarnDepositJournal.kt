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

  fun pendingSnapshot(record: WalletRecord, profile: String): Map<String, Any>? =
    synchronized(lock) {
      check(
        record.id == walletId &&
          record.journalId == generation &&
          record.verified &&
          !record.earnRecoveryRequired &&
          profile == "robinhood-usdg"
      )
      val row =
        activeDepositDrafts(record, all())
          .filter { it.getString("profileId") == profile }
          .maxByOrNull { it.getInt("cycleIndex") } ?: return@synchronized null
      val snapshot = publicSnapshot(row.getString("journeyId")).toMutableMap()
      if (row.getString("budgetAtoms") == "0") {
        check(
          row.getString("phase") == "draft" &&
            !row.has("review") &&
            row.getJSONObject("children").length() == 0 &&
            row.getJSONArray("completedSteps").length() == 0 &&
            row.getString("creditedAtoms") == "0"
        )
        // Allocation is durable before quoting. Recover its immutable budget after a crash
        // in that gap; no signature can exist before a child is durably attached.
        val budget = row.optString("distributionBudgetAtoms")
        if (budget.isBlank()) return@synchronized null
        snapshot["budgetAtoms"] = depositAtoms(budget, true).toString()
      }
      snapshot
    }

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

  /** Profile 1 funding provenance shares the existing encrypted parent journal. */
  fun createFundingOnlyParent(
    record: WalletRecord,
    budgetAtoms: String,
    approvedExistingPrivateAtoms: String,
    publicRows: JSONArray,
    minimums: JSONObject,
    reservation: JSONObject,
  ): JSONObject =
    synchronized(lock) {
      check(
        record.id == walletId &&
          record.journalId == generation &&
          record.verified &&
          !record.earnRecoveryRequired &&
          record.earnChain == 1
      )
      val budget = depositAtoms(budgetAtoms, true)
      val approved = depositAtoms(approvedExistingPrivateAtoms)
      check(budget.bitLength() <= 64 && approved <= budget)
      val rows = all()
      rows
        .singleOrNull {
          it.getInt("cycleIndex") == record.earnCycleIndex && it.getInt("profileChainId") == 1
        }
        ?.let {
          fundingOnlyRecord(it, record)
          check(it.getString("budgetAtoms") == budgetAtoms) {
            "Resume the original approved funding budget"
          }
          return@synchronized it
        }
      val sources = publicRows.objects()
      check(
        sources.size <= 256 &&
          sources.map { it.getString("operationId") }.distinct().size == sources.size
      )
      check(
        minimums.keys().asSequence().toSet() == sources.map { it.getString("operationId") }.toSet()
      )
      val identities = mutableSetOf<String>()
      var gross = approved
      var net = approved
      for (source in sources) {
        val p = source.getJSONObject("proposal")
        val chain = p.getInt("chainId")
        val index = p.optInt("sourceAccountIndex", 0)
        val owner = publicAccountAddress(record, index)
        check(chain == 143 || index == 1)
        check(!source.sponsoredSpendSaved() && !source.optBoolean("signingPending"))
        check(
          source.getString("walletId") == record.id &&
            p.getString("operationId") == source.getString("operationId")
        )
        check(
          p.getString("kind") == "sourceFunding" &&
            p.getInt("profileChainId") == 1 &&
            p.optInt("cycleIndex", 0) == record.earnCycleIndex
        )
        check(
          p.getString("token").equals(fundingNetwork(chain).token, true) &&
            p.getString("expectedFrom").equals(owner, true)
        )
        check(
          p.getString("refundOwner").equals(owner, true) &&
            p.getString("confidentialAccount").equals(sharedConfidential(record), true)
        )
        check(identities.add(fundingSourceId(chain, owner)))
        val amount = depositAtoms(p.getString("amountAtoms"), true)
        val sourceBudget = depositAtoms(p.getString("budgetAtoms"), true)
        check(
          amount +
            depositAtoms(p.getString("maximumTokenFeeAtoms")) +
            depositAtoms(p.getString("withdrawalReserveAtoms")) <= sourceBudget
        )
        val minimum = depositAtoms(minimums.getString(source.getString("operationId")), true)
        check(minimum <= amount)
        gross += sourceBudget
        net += minimum
      }
      check(gross == budget)
      val id = "funding_parent_" + UUID.randomUUID().toString().replace("-", "")
      val source =
        JSONObject()
          .put("kind", "swap")
          .put("profileChainId", 0)
          .put("cycleIndex", 0)
          .put("address", sharedConfidential(record))
          .put("amountAtoms", net.toString())
      val review =
        JSONObject()
          .put("version", 2)
          .put("fundingOnly", true)
          .put("combinedSourceId", id)
          .put("walletId", walletId)
          .put("generation", generation)
          .put("journeyId", id)
          .put("cycleIndex", record.earnCycleIndex)
          .put("profileChainId", 1)
          .put("confidentialAccount", sharedConfidential(record))
          .put("sourceBudgetAtoms", budgetAtoms)
          .put("approvedExistingPrivateAtoms", approvedExistingPrivateAtoms)
          .put("fundedBudgetMinimumAtoms", net.toString())
          .put("publicFundingRows", JSONArray(publicRows.toString()))
          .put("publicMinimumCredits", JSONObject(minimums.toString()))
          .put("reservation", JSONObject(reservation.toString()))
          .put(
            "sources",
            JSONArray()
              .put(
                JSONObject()
                  .put("kind", "private")
                  .put("operationId", id)
                  .put("accountIndex", -1)
                  .put("address", sharedConfidential(record))
                  .put("amountAtoms", net.toString())
                  .put("budgetAtoms", net.toString())
                  .put("minimumCreditAtoms", net.toString())
                  .put("source", source)
              ),
          )
      val distribution = savedCycleDistribution(record)
      val row =
        JSONObject()
          .put("version", 2)
          .put("kind", "fundingOnly")
          .put("journeyId", id)
          .put("revision", 1)
          .put("walletId", walletId)
          .put("generation", generation)
          .put("profileChainId", 1)
          .put("profileId", "ethereum-usdc")
          .put("cycleIndex", record.earnCycleIndex)
          .put("phase", "review")
          .put("budgetAtoms", budgetAtoms)
          .put("approvedExistingPrivateAtoms", approvedExistingPrivateAtoms)
          .put("creditedAtoms", "0")
          .put("review", review)
          .put(
            "children",
            JSONObject().put("funding", JSONArray(sources.map { it.getString("operationId") })),
          )
          .put("fundingCredits", JSONObject())
          .put("payoutChildren", JSONObject())
          .put("completedPayoutLegs", JSONArray())
          .put(
            "intentId",
            if (record.earnCycleIndex == 0) "earn-v1:${record.id.lowercase()}:ethereum-usdc"
            else "earn-v2:${record.id.lowercase()}:ethereum-usdc:${record.earnCycleIndex}",
          )
          .put(
            "destinations",
            JSONArray(
              cycleAddresses(record).mapIndexed { index, address ->
                JSONObject()
                  .put("address", address)
                  .put("chainId", 1)
                  .put("role", if (distribution != null || index > 0) "invest" else "hold")
                  .also { if (distribution != null) it.put("slot", index) }
              }
            ),
          )
      if (distribution != null) row.put("distribution", JSONObject(distribution.toString()))
      if (sources.isEmpty()) completeFundingOnlyHandoff(row)
      write(rows + row)
      row
    }

  private fun fundingOnlyRecord(row: JSONObject, record: WalletRecord) {
    check(
      row.getString("kind") == "fundingOnly" &&
        row.getInt("version") == 2 &&
        row.getInt("profileChainId") == 1
    )
    check(
      record.id == walletId &&
        record.journalId == generation &&
        record.verified &&
        !record.earnRecoveryRequired &&
        record.earnChain == 1
    )
    check(
      row.getString("walletId") == record.id &&
        row.getString("generation") == record.journalId &&
        row.getInt("cycleIndex") == record.earnCycleIndex
    )
    check(nativeJsonEqual(row.optJSONObject("distribution"), savedCycleDistribution(record)))
    check(
      row.getJSONArray("destinations").objects().map { it.getString("address").lowercase() } ==
        cycleAddresses(record).map(String::lowercase)
    )
    check(
      row
        .getJSONObject("review")
        .getString("confidentialAccount")
        .equals(sharedConfidential(record), true)
    )
  }

  private fun fundingOnlyLegs(row: JSONObject): List<String> =
    row.optJSONObject("distribution")?.let {
      distributionWeights(it).indices.map { slot -> "invest:$slot" }
    } ?: listOf("hold", "invest")

  private fun completeFundingOnlyHandoff(row: JSONObject) {
    val review = row.getJSONObject("review")
    val originals = review.getJSONArray("publicFundingRows").objects()
    val credits = row.getJSONObject("fundingCredits")
    check(originals.all { credits.has(it.getString("operationId")) })
    val evidence =
      JSONArray(
        originals.map { original ->
          val credit = credits.getJSONObject(original.getString("operationId"))
          JSONObject()
            .put("sourceId", credit.getString("sourceId"))
            .put("operationId", credit.getString("operationId"))
            .put("creditedAtoms", credit.getString("creditedAtoms"))
        }
      )
    val amount =
      uniffi.gizu_stored_signer_core.fundedPrivateAmount(
        row.getString("approvedExistingPrivateAtoms"),
        evidence.toString(),
      )
    check(depositAtoms(amount, true) <= depositAtoms(row.getString("budgetAtoms"), true))
    val source =
      JSONObject()
        .put("kind", "swap")
        .put("profileChainId", 0)
        .put("cycleIndex", 0)
        .put("address", review.getString("confidentialAccount"))
        .put("amountAtoms", amount)
    val handoff = JSONObject().put("source", source).put("operationId", row.getString("journeyId"))
    if (row.has("privateHandoff"))
      check(nativeJsonEqual(row.getJSONObject("privateHandoff"), handoff))
    else row.put("privateHandoff", handoff)
    row
      .put("creditedAtoms", amount)
      .put("phase", if (row.optBoolean("cancelRequested")) "cancelled" else "ready")
  }

  /** Caller supplies a source whose existing native settlement validator replayed its seal. */
  fun recordFundingOnlyCredit(id: String, source: JSONObject): JSONObject =
    synchronized(lock) {
      val previous = get(id)
      check(previous.getString("kind") == "fundingOnly")
      val originals = previous.getJSONObject("review").getJSONArray("publicFundingRows").objects()
      val sourceId = source.getString("operationId")
      val index = originals.indexOfFirst { it.getString("operationId") == sourceId }
      check(index >= 0)
      val credits = previous.getJSONObject("fundingCredits")
      check(originals.take(index).all { credits.has(it.getString("operationId")) }) {
        "Persist the previous private credit before advancing sources"
      }
      assertDepositPublicSourceRefresh(originals[index], source)
      check(source.getString("status") == "finalized" && source.has("signedUserOperation"))
      val settlement = source.getJSONObject("settlement")
      check(
        settlement.getString("status") == "credited" &&
          settlement.getString("settlementEnvelope").isNotBlank()
      )
      val amount = depositAtoms(settlement.getString("creditedAtoms"), true)
      val p = source.getJSONObject("proposal")
      check(
        amount in
          depositAtoms(
            previous
              .getJSONObject("review")
              .getJSONObject("publicMinimumCredits")
              .getString(sourceId),
            true,
          )..depositAtoms(p.getString("amountAtoms"), true)
      )
      if (credits.has(sourceId)) {
        check(credits.getJSONObject(sourceId).getString("creditedAtoms") == amount.toString())
        check(
          credits.getJSONObject(sourceId).getString("settlementEnvelope") ==
            settlement.getString("settlementEnvelope")
        )
        return@synchronized previous
      }
      update(id, previous.getInt("revision")) { row ->
        row
          .getJSONObject("review")
          .getJSONArray("publicFundingRows")
          .put(index, JSONObject(source.toString()))
        row
          .getJSONObject("fundingCredits")
          .put(
            sourceId,
            JSONObject()
              .put("sourceId", fundingSourceId(p.getInt("chainId"), p.getString("expectedFrom")))
              .put("operationId", sourceId)
              .put("creditedAtoms", amount.toString())
              .put("settlementEnvelope", settlement.getString("settlementEnvelope")),
          )
        if (row.getJSONObject("fundingCredits").length() == originals.size)
          completeFundingOnlyHandoff(row)
        else row.put("phase", if (row.optBoolean("cancelRequested")) "pending" else "funding")
      }
    }

  fun refreshFundingOnlySources(id: String, sources: JSONArray, minimums: JSONObject): JSONObject =
    synchronized(lock) {
      val previous = get(id)
      check(previous.getString("kind") == "fundingOnly")
      if (previous.has("privateHandoff")) return@synchronized previous
      val originals = previous.getJSONObject("review").getJSONArray("publicFundingRows").objects()
      val updated = sources.objects()
      check(
        originals.map { it.getString("operationId") } == updated.map { it.getString("operationId") }
      )
      check(
        minimums.keys().asSequence().toSet() == updated.map { it.getString("operationId") }.toSet()
      )
      originals.forEachIndexed { index, original ->
        assertDepositPublicSourceRefresh(original, updated[index])
        val sourceId = original.getString("operationId")
        val minimum = depositAtoms(minimums.getString(sourceId), true)
        check(
          minimum <=
            depositAtoms(updated[index].getJSONObject("proposal").getString("amountAtoms"), true)
        )
        previous.getJSONObject("fundingCredits").optJSONObject(sourceId)?.let {
          check(minimum <= depositAtoms(it.getString("creditedAtoms"), true))
        }
      }
      update(id, previous.getInt("revision")) { row ->
        row
          .getJSONObject("review")
          .put("publicFundingRows", JSONArray(sources.toString()))
          .put("publicMinimumCredits", JSONObject(minimums.toString()))
      }
    }

  fun fundingOnlyHandoff(id: String, record: WalletRecord): JSONObject =
    synchronized(lock) {
      val row = get(id)
      fundingOnlyRecord(row, record)
      check(
        !row.optBoolean("cancelRequested") &&
          row.getString("phase") in setOf("ready", "payouts", "paid") &&
          row.has("privateHandoff")
      )
      val source = row.getJSONObject("privateHandoff").getJSONObject("source")
      check(
        source.getString("kind") == "swap" &&
          source.getInt("profileChainId") == 0 &&
          source.getInt("cycleIndex") == 0 &&
          source.getString("address").equals(sharedConfidential(record), true)
      )
      check(source.getString("amountAtoms") == row.getString("creditedAtoms"))
      row
    }

  fun attachFundingOnlyPayout(
    id: String,
    leg: String,
    childId: String,
    record: WalletRecord,
  ): JSONObject =
    synchronized(lock) {
      val row = fundingOnlyHandoff(id, record)
      check(leg in fundingOnlyLegs(row) && childId.matches(Regex("[-A-Za-z0-9_]{1,128}")))
      val children = row.getJSONObject("payoutChildren")
      if (children.has(leg)) {
        check(children.getString(leg) == childId)
        return@synchronized row
      }
      check(children.keys().asSequence().none { children.getString(it) == childId })
      update(id, row.getInt("revision")) {
        it.getJSONObject("payoutChildren").put(leg, childId)
        it.put("phase", "payouts")
      }
    }

  fun recordFundingOnlyPayoutPaid(
    id: String,
    leg: String,
    childId: String,
    record: WalletRecord,
  ): JSONObject =
    synchronized(lock) {
      val row = get(id)
      fundingOnlyRecord(row, record)
      check(
        leg in fundingOnlyLegs(row) && row.getJSONObject("payoutChildren").getString(leg) == childId
      )
      val completed = row.getJSONArray("completedPayoutLegs")
      if ((0 until completed.length()).any { completed.getString(it) == leg })
        return@synchronized row
      update(id, row.getInt("revision")) { next ->
        next.getJSONArray("completedPayoutLegs").put(leg)
        val paid =
          next.getJSONArray("completedPayoutLegs").let { a ->
            (0 until a.length()).map { a.getString(it) }.toSet()
          }
        if (paid.containsAll(fundingOnlyLegs(next))) next.put("phase", "paid").put("status", "paid")
        else if (
          next.optBoolean("cancelRequested") &&
            next.getJSONObject("payoutChildren").keys().asSequence().all { it in paid }
        )
          next.put("phase", "cancelled").put("cancelled", true)
      }
    }

  fun cancelFundingOnlyParent(
    id: String,
    record: WalletRecord,
    payoutRows: List<JSONObject> = emptyList(),
  ): JSONObject =
    synchronized(lock) {
      val row = get(id)
      fundingOnlyRecord(row, record)
      if (row.getString("phase") == "paid") return@synchronized row
      update(id, row.getInt("revision")) { next ->
        next.put("cancelRequested", true)
        val credits = next.getJSONObject("fundingCredits")
        val unresolved =
          next.getJSONObject("review").getJSONArray("publicFundingRows").objects().any {
            it.sponsoredSpendSaved() && !credits.has(it.getString("operationId"))
          }
        val paid =
          next.getJSONArray("completedPayoutLegs").let { a ->
            (0 until a.length()).map { a.getString(it) }.toSet()
          }
        val pending =
          next.getJSONObject("payoutChildren").keys().asSequence().any { leg ->
            if (leg in paid) false
            else {
              val child =
                payoutRows.singleOrNull {
                  it.getString("operationId") == next.getJSONObject("payoutChildren").getString(leg)
                }
              child == null || child.has("signedData") || child.optBoolean("signingPending")
            }
          }
        next
          .put("phase", if (unresolved || pending) "paused" else "cancelled")
          .put("cancelled", !unresolved && !pending)
      }
    }

  fun update(id: String, revision: Int, action: (JSONObject) -> Unit): JSONObject =
    synchronized(lock) {
      val rows = all()
      val row = rows.single { it.getString("journeyId") == id }
      check(row.getInt("revision") == revision) { "Stale deposit journey" }
      val distribution = row.optJSONObject("distribution")?.toString()
      val fundingOnly = row.optString("kind") == "fundingOnly"
      val frozen =
        if (fundingOnly)
          (listOf(
              "kind",
              "version",
              "journeyId",
              "walletId",
              "generation",
              "profileChainId",
              "cycleIndex",
              "budgetAtoms",
              "approvedExistingPrivateAtoms",
              "destinations",
            ) +
              if (row.has("privateHandoff")) listOf("privateHandoff", "creditedAtoms")
              else emptyList())
            .associateWith { depositCanonical(row.opt(it)) }
        else emptyMap()
      val payouts =
        if (fundingOnly)
          row.getJSONObject("payoutChildren").keys().asSequence().associateWith {
            row.getJSONObject("payoutChildren").getString(it)
          }
        else emptyMap()
      val credits =
        if (fundingOnly)
          row.getJSONObject("fundingCredits").keys().asSequence().associateWith {
            depositCanonical(row.getJSONObject("fundingCredits").get(it))
          }
        else emptyMap()
      action(row)
      check(row.optJSONObject("distribution")?.toString() == distribution)
      frozen.forEach { (field, value) ->
        check(depositCanonical(row.opt(field)) == value) {
          "Funding parent financial identity is immutable"
        }
      }
      payouts.forEach { (leg, child) ->
        check(row.getJSONObject("payoutChildren").getString(leg) == child) {
          "A payout leg keeps its original child"
        }
      }
      credits.forEach { (source, proof) ->
        check(depositCanonical(row.getJSONObject("fundingCredits").get(source)) == proof) {
          "Completed credit evidence is immutable"
        }
      }
      if (fundingOnly && row.getString("phase") == "paid") {
        val paid =
          row.getJSONArray("completedPayoutLegs").let { a ->
            (0 until a.length()).map { a.getString(it) }.toSet()
          }
        check(paid.containsAll(fundingOnlyLegs(row)))
      }
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
      val combined = old.optInt("version", 1) == 2
      check(review.optInt("version", 1) == old.optInt("version", 1))
      if (combined) {
        for (field in listOf("approvedExistingPrivateAtoms", "combinedSourceId")) check(
          nativeJsonEqual(old.get(field), review.get(field))
        )
        val handoff = row.optJSONObject("privateHandoff")
        check(nativeJsonEqual(handoff, review.optJSONObject("privateHandoff"))) {
          "The saved private handoff is immutable"
        }
        val oldPublic = old.getJSONArray("publicFundingRows").objects()
        val nextPublic = review.getJSONArray("publicFundingRows").objects()
        check(
          oldPublic.map { it.getString("operationId") } ==
            nextPublic.map { it.getString("operationId") }
        )
        check(nextPublic.map { it.getString("operationId") }.distinct().size == nextPublic.size)
        for (source in oldPublic) assertDepositPublicSourceRefresh(
          source,
          nextPublic.single { it.getString("operationId") == source.getString("operationId") },
        )
        if (handoff == null)
          check(
            row
              .getJSONObject("children")
              .keys()
              .asSequence()
              .filter { it != "funding" && it != "deposit" }
              .none { row.getJSONObject("children").getJSONArray(it).length() > 0 }
          )
      }
      val before = old.getJSONArray("sources").objects()
      val after = review.getJSONArray("sources").objects()
      check(before.size == after.size)
      for (source in before) {
        val next = after.single { it.getString("operationId") == source.getString("operationId") }
        for (field in
          listOf("operationId", "accountIndex", "address") +
            if (combined && source.getString("operationId") == old.getString("combinedSourceId"))
              emptyList()
            else listOf("budgetAtoms")) check(nativeJsonEqual(source.get(field), next.get(field)))
      }
      if (combined) {
        val source =
          after.single { it.getString("operationId") == old.getString("combinedSourceId") }
        val expected =
          row.optJSONObject("privateHandoff")?.getString(old.getString("combinedSourceId"))
            ?: depositCombinedPrivateAmount(
              review,
              review.getJSONObject("publicMinimumCredits").keys().asSequence().associateWith {
                review.getJSONObject("publicMinimumCredits").getString(it)
              },
            )
        check(
          source.getString("budgetAtoms") == expected &&
            source.getString("amountAtoms") == expected &&
            source.getString("minimumCreditAtoms") == expected
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
    "savedDepositOpen",
    "unsupportedCapability",
    "cancelled",
  )

internal fun depositPublicReview(review: JSONObject): JSONObject {
  fun pick(row: JSONObject, fields: List<String>) =
    JSONObject().also { out -> fields.forEach { out.put(it, row.get(it)) } }
  val out = pick(review, listOf("policyVersion", "quotedAtMs", "expiresAtMs", "sourceBudgetAtoms"))
  if (review.optInt("version", 1) == 2) {
    for (field in
      listOf(
        "version",
        "combinedSourceId",
        "fundedBudgetMinimumAtoms",
        "approvedExistingPrivateAtoms",
      )) out.put(field, review.get(field))
    out.put(
      "fundingSources",
      JSONArray(
        depositFundingSources(review).map { source ->
          val result = JSONObject(source.toString())
          val p =
            review
              .getJSONArray("publicFundingRows")
              .objects()
              .single { it.getString("operationId") == source.getString("operationId") }
              .getJSONObject("proposal")
          result
            .put("token", p.getString("token"))
            .put(
              "retainedAtoms",
              (depositAtoms(p.getString("budgetAtoms")) -
                  depositAtoms(p.getString("amountAtoms")) -
                  depositAtoms(p.getString("maximumTokenFeeAtoms")))
                .toString(),
            )
        }
      ),
    )
  }
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
