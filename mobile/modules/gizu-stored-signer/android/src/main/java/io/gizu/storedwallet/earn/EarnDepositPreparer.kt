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
  val publicFundingRows: List<JSONObject> = emptyList(),
  val publicMinimumCredits: Map<String, String> = emptyMap(),
  val approvedExistingPrivateAtoms: String = "0",
  val combinedSourceId: String? = null,
)

/** Public sources credit the existing private owner; downstream sees its usual private row. */
internal fun combineDepositSourceDraft(
  record: WalletRecord,
  draft: DepositSourceDraft,
  combinedId: String,
): DepositSourceDraft {
  val public = draft.rows.filterNot(::isPrivateDepositSource)
  if (public.isEmpty()) return draft
  check(cycleConfidential(record).equals(sharedConfidential(record), true))
  val private = draft.rows.filter(::isPrivateDepositSource)
  val own =
    private.filter {
      it
        .getJSONObject("proposal")
        .getString("expectedFrom")
        .equals(sharedConfidential(record), true)
    }
  check(own.size <= 1)
  val approved =
    own.fold(BigInteger.ZERO) { sum, row ->
      sum + depositAtoms(row.getJSONObject("proposal").getString("amountAtoms"), true)
    }
  val publicCredits =
    public.associate { row ->
      row.getString("operationId") to
        checkNotNull(draft.minimumCredits[row.getString("operationId")])
    }
  val minimum =
    publicCredits.values.fold(approved) { sum, amount -> sum + depositAtoms(amount, true) }
  val source =
    JSONObject()
      .put("kind", "swap")
      .put("profileChainId", 0)
      .put("cycleIndex", 0)
      .put("address", sharedConfidential(record))
      .put("amountAtoms", minimum.toString())
  val row =
    JSONObject()
      .put("walletId", record.id)
      .put("operationId", combinedId)
      .put("revision", 1)
      .put("status", "privateReserved")
      .put(
        "proposal",
        JSONObject()
          .put("kind", "privateEarnFunding")
          .put("operationId", combinedId)
          .put("revision", 1)
          .put("profileChainId", record.earnChain)
          .put("cycleIndex", record.earnCycleIndex)
          .put("sourceAccountIndex", -1)
          .put("expectedFrom", sharedConfidential(record))
          .put("confidentialAccount", cycleConfidential(record))
          .put("source", source)
          .put("token", MONAD_EARN_USDC)
          .put("amountAtoms", minimum.toString())
          .put("budgetAtoms", minimum.toString())
          .put("maximumTokenFeeAtoms", "0")
          .put("deadline", public.minOf { it.getJSONObject("proposal").getLong("deadline") }),
      )
  val rows =
    listOf(row) +
      private
        .filterNot { it in own }
        .mapIndexed { index, original ->
          JSONObject(original.toString()).also {
            it.getJSONObject("proposal").put("sourceAccountIndex", -(index + 2))
          }
        }
  return DepositSourceDraft(
    rows,
    draft.reservation,
    rows.associate {
      it.getString("operationId") to it.getJSONObject("proposal").getString("amountAtoms")
    },
    public,
    publicCredits,
    approved.toString(),
    combinedId,
  )
}

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
      val combinedPrivateAddress =
        sharedConfidential(current).takeIf {
          savedCycleDistribution(current) != null && cycleConfidential(current).equals(it, true)
        }
      val privateObservations = mutableMapOf<String, String>()
      var private =
        if (savedCycleDistribution(current) != null) {
          assertNoPrivateDeposit(context, current, own.getString("journeyId"))
          assertCashoutCanStart(context, current, own.getString("journeyId"))
          selectPrivateDepositSources(
            budget,
            privateDepositCandidates(context, current),
            minimumRoutableSource(savedCycleDistribution(current)),
            combinedPrivateAddress = combinedPrivateAddress,
          ) { source ->
            val owner = source.getString("address").lowercase()
            privateObservations[owner]
              ?: readPrivateDepositBalance(context, current, source, privateReadAuthority)
                .getValue("available")
                .toString()
                .also { privateObservations[owner] = it }
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
            requireRoutablePublicRemainder(
              private,
              savedCycleDistribution(current),
              combinedPrivateAddress,
            )
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
            val sourceChainId = leg.optInt("sourceChainId", 143)
            val owner = publicAccountAddress(current, index)
            ledger.bind(batchId, owner, id, leg.getString("budgetAtoms"), sourceChainId)
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
                    .put("chainId", sourceChainId)
                    .put("profileChainId", 4663)
                    .put("cycleIndex", current.earnCycleIndex)
                    .put("sourceAccountIndex", index)
                    .put("fundingBatchId", batchId)
                    .put("fundingBatchSize", plan.getInt("fundingBatchSize"))
                    .put("expectedFrom", owner)
                    .put("refundOwner", owner)
                    .put("confidentialAccount", cycleConfidential(current))
                    .put("token", fundingNetwork(sourceChainId).token)
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
        val draft = DepositSourceDraft(privateRows + rows, ledger.batch(batchId), credits)
        if (
          savedCycleDistribution(current) != null &&
            cycleConfidential(current).equals(sharedConfidential(current), true)
        )
          combineDepositSourceDraft(
            current,
            draft,
            "private_combined_" + own.getString("journeyId"),
          )
        else draft
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
        it.remove("message")
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
          is UnfinishedPrivateWork -> "PRIVATE_WORK_${failure.kind}_${failure.status}"
          is DepositPhaseBlocked -> "DEPOSIT_PHASE_${failure.phase}"
          is DepositBelowRouteMinimum -> "BELOW_ROUTE"
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
        else if (failure is RpcFailure && failure.code == RpcFailureCode.INSUFFICIENT_FUNDS)
          "insufficientFunds"
        else if (failure is DepositPhaseBlocked) "savedDepositOpen"
        else if (failure is DepositBelowRouteMinimum) "uneconomicAmount" else "previewUnavailable",
        if (
          failure is DepositBelowRouteMinimum &&
            saved.optString("pauseReason") !in setOf("cancelled", "approvalExpired")
        )
          failure.message
        else null,
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
          } +
            draft.publicFundingRows.fold(BigInteger.ZERO) { sum, row ->
              sum + depositAtoms(row.getJSONObject("proposal").getString("maximumTokenFeeAtoms"))
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
    if (draft.combinedSourceId != null)
      review
        .put("version", 2)
        .put("combinedSourceId", draft.combinedSourceId)
        .put("approvedExistingPrivateAtoms", draft.approvedExistingPrivateAtoms)
        .put("publicFundingRows", JSONArray(draft.publicFundingRows))
        .put("publicMinimumCredits", JSONObject(draft.publicMinimumCredits))
        .put(
          "fundedBudgetMinimumAtoms",
          sources
            .objects()
            .fold(BigInteger.ZERO) { sum, source ->
              sum + depositAtoms(source.getString("budgetAtoms"), true)
            }
            .toString(),
        )
    stage("review-validation")
    EarnDepositApproval.fromReview(record, review).invalidate()
    return journal.saveReview(id, saved.getInt("revision"), review)
  }
}

