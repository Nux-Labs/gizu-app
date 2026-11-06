package io.gizu.storedwallet

import android.content.Context
import java.math.BigInteger
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.supervisorScope
import org.json.JSONArray
import org.json.JSONObject

internal data class DepositSourceDraft(
  val rows: List<JSONObject>,
  val reservation: JSONObject,
  val minimumCredits: Map<String, String>,
)

internal fun nativeDepositPreparer(
  context: Context,
  record: WalletRecord,
  journal: EarnDepositJournal,
  privateReadAuthority: () -> Unit = {},
) =
  EarnDepositPreparer(
    journal,
    EarnDepositGateway(),
    { current, budget ->
      val own = journal.all().single { it.getInt("cycleIndex") == current.earnCycleIndex }
      var private =
        if (savedCycleDistribution(current) != null) {
          assertNoPrivateDeposit(context, current, own.getString("journeyId"))
          assertCashoutCanStart(context, current, own.getString("journeyId"))
          selectPrivateDepositSources(budget, privateDepositCandidates(context, current)) { source
            ->
            readPrivateDepositBalance(current, source, privateReadAuthority)
              .getValue("available")
              .toString()
          }
        } else PrivateDepositSelection(emptyList(), budget)
      fun sourceRows() =
        private.sources.mapIndexed { index, source ->
          val id = "private_" + UUID.randomUUID().toString().replace("-", "")
          JSONObject()
            .put("walletId", current.id)
            .put("operationId", id)
            .put("revision", 1)
            .put("status", "privateReserved")
            .put(
              "proposal",
              JSONObject()
                .put("kind", "privateEarnFunding")
                .put("operationId", id)
                .put("revision", 1)
                .put("profileChainId", 4663)
                .put("cycleIndex", current.earnCycleIndex)
                .put("sourceAccountIndex", -(index + 1))
                .put("expectedFrom", source.getString("address"))
                .put("confidentialAccount", cycleConfidential(current))
                .put("source", source)
                .put("token", MONAD_EARN_USDC)
                .put("budgetAtoms", source.getString("amountAtoms"))
                .put("amountAtoms", source.getString("amountAtoms"))
                .put("maximumTokenFeeAtoms", "0")
                .put("deadline", System.currentTimeMillis() / 1000 + 180),
            )
        }
      var privateRows = sourceRows()
      if (private.publicBudget == "0")
        return@EarnDepositPreparer DepositSourceDraft(
          privateRows,
          JSONObject().put("id", "private_" + own.getString("journeyId")),
          privateRows.associate {
            it.getString("operationId") to it.getJSONObject("proposal").getString("amountAtoms")
          },
        )
      var planned: JSONObject? = null
      repeat(3) {
        if (planned == null) {
          try {
            planned =
              JSONObject(
                NativeFundingPlanner(context, current)
                  .plan(private.publicBudget, depositBudgetAtoms = budget)
              )
          } catch (minimum: PublicFundingMinimum) {
            private = rebalancePrivateDepositSources(private, minimum.minimumAtoms)
            privateRows = sourceRows()
          }
        }
      }
      val plan = checkNotNull(planned) { "Public funding fees changed; review the amount again" }
      val ledger = fundingReservations(context, current)
      val batchId = plan.getString("fundingBatchId")
      try {
        val journey = journal.all().single { it.getInt("cycleIndex") == current.earnCycleIndex }
        journal.bindPreparationReservation(
          journey.getString("journeyId"),
          journey.getInt("revision"),
          batchId,
        )
        val quotes = earnQuoteJournal(context, current)
        val replan = EarnSourceReplanner(quotes)
        val credits = linkedMapOf<String, String>()
        val rows =
          plan.getJSONArray("legs").objects().map { leg ->
            val id = "source_" + UUID.randomUUID().toString().replace("-", "")
            val index = leg.getInt("sourceIndex")
            val owner = publicAccountAddress(current, index)
            ledger.bind(batchId, owner, id, leg.getString("budgetAtoms"))
            val original =
              JSONObject()
                .put("walletId", current.id)
                .put("operationId", id)
                .put("revision", 1)
                .put("status", "planned")
                .put(
                  "proposal",
                  JSONObject()
                    .put("kind", "sourceFunding")
                    .put("operationId", id)
                    .put("revision", 1)
                    .put("chainId", 143)
                    .put("profileChainId", 4663)
                    .put("cycleIndex", current.earnCycleIndex)
                    .put("sourceAccountIndex", index)
                    .put("fundingBatchId", batchId)
                    .put("fundingBatchSize", plan.getInt("fundingBatchSize"))
                    .put("expectedFrom", owner)
                    .put("refundOwner", owner)
                    .put("confidentialAccount", cycleConfidential(current))
                    .put("token", MONAD_EARN_USDC)
                    .put("recipient", cycleConfidential(current))
                    .put("nonce", "0x0")
                    .put("budgetAtoms", leg.getString("budgetAtoms"))
                    .put("amountAtoms", "1")
                    .put("maximumTokenFeeAtoms", "1")
                    .put("withdrawalReserveAtoms", "10000")
                    .put("slippageBps", 0)
                    .put("deadline", System.currentTimeMillis() / 1000 + 180),
                )
            val (p, unsigned) = replan.replan(current, original)
            val quote = checkNotNull(quotes.get(id, p.getInt("revision")))
            credits[id] = quote.getString("minimumCreditAtoms")
            original.put("proposal", p).put("unsignedUserOperation", unsigned)
          }
        ledger.commitBatch(batchId)
        privateRows.forEach {
          credits[it.getString("operationId")] =
            it.getJSONObject("proposal").getString("amountAtoms")
        }
        DepositSourceDraft(privateRows + rows, ledger.batch(batchId), credits)
      } catch (failure: Exception) {
        ledger.cancelBatchUnsigned(batchId)
        throw failure
      }
    },
    { review ->
      val id = review.getJSONObject("reservation").getString("id")
      if (!id.startsWith("private_")) fundingReservations(context, record).cancelBatchUnsigned(id)
    },
    reportFailure = { stage, code, location ->
      android.util.Log.w(
        "GizuEarnDeposit",
        "review failed: stage=$stage code=$code location=$location",
      )
    },
  )

/** Allocation is performed once by the native owner before this unsigned preparation. */
internal class EarnDepositPreparer(
  private val journal: EarnDepositJournal,
  private val gateway: EarnDepositGateway,
  private val selectSources: suspend (WalletRecord, String) -> DepositSourceDraft,
  private val releaseUnsigned: (JSONObject) -> Unit,
  private val now: () -> Long = System::currentTimeMillis,
  private val reportFailure: (String, String, String) -> Unit = { _, _, _ -> },
) {
  suspend fun prepare(
    record: WalletRecord,
    profile: Int,
    budgetAtoms: String,
    draftId: String?,
  ): JSONObject {
    check(profile == 4663 && record.earnChain == 4663)
    depositAtoms(budgetAtoms, true)
    var row = journal.loadOrCreate(record, profile, draftId)
    val id = row.getString("journeyId")
    check(row.getJSONObject("children").length() == 0) {
      "Reconcile the existing deposit before preparing another amount"
    }
    row =
      journal.cancelUnsignedReview(id) { batchId ->
        releaseUnsigned(JSONObject().put("reservation", JSONObject().put("id", batchId)))
      }
    row =
      journal.update(id, row.getInt("revision")) {
        it.put("phase", "preparing").put("budgetAtoms", budgetAtoms)
        it.remove("review")
        it.remove("indicativeReview")
        it.remove("pauseReason")
      }
    var draft: DepositSourceDraft? = null
    var stage = "sources"
    try {
      draft = selectSources(record, budgetAtoms)
      row = journal.get(id)
      check(row.getString("phase") == "preparing" && row.getJSONObject("children").length() == 0)
      check(row.getString("budgetAtoms") == budgetAtoms)
      check(draft.rows.isNotEmpty())
      savedCycleDistribution(record)?.let { distribution ->
        return prepareDistribution(record, profile, budgetAtoms, id, draft, distribution) {
          stage = it
        }
      }
      val sources = JSONArray()
      var offset = BigInteger.ZERO
      var minimumInvest = BigInteger.ZERO
      var sourceExpiry = Long.MAX_VALUE
      var payoutExpiry = Long.MAX_VALUE
      suspend fun readPayouts(s: JSONObject, revision: Int): Pair<BigInteger, Long> =
        supervisorScope {
          val tasks =
            listOf("hold", "invest").associateWith { leg ->
              async {
                gateway.payoutPreview(
                  record,
                  s.getString("operationId"),
                  revision,
                  leg,
                  s.getJSONObject(leg).getString("inputAtoms"),
                )
              }
            }
          var minimum = BigInteger.ZERO
          var expiry = Long.MAX_VALUE
          for (leg in listOf("hold", "invest")) {
            stage = "$leg-preview"
            val preview = tasks.getValue(leg).await()
            s.getJSONObject(leg)
              .put("estimatedOutputAtoms", preview.getString("estimatedOutputAtoms"))
              .put("minimumOutputAtoms", preview.getString("minimumOutputAtoms"))
              .put("providerFeeBps", preview.getInt("providerFeeBps"))
            expiry = minOf(expiry, preview.getLong("expiresAtMs"))
            if (leg == "invest")
              minimum = depositAtoms(preview.getString("minimumOutputAtoms"), true)
          }
          minimum to expiry
        }
      for (child in
        draft.rows.sortedBy { it.getJSONObject("proposal").getInt("sourceAccountIndex") }) {
        val p = child.getJSONObject("proposal")
        val sourceId = child.getString("operationId")
        val credit = depositAtoms(checkNotNull(draft.minimumCredits[sourceId]), true)
        val hold = (offset + credit) / BigInteger.TEN - offset / BigInteger.TEN
        val invest = credit - hold
        val s =
          JSONObject()
            .put("operationId", sourceId)
            .put("accountIndex", p.getInt("sourceAccountIndex"))
            .put("address", p.getString("expectedFrom"))
            .put("budgetAtoms", p.getString("budgetAtoms"))
            .put("amountAtoms", p.getString("amountAtoms"))
            .put("maximumFeeAtoms", p.getString("maximumTokenFeeAtoms"))
            .put("minimumCreditAtoms", credit.toString())
            .put(
              "retainedAtoms",
              (depositAtoms(p.getString("budgetAtoms")) -
                  depositAtoms(p.getString("amountAtoms")) -
                  depositAtoms(p.getString("maximumTokenFeeAtoms")))
                .toString(),
            )
        for ((n, leg, amount) in listOf(Triple(0, "hold", hold), Triple(1, "invest", invest))) {
          s.put(
            leg,
            JSONObject()
              .put("recipient", cycleAddresses(record)[n])
              .put("inputAtoms", amount.toString()),
          )
        }
        val previews = readPayouts(s, p.getInt("revision"))
        minimumInvest += previews.first
        payoutExpiry = minOf(payoutExpiry, previews.second)
        sourceExpiry = minOf(sourceExpiry, Math.multiplyExact(p.getLong("deadline"), 1000))
        sources.put(s)
        offset += credit
      }
      fun publishIndicative() {
        val saved = journal.get(id)
        journal.update(id, saved.getInt("revision")) {
          check(it.getString("phase") == "preparing" && it.getString("budgetAtoms") == budgetAtoms)
          val amounts = JSONObject().put("quotedAtMs", now()).put("sourceBudgetAtoms", budgetAtoms)
          for ((field, leg) in
            listOf("holdEstimatedAtoms" to "hold", "investEstimatedAtoms" to "invest")) amounts.put(
            field,
            sources
              .objects()
              .fold(BigInteger.ZERO) { n, s ->
                n + depositAtoms(s.getJSONObject(leg).getString("estimatedOutputAtoms"), true)
              }
              .toString(),
          )
          amounts.put(
            "sourceMaximumFeeAtoms",
            sources
              .objects()
              .fold(BigInteger.ZERO) { n, s -> n + depositAtoms(s.getString("maximumFeeAtoms")) }
              .toString(),
          )
          it.put("indicativeReview", amounts)
        }
      }
      publishIndicative()
      // Establish the deposit bound against minimum receipts, not optimistic output estimates.
      var completed: JSONObject? = null
      for (attempt in 0 until 3) {
        val saved = journal.get(id)
        check(saved.getString("phase") == "preparing")
        stage = "vault-preview"
        val preview =
          gateway.depositPreview(record, id, saved.getInt("revision"), minimumInvest.toString())
        if (payoutExpiry <= now() + 15000) {
          minimumInvest = BigInteger.ZERO
          payoutExpiry = Long.MAX_VALUE
          for (s in sources.objects()) {
            val p =
              draft.rows
                .single { it.getString("operationId") == s.getString("operationId") }
                .getJSONObject("proposal")
            val refreshed = readPayouts(s, p.getInt("revision"))
            minimumInvest += refreshed.first
            payoutExpiry = minOf(payoutExpiry, refreshed.second)
          }
          publishIndicative()
        }
        val required =
          listOf("depositAmount", "depositFeeBudget", "withdrawalReserve").fold(BigInteger.ZERO) {
            n,
            field ->
            n + depositAtoms(preview.getString(field), true)
          }
        if (
          required <= minimumInvest &&
            minOf(sourceExpiry, payoutExpiry, preview.getLong("expiresAtMs")) > now() + 15000
        ) {
          completed = preview
          break
        }
      }
      val deposit = checkNotNull(completed) { "Fresh deposit terms did not converge" }
      row = journal.get(id)
      check(row.getString("phase") == "preparing")
      val quotedAt = now()
      val expiry =
        minOf(quotedAt + 45000, sourceExpiry, payoutExpiry, deposit.getLong("expiresAtMs"))
      val review =
        JSONObject()
          .put("walletId", record.id)
          .put("generation", record.journalId)
          .put("cycleIndex", record.earnCycleIndex)
          .put("roleRegistry", JSONObject(record.roleRegistry))
          .put("profileChainId", profile)
          .put("confidentialAccount", cycleConfidential(record))
          .put("journeyId", id)
          .put("destinations", JSONArray(cycleAddresses(record)))
          .put("policyVersion", deposit.getString("policyVersion"))
          .put("sourceRefreshWithinLimits", true)
          .put("quotedAtMs", quotedAt)
          .put("expiresAtMs", expiry)
          .put("sourceBudgetAtoms", budgetAtoms)
          .put("sources", sources)
          .put("fundingRows", JSONArray(draft.rows))
          .put("reservation", draft.reservation)
          .put("deposit", vaultApprovalBounds(deposit))
      stage = "review-validation"
      EarnDepositApproval.fromReview(record, review).invalidate()
      return journal.saveReview(id, row.getInt("revision"), review)
    } catch (failure: Exception) {
      // Never log the exception message, request, wallet identity or financial terms.
      val code =
        when (failure) {
          is EarnGatewayFailure ->
            safeEarnGatewayFailure(JSONObject().put("code", failure.code).toString())?.code
              ?: "GATEWAY_REJECTED"
          is RpcFailure -> failure.code.name
          is CancellationException -> "CANCELLED"
          else -> "VALIDATION"
        }
      val frame =
        failure.stackTrace.firstOrNull {
          it.className.startsWith("io.gizu.storedwallet.") &&
            it.fileName?.matches(Regex("[A-Za-z0-9_.-]+\\.kt")) == true &&
            it.lineNumber > 0
        }
      val location = frame?.let { "${it.fileName}:${it.lineNumber}" } ?: "unknown"
      runCatching { reportFailure(stage, code, location) }
      val saved = journal.get(id)
      if (!saved.has("preparationBatchId") && draft != null)
        releaseUnsigned(JSONObject().put("reservation", draft.reservation))
      journal.cancelUnsignedReview(id) { batchId ->
        releaseUnsigned(JSONObject().put("reservation", JSONObject().put("id", batchId)))
      }
      journal.pause(
        id,
        if (saved.optString("pauseReason") in setOf("cancelled", "approvalExpired"))
          saved.getString("pauseReason")
        else "previewUnavailable",
      )
      if (failure is CancellationException) throw failure
      return journal.get(id)
    }
  }

  private suspend fun prepareDistribution(
    record: WalletRecord,
    profile: Int,
    budgetAtoms: String,
    id: String,
    draft: DepositSourceDraft,
    distribution: JSONObject,
    stage: (String) -> Unit,
  ): JSONObject {
    val weights = distributionWeights(distribution)
    val sources = JSONArray()
    var offset = BigInteger.ZERO
    var sourceExpiry = Long.MAX_VALUE
    var payoutExpiry = Long.MAX_VALUE
    suspend fun readPayouts(source: JSONObject, revision: Int) = supervisorScope {
      val allocations = source.getJSONArray("allocations")
      val tasks =
        weights.indices.map { slot ->
          async {
            gateway.payoutPreview(
              record,
              source.getString("operationId"),
              revision,
              "invest:$slot",
              allocations.getJSONObject(slot).getString("inputAtoms"),
            )
          }
        }
      for (slot in weights.indices) {
        stage("invest:$slot-preview")
        val preview = tasks[slot].await()
        allocations
          .getJSONObject(slot)
          .put("estimatedOutputAtoms", preview.getString("estimatedOutputAtoms"))
          .put("minimumOutputAtoms", preview.getString("minimumOutputAtoms"))
          .put("providerFeeBps", preview.getInt("providerFeeBps"))
        payoutExpiry = minOf(payoutExpiry, preview.getLong("expiresAtMs"))
      }
    }
    for (child in
      draft.rows.sortedBy { it.getJSONObject("proposal").getInt("sourceAccountIndex") }) {
      val proposal = child.getJSONObject("proposal")
      val sourceId = child.getString("operationId")
      val credit = depositAtoms(checkNotNull(draft.minimumCredits[sourceId]), true)
      val amounts = distributionAmounts(distribution, credit, offset)
      val source =
        JSONObject()
          .put("operationId", sourceId)
          .put("accountIndex", proposal.getInt("sourceAccountIndex"))
          .put("address", proposal.getString("expectedFrom"))
          .put("budgetAtoms", proposal.getString("budgetAtoms"))
          .put("amountAtoms", proposal.getString("amountAtoms"))
          .put("maximumFeeAtoms", proposal.getString("maximumTokenFeeAtoms"))
          .put("minimumCreditAtoms", credit.toString())
          .put(
            "retainedAtoms",
            (depositAtoms(proposal.getString("budgetAtoms")) -
                depositAtoms(proposal.getString("amountAtoms")) -
                depositAtoms(proposal.getString("maximumTokenFeeAtoms")))
              .toString(),
          )
          .put(
            "allocations",
            JSONArray(
              amounts.mapIndexed { slot, amount ->
                JSONObject()
                  .put("recipient", cycleInvestmentAddress(record, slot))
                  .put("inputAtoms", amount.toString())
              }
            ),
          )
      if (isPrivateDepositSource(child)) source.put("kind", "private")
      readPayouts(source, proposal.getInt("revision"))
      sources.put(source)
      sourceExpiry = minOf(sourceExpiry, Math.multiplyExact(proposal.getLong("deadline"), 1000))
      offset += credit
    }
    fun publishIndicative() {
      val saved = journal.get(id)
      journal.update(id, saved.getInt("revision")) {
        check(it.getString("phase") == "preparing" && it.getString("budgetAtoms") == budgetAtoms)
        val estimated =
          sources
            .objects()
            .flatMap { source -> source.getJSONArray("allocations").objects() }
            .fold(BigInteger.ZERO) { sum, allocation ->
              sum + depositAtoms(allocation.getString("estimatedOutputAtoms"), true)
            }
        val fees =
          sources.objects().fold(BigInteger.ZERO) { sum, source ->
            sum + depositAtoms(source.getString("maximumFeeAtoms"))
          }
        it.put(
          "indicativeReview",
          JSONObject()
            .put("quotedAtMs", now())
            .put("sourceBudgetAtoms", budgetAtoms)
            .put("holdEstimatedAtoms", "0")
            .put("investEstimatedAtoms", estimated.toString())
            .put("sourceMaximumFeeAtoms", fees.toString()),
        )
      }
    }
    fun minimums() =
      weights.indices.map { slot ->
        sources.objects().fold(BigInteger.ZERO) { sum, source ->
          sum +
            depositAtoms(
              source
                .getJSONArray("allocations")
                .getJSONObject(slot)
                .getString("minimumOutputAtoms"),
              true,
            )
        }
      }
    publishIndicative()
    var completed: List<JSONObject>? = null
    for (attempt in 0 until 3) {
      val saved = journal.get(id)
      check(saved.getString("phase") == "preparing")
      val minimums = minimums()
      stage("vault-preview")
      val previews = supervisorScope {
        weights.indices
          .map { slot ->
            async {
              gateway.depositPreview(
                record,
                id,
                saved.getInt("revision"),
                minimums[slot].toString(),
                slot = slot,
              )
            }
          }
          .map { it.await() }
      }
      if (payoutExpiry <= now() + 15000) {
        payoutExpiry = Long.MAX_VALUE
        for (source in sources.objects()) {
          val proposal =
            draft.rows
              .single { it.getString("operationId") == source.getString("operationId") }
              .getJSONObject("proposal")
          readPayouts(source, proposal.getInt("revision"))
        }
        publishIndicative()
        continue
      }
      if (
        previews.indices.all { slot ->
          val preview = previews[slot]
          val required =
            listOf("depositAmount", "depositFeeBudget", "withdrawalReserve").fold(
              BigInteger.ZERO
            ) { sum, field ->
              sum + depositAtoms(preview.getString(field), true)
            }
          required <= minimums[slot] &&
            minOf(sourceExpiry, payoutExpiry, preview.getLong("expiresAtMs")) > now() + 15000
        }
      ) {
        completed = previews
        break
      }
    }
    val previews = checkNotNull(completed) { "Fresh distribution deposit terms did not converge" }
    check(
      previews.all { it.getString("policyVersion") == previews.first().getString("policyVersion") }
    )
    val deposits =
      previews.mapIndexed { slot, preview ->
        vaultApprovalBounds(preview)
          .put("slot", slot)
          .put("recipient", cycleInvestmentAddress(record, slot))
      }
    val saved = journal.get(id)
    check(saved.getString("phase") == "preparing")
    val quotedAt = now()
    val review =
      JSONObject()
        .put("walletId", record.id)
        .put("generation", record.journalId)
        .put("cycleIndex", record.earnCycleIndex)
        .put("roleRegistry", JSONObject(record.roleRegistry))
        .put("profileChainId", profile)
        .put("confidentialAccount", cycleConfidential(record))
        .put("journeyId", id)
        .put("destinations", JSONArray(cycleAddresses(record)))
        .put("distribution", JSONObject(distribution.toString()))
        .put("policyVersion", previews.first().getString("policyVersion"))
        .put("sourceRefreshWithinLimits", true)
        .put("quotedAtMs", quotedAt)
        .put(
          "expiresAtMs",
          minOf(
            quotedAt + 45000,
            sourceExpiry,
            payoutExpiry,
            previews.minOf { it.getLong("expiresAtMs") },
          ),
        )
        .put("sourceBudgetAtoms", budgetAtoms)
        .put("sources", sources)
        .put("fundingRows", JSONArray(draft.rows))
        .put("reservation", draft.reservation)
        .put("deposits", JSONArray(deposits))
        .put("deposit", aggregateDepositBounds(deposits))
    stage("review-validation")
    EarnDepositApproval.fromReview(record, review).invalidate()
    return journal.saveReview(id, saved.getInt("revision"), review)
  }
}