/** Public funding-only status contains no confidential descriptors or source proofs. */
internal fun fundingOnlyParentPublic(row: JSONObject): Map<String, Any> {
  check(row.getString("kind") == "fundingOnly" && row.getInt("version") == 2)
  val phase = row.getString("phase")
  check(
    phase in
      setOf("review", "funding", "pending", "ready", "payouts", "paid", "cancelled", "paused")
  )
  return mapOf(
    "version" to 2,
    "operationId" to row.getString("journeyId"),
    "walletId" to row.getString("walletId"),
    "revision" to row.getInt("revision"),
    "cycleIndex" to row.getInt("cycleIndex"),
    "profileChainId" to 1,
    "budgetAtoms" to row.getString("budgetAtoms"),
    "approvedExistingPrivateAtoms" to row.getString("approvedExistingPrivateAtoms"),
    "creditedAtoms" to if (row.has("privateHandoff")) row.getString("creditedAtoms") else "0",
    "phase" to phase,
    "blocked" to (phase in setOf("pending", "paused")),
    "canResume" to (phase !in setOf("paid", "cancelled")),
  )
}

internal fun requireFundingOnlyParent(record: WalletRecord, row: JSONObject) {
  requireSponsoredWallet(record, row.getString("walletId"))
  check(
    record.earnChain == 1 &&
      row.getString("kind") == "fundingOnly" &&
      row.getInt("version") == 2 &&
      row.getInt("profileChainId") == 1
  )
  check(
    record.journalId == row.getString("generation") &&
      record.earnCycleIndex == row.getInt("cycleIndex")
  )
  check(nativeJsonEqual(row.optJSONObject("distribution"), savedCycleDistribution(record)))
  check(
    row.getJSONArray("destinations").objects().map { it.getString("address").lowercase() } ==
      cycleAddresses(record).map(String::lowercase)
  )
}

internal suspend fun prepareNativeFundingOnlyParent(
  context: Context,
  store: WalletStore,
  record: WalletRecord,
  budgetAtoms: String,
  readAuthority: () -> Unit,
): JSONObject {
  requireSponsoredWallet(record, record.id)
  check(record.earnChain == 1)
  val budget = depositAtoms(budgetAtoms, true)
  check(budget.bitLength() <= 64)
  requireDistributionBudget(record, budgetAtoms)
  val journal = earnDepositJournal(context, record)
  journal
    .all()
    .singleOrNull {
      it.optString("kind") == "fundingOnly" &&
        it.getInt("cycleIndex") == record.earnCycleIndex &&
        it.getInt("profileChainId") == 1
    }
    ?.let {
      requireFundingOnlyParent(record, it)
      check(it.getString("budgetAtoms") == budgetAtoms) { "Resume the original funding budget" }
      return it
    }
  requireEthereumPrivateFundingAvailable()
  assertCashoutCanStart(context, record)
  val source =
    JSONObject()
      .put("kind", "swap")
      .put("profileChainId", 0)
      .put("cycleIndex", 0)
      .put("address", sharedConfidential(record))
      .put("amountAtoms", budgetAtoms)
  val observed = readPrivateDepositBalance(context, record, source, readAuthority)
  val available = depositAtoms(observed.getValue("available").toString())
  var approved = available.min(budget)
  var allocation: JSONObject? = null
  if (approved < budget) {
    repeat(3) {
      if (allocation == null)
        try {
          allocation =
            JSONObject(
              NativeFundingPlanner(context, record)
                .plan((budget - approved).toString(), "earn", budgetAtoms)
            )
        } catch (minimum: PublicFundingMinimum) {
          val required = depositAtoms(minimum.minimumAtoms, true)
          check(required <= budget) { "The original budget cannot cover source funding fees" }
          approved = budget - required
          check(approved <= available)
        }
    }
    checkNotNull(allocation) { "Funding fees changed; review the original budget again" }
  }
  val rows = JSONArray()
  val minimums = JSONObject()
  val ledger = fundingReservations(context, record)
  val batch = allocation
  try {
    if (batch != null) {
      val quotes = earnQuoteJournal(context, record)
      val replanner = EarnSourceReplanner(quotes, confidentialIdentity = ::sharedConfidential)
      for (leg in batch.getJSONArray("legs").objects()) {
        val id = "source_parent_" + UUID.randomUUID().toString().replace("-", "")
        val chain = leg.getInt("sourceChainId")
        val index = leg.getInt("sourceIndex")
        val owner = publicAccountAddress(record, index)
        ledger.bind(
          batch.getString("fundingBatchId"),
          owner,
          id,
          leg.getString("budgetAtoms"),
          chain,
        )
        val original =
          JSONObject()
            .put("walletId", record.id)
            .put("operationId", id)
            .put("revision", 1)
            .put("status", "planned")
            .put(
              "proposal",
              JSONObject()
                .put("kind", "sourceFunding")
                .put("operationId", id)
                .put("revision", 1)
                .put("chainId", chain)
                .put("profileChainId", 1)
                .put("cycleIndex", record.earnCycleIndex)
                .put("sourceAccountIndex", index)
                .put("fundingBatchId", batch.getString("fundingBatchId"))
                .put("fundingBatchSize", batch.getInt("fundingBatchSize"))
                .put("expectedFrom", owner)
                .put("refundOwner", owner)
                .put("confidentialAccount", sharedConfidential(record))
                .put("token", fundingNetwork(chain).token)
                .put("recipient", sharedConfidential(record))
                .put("nonce", "0x0")
                .put("budgetAtoms", leg.getString("budgetAtoms"))
                .put("amountAtoms", "1")
                .put("maximumTokenFeeAtoms", "1")
                .put("withdrawalReserveAtoms", "10000")
                .put("slippageBps", 0)
                .put("deadline", System.currentTimeMillis() / 1000 + 180),
            )
        val (p, unsigned) = replanner.replan(record, original)
        val quote = checkNotNull(quotes.get(id, p.getInt("revision")))
        minimums.put(id, quote.getString("minimumCreditAtoms"))
        rows.put(original.put("proposal", p).put("unsignedUserOperation", unsigned))
      }
      ledger.commitBatch(batch.getString("fundingBatchId"))
    }
    val minimum =
      minimums.keys().asSequence().fold(approved) { sum, id ->
        sum + depositAtoms(minimums.getString(id), true)
      }
    check(minimum >= minimumRoutableSource(savedCycleDistribution(record))) {
      "The funded amount is below the saved payout distribution minimum"
    }
    val reservation =
      if (batch != null) ledger.batch(batch.getString("fundingBatchId"))
      else JSONObject().put("id", "private_parent_${record.earnCycleIndex}")
    return journal.createFundingOnlyParent(
      record,
      budgetAtoms,
      approved.toString(),
      rows,
      minimums,
      reservation,
    )
  } catch (failure: Exception) {
    if (batch != null) ledger.cancelBatchUnsigned(batch.getString("fundingBatchId"))
    throw failure
  }
}

internal fun nativeFundingOnlySourceEngine(
  context: Context,
  store: WalletStore,
  parentId: String,
  sourceId: String,
): EarnSponsoredEngine {
  val identity =
    store.load().use { record ->
      val parent = earnDepositJournal(context, record).get(parentId)
      requireFundingOnlyParent(record, parent)
      val row =
        parent.getJSONObject("review").getJSONArray("publicFundingRows").objects().single {
          it.getString("operationId") == sourceId
        }
      row.getJSONObject("proposal").getInt("chainId") to record.id
    }
  val journal = store.load().use { earnSponsoredJournal(context, it) }
  val ledger = store.load().use { fundingReservations(context, it) }
  val quoteReader = NativeEarnQuoteGateway(quotes = journal.quotes)
  return EarnSponsoredEngine(
    store,
    journal,
    EarnSponsoredChainRpc(identity.first),
    EarnSponsoredBundlerRpc(identity.first),
    quoteReader = { proposal ->
      val proof =
        checkNotNull(quoteReader.binding(proposal)) { "A bound private-credit quote is required" }
      check(!proof.recoveryEnvelope.isNullOrBlank() && proof.maximumCreditAtoms != null) {
        "Authenticated baseline credit is required for a funding parent"
      }
      check(proof.originAsset == fundingNetwork(proposal.getInt("chainId")).originAsset)
      check(
        depositAtoms(checkNotNull(proof.maximumCreditAtoms), true) >=
          depositAtoms(proof.minimumCreditAtoms, true)
      )
      proof
    },
    reservations = ledger,
    sourceReplanner =
      EarnSourceReplanner(journal.quotes, confidentialIdentity = ::sharedConfidential)::replan,
    privateCreditRows = { address ->
      store.load().use { earnPrivateCreditRowsForSigning(context, it, address) }
    },
    freshPrivateAccount = { record, kind, address ->
      val parent = earnDepositJournal(context, record).get(parentId)
      requireFundingOnlyParent(record, parent)
      check(
        !parent.optBoolean("cancelRequested") &&
          kind == "sourceFunding" &&
          address.equals(sharedConfidential(record), true)
      )
      check(
        parent.getJSONObject("review").getJSONArray("publicFundingRows").objects().any {
          it.getString("operationId") == sourceId
        }
      )
    },
  )
}

/** Saved credits are replayed from the parent; later private balance changes are irrelevant. */
internal suspend fun reconcileFundingOnlySources(
  journal: EarnDepositJournal,
  parentId: String,
  reconcile: suspend (JSONObject) -> JSONObject?,
  validate: (JSONObject) -> Boolean,
): JSONObject {
  var parent = journal.get(parentId)
  if (parent.has("privateHandoff")) return parent
  val originals = parent.getJSONObject("review").getJSONArray("publicFundingRows").objects()
  for (original in originals) {
    val id = original.getString("operationId")
    if (parent.getJSONObject("fundingCredits").has(id)) continue
    val current = reconcile(original) ?: return parent
    if (!validate(current)) return parent
    parent = journal.recordFundingOnlyCredit(parentId, current)
  }
  return parent
}

internal suspend fun reconcileNativeFundingOnlyParent(
  context: Context,
  store: WalletStore,
  parentId: String,
  readAuthority: () -> Unit,
): JSONObject {
  val journal =
    store.load().use { record ->
      val result = earnDepositJournal(context, record)
      requireFundingOnlyParent(record, result.get(parentId))
      result
    }
  val sponsored = store.load().use { earnSponsoredJournal(context, it) }
  return reconcileFundingOnlySources(
    journal,
    parentId,
    { original ->
      var row =
        sponsored.all().singleOrNull {
          it.getString("operationId") == original.getString("operationId")
        } ?: return@reconcileFundingOnlySources null
      val chain = row.getJSONObject("proposal").getInt("chainId")
      reconcileEarnSponsoredOperations(
        sponsored,
        EarnSponsoredChainRpc(chain),
        EarnSponsoredBundlerRpc(chain),
        chainFilter = chain,
        operationIds = setOf(row.getString("operationId")),
      )
      row = sponsored.get(row.getString("operationId"))
      if (
        row.getString("status") == "finalized" &&
          row.optJSONObject("settlement")?.optString("status") != "credited"
      ) {
        val auth =
          store.load().use { record ->
            val source =
              JSONObject()
                .put("kind", "swap")
                .put("profileChainId", 0)
                .put("cycleIndex", 0)
                .put("address", sharedConfidential(record))
                .put("amountAtoms", "1")
            privateDepositReadAuth(record, source, readAuthority)
          }
        val proof = readNativeSponsoredSettlement(auth, sponsoredSettlementExpected(row))
        row =
          sponsored.update(row.getString("operationId"), row.getInt("revision")) {
            it.put("settlement", proof)
          }
      }
      row
    },
    { row ->
      if (
        row.getString("status") != "finalized" ||
          row.optJSONObject("settlement")?.optString("status") != "credited"
      )
        false
      else {
        store.load().use { record ->
          val p = row.getJSONObject("proposal")
          nativePayoutSource(
            row,
            row.getInt("revision"),
            PayoutIdentities(
              publicAccountAddress(record, p.optInt("sourceAccountIndex", 0)),
              sharedConfidential(record),
              cycleAddresses(record)[0],
            ),
            1,
          )
          fundingReservations(context, record).complete(row.getString("operationId"))
        }
        true
      }
    },
  )
}

/**
 * Selecting an old cycle still exposes its recovery row without poisoning another cycle's parser.
 */
internal fun fundingOnlyParentsForCycle(
  record: WalletRecord,
  rows: List<JSONObject>,
): List<JSONObject> =
  rows.filter {
    it.optString("kind") == "fundingOnly" &&
      it.getInt("profileChainId") == 1 &&
      it.getInt("cycleIndex") == record.earnCycleIndex &&
      it.getString("walletId") == record.id &&
      it.getString("generation") == record.journalId
  }
