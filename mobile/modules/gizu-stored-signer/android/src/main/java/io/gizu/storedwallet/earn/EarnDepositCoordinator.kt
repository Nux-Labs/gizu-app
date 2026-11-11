package io.gizu.storedwallet

import java.math.BigInteger
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject

internal data class DepositInvestment(
  val assets: String,
  val shares: String,
  val transactionHash: String,
)

/** Implemented solely by an adapter to the existing semantic signing/reconciliation engines. */
internal interface EarnDepositEngines {
  fun useGrant(grant: EarnDepositApproval?) {}

  fun invested(journeyId: String) {}

  suspend fun registerFunding(row: JSONObject): JSONObject

  suspend fun preparePayout(sourceId: String, leg: String): JSONObject

  suspend fun prepareDeposit(id: String, attributedAtoms: String, slot: Int? = null): JSONObject

  fun child(stage: String, id: String): JSONObject

  suspend fun execute(stage: String, id: String, grant: EarnDepositApproval)

  suspend fun reconcile(stage: String, id: String, grant: EarnDepositApproval?): JSONObject

  suspend fun reconcilePayoutGroup(review: JSONObject, grant: EarnDepositApproval?) {}

  fun credit(row: JSONObject): String?

  fun payoutReceipt(row: JSONObject): String?

  fun investment(row: JSONObject): DepositInvestment?
}

/** One advance reconciles only this journey. Waiting/polling belongs to its native host job. */
internal class EarnDepositCoordinator(
  private val journal: EarnDepositJournal,
  private val engines: EarnDepositEngines,
  private val reportFailure: (String, String) -> Unit = { _, _ -> },
) {
  private var activeGrant: EarnDepositApproval? = null

  suspend fun confirmed(journeyId: String, revision: Int, grant: EarnDepositApproval) {
    val row = journal.get(journeyId)
    check(
      activeGrant == null &&
        row.getInt("revision") == revision &&
        row.getString("phase") == "review"
    )
    check(depositCanonical(row.getJSONObject("review")) == depositCanonical(grant.review))
    activeGrant = grant
    engines.useGrant(grant)
    journal.update(journeyId, revision) { it.put("phase", "funding") }
    advance(journeyId, grant)
  }

  suspend fun resume(journeyId: String, revision: Int, grant: EarnDepositApproval) {
    val row = journal.get(journeyId)
    check(
      activeGrant == null &&
        row.getInt("revision") == revision &&
        row.getString("phase") == "paused"
    )
    check(depositCanonical(row.getJSONObject("review")) == depositCanonical(grant.review))
    activeGrant = grant
    engines.useGrant(grant)
    advance(journeyId, grant, retrySavedPayouts = true)
  }

  private fun setPhase(id: String, phase: String) {
    val row = journal.get(id)
    if (row.getString("phase") == phase && !row.has("pauseReason")) return
    journal.update(id, row.getInt("revision")) {
      it.put("phase", phase)
      it.remove("pauseReason")
    }
  }

  private fun saveAmounts(id: String, action: (JSONObject) -> Unit) {
    val row = journal.get(id)
    journal.update(id, row.getInt("revision"), action)
  }

  private fun attach(id: String, stage: String, childId: String) {
    val row = journal.get(id)
    val list = row.getJSONObject("children").optJSONArray(stage)
    if (list == null || (0 until list.length()).none { list.getString(it) == childId })
      journal.attachChild(id, row.getInt("revision"), stage, childId)
  }

  private suspend fun reconcileAndExecute(
    stage: String,
    id: String,
    grant: EarnDepositApproval?,
    retrySavedPayouts: Boolean = false,
  ): JSONObject {
    var row = engines.reconcile(stage, id, grant)
    if (
      row.getString("status") in setOf("planned", "authorizationSaved", "signed") ||
        (stage == "payouts" &&
          retrySavedPayouts &&
          row.getString("status") == "submissionUnknown" &&
          row.has("signedData")) ||
        (stage == "payouts" && row.getString("status") == "cancelled" && !row.has("signedData"))
    ) {
      if (grant == null) return row
      engines.execute(stage, id, grant)
      row = engines.reconcile(stage, id, grant)
    }
    return row
  }

  suspend fun advance(id: String, grant: EarnDepositApproval?, retrySavedPayouts: Boolean = false) {
    val start = journal.get(id)
    if (start.getString("phase") == "invested") return
    if (grant != null) check(activeGrant === grant)
    try {
      val review = start.getJSONObject("review")
      val sources = review.getJSONArray("sources").objects().sortedBy { it.getInt("accountIndex") }
      val originalRows = review.getJSONArray("fundingRows").objects()
      // Each polling pass re-verifies from the first source; it must not rewind live progress.
      if (start.getString("phase") !in setOf("settlingCredit", "payouts", "depositing"))
        setPhase(id, "funding")
      val credits = linkedMapOf<String, String>()
      for (s in sources) {
        if (s.optString("kind") == "private") continue
        val sourceId = s.getString("operationId")
        val children = journal.get(id).getJSONObject("children").optJSONArray("funding")
        val registered =
          children != null && (0 until children.length()).any { children.getString(it) == sourceId }
        if (!registered) {
          if (grant == null) {
            journal.pause(id, "approvalExpired")
            return
          }
          val created =
            engines.registerFunding(originalRows.single { it.getString("operationId") == sourceId })
          check(created.getString("operationId") == sourceId)
          attach(id, "funding", sourceId)
        }
      }
      // Register every selected source before the first can spend; a partial write cannot start a
      // batch.
      for (s in sources.filter { it.optString("kind") != "private" }) engines.child(
        "funding",
        s.getString("operationId"),
      )
      for (s in sources) {
        val sourceId = s.getString("operationId")
        if (s.optString("kind") == "private") {
          // Existing private funds never claim a public funding transaction or settlement credit.
          // The private signer authenticates the source balance again immediately before signing.
          val amount = s.getString("amountAtoms")
          credits[sourceId] = amount
          grant?.recordCredit(sourceId, amount)
          continue
        }
        val row = reconcileAndExecute("funding", sourceId, grant)
        check(row.getString("status") != "reverted") { "Source funding failed" }
        val credit = engines.credit(row)
        if (credit == null) {
          saveAmounts(id) {
            it.put(
              "creditedAtoms",
              credits.values.fold(BigInteger.ZERO) { n, a -> n + depositAtoms(a) }.toString(),
            )
          }
          if (grant != null)
            setPhase(
              id,
              if (row.getString("status") == "finalized") "settlingCredit" else "funding",
            )
          else journal.pause(id, "settlementPending")
          return
        }
        credits[sourceId] = credit
        grant?.recordCredit(sourceId, credit)
      }
      saveAmounts(id) {
        it.put(
          "creditedAtoms",
          credits.values.fold(BigInteger.ZERO) { n, a -> n + depositAtoms(a) }.toString(),
        )
      }
      if (credits.size != sources.size) {
        if (grant != null) setPhase(id, "settlingCredit")
        else journal.pause(id, "settlementPending")
        return
      }
      saveAmounts(id) { it.put("completedSteps", JSONArray(listOf("funding", "credit"))) }
      if (review.has("distribution")) {
        advanceDistribution(id, review, sources, grant, retrySavedPayouts)
        return
      }
      setPhase(id, "payouts")
      val receipts = linkedMapOf<String, String>()
      // Like Swap, send every payout leg first, then verify receipts, so one leg's delivery
      // never delays signing the other.
      val sent = linkedMapOf<String, JSONObject>()
      for (source in sources) for (leg in listOf("hold", "invest")) {
        val sourceId = source.getString("operationId")
        val refs = journal.get(id).getJSONObject("children").optJSONArray(leg)
        var child =
          refs?.let { array ->
            (0 until array.length())
              .map { engines.child("payouts", array.getString(it)) }
              .singleOrNull { it.getJSONObject("proposal").getString("operationId") == sourceId }
          }
        if (child == null) {
          if (grant == null) {
            journal.pause(id, "approvalExpired")
            return
          }
          child = engines.preparePayout(sourceId, leg)
          check(
            child.getJSONObject("proposal").getString("operationId") == sourceId &&
              child.getJSONObject("proposal").getString("leg") == leg
          )
          attach(id, leg, child.getString("operationId"))
        }
        sent["$sourceId:$leg"] =
          reconcileAndExecute("payouts", child.getString("operationId"), grant, retrySavedPayouts)
      }
      for (source in sources) for (leg in listOf("hold", "invest")) {
        val sourceId = source.getString("operationId")
        val payoutAtoms = engines.payoutReceipt(sent.getValue("$sourceId:$leg"))
        if (payoutAtoms == null) {
          saveAmounts(id) {
            it
              .put(
                "holdReceivedAtoms",
                sources
                  .fold(BigInteger.ZERO) { n, s ->
                    n + depositAtoms(receipts[s.getString("operationId") + ":hold"] ?: "0")
                  }
                  .toString(),
              )
              .put(
                "investReceivedAtoms",
                sources
                  .fold(BigInteger.ZERO) { n, s ->
                    n + depositAtoms(receipts[s.getString("operationId") + ":invest"] ?: "0")
                  }
                  .toString(),
              )
          }
          if (grant != null) setPhase(id, "payouts") else journal.pause(id, "submissionUnknown")
          return
        }
        payoutAtoms.let { atoms ->
          check(
            depositAtoms(atoms, true) >=
              depositAtoms(source.getJSONObject(leg).getString("minimumOutputAtoms"), true)
          )
          receipts["$sourceId:$leg"] = atoms
          grant?.recordPayout(sourceId, leg, atoms)
        }
      }
      val hold =
        sources.fold(BigInteger.ZERO) { n, s ->
          n + depositAtoms(receipts[s.getString("operationId") + ":hold"] ?: "0")
        }
      val invest =
        sources.fold(BigInteger.ZERO) { n, s ->
          n + depositAtoms(receipts[s.getString("operationId") + ":invest"] ?: "0")
        }
      saveAmounts(id) {
        it.put("holdReceivedAtoms", hold.toString()).put("investReceivedAtoms", invest.toString())
      }
      if (receipts.size != sources.size * 2) {
        if (grant != null) setPhase(id, "payouts") else journal.pause(id, "submissionUnknown")
        return
      }
      saveAmounts(id) {
        it.put("completedSteps", JSONArray(listOf("funding", "credit", "payouts")))
      }
      setPhase(id, "depositing")
      val depositId = "vault_$id"
      val refs = journal.get(id).getJSONObject("children").optJSONArray("deposit")
      if (refs == null) {
        if (grant == null) {
          journal.pause(id, "approvalExpired")
          return
        }
        val child = engines.prepareDeposit(depositId, invest.toString())
        check(child.getString("operationId") == depositId)
        check(
          depositAtoms(child.getJSONObject("proposal").getString("budgetAtoms"), true) <= invest
        )
        attach(id, "deposit", depositId)
      } else {
        check(refs.length() == 1 && refs.getString(0) == depositId)
        val existing = engines.child("deposit", depositId)
        if (
          grant != null &&
            !existing.sponsoredSpendSaved() &&
            existing.getString("status") in setOf("planned", "authorizationSaved")
        )
          engines.prepareDeposit(depositId, invest.toString())
      }
      val settled = reconcileAndExecute("deposit", depositId, grant)
      val investment = engines.investment(settled)
      if (investment == null) {
        if (grant != null) setPhase(id, "depositing") else journal.pause(id, "submissionUnknown")
        return
      }
      val bound = review.getJSONObject("deposit")
      check(
        depositAtoms(investment.assets, true) >=
          depositAtoms(bound.getString("minimumAssetsAtoms"), true) &&
          depositAtoms(investment.assets) <= invest
      )
      check(
        depositAtoms(investment.shares, true) >=
          depositAtoms(bound.getString("minimumSharesAtoms"), true)
      )
      earnHash(investment.transactionHash)
      saveAmounts(id) {
        it
          .put("phase", "invested")
          .put("depositedAtoms", investment.assets)
          .put("sharesAtoms", investment.shares)
          .put("depositTransactionHash", investment.transactionHash)
          .put("completedSteps", JSONArray(listOf("funding", "credit", "payouts", "deposit")))
      }
      engines.invested(id)
      grant?.invalidate()
      activeGrant = null
      engines.useGrant(null)
    } catch (failure: Exception) {
      if (failure is CancellationException) throw failure
      val diagnostic = depositFailureDiagnostic(failure)
      runCatching { reportFailure(diagnostic.first, diagnostic.second) }
      val missing = failure.message?.contains("Missing child journal") == true
      val reason =
        when {
          missing || failure is EarnGroupRecoveryRequired -> "recoveryRequired"
          failure is RpcFailure && failure.code == RpcFailureCode.INSUFFICIENT_FUNDS ->
            "insufficientFunds"
          failure is EarnRpcRejection && failure.method == "pm_getPaymasterData" ->
            "sponsorshipUnavailable"
          failure is RpcFailure &&
            failure.code in
              setOf(RpcFailureCode.NETWORK, RpcFailureCode.TIMEOUT, RpcFailureCode.HTTP) ->
            "providerUnavailable"
          failure is EarnGatewayFailure &&
            failure.code == "CONFIDENTIAL_PRIVATE_FUNDING_UNAVAILABLE" -> "providerUnavailable"
          else -> "termsChanged"
        }
      journal.pause(id, reason)
      grant?.invalidate()
      activeGrant = null
      engines.useGrant(null)
    }
  }

  private fun saveInvestment(id: String, slot: Int, action: (JSONObject) -> Unit) {
    saveAmounts(id) { row ->
      val investments = row.getJSONArray("investments").objects()
      val investment = investments.single { it.getInt("slot") == slot }
      action(investment)
      row.put("investments", JSONArray(investments))
      for ((aggregate, field) in
        listOf(
          "investReceivedAtoms" to "receivedAtoms",
          "depositedAtoms" to "depositedAtoms",
          "sharesAtoms" to "sharesAtoms",
        )) {
        row.put(
          aggregate,
          investments
            .fold(BigInteger.ZERO) { n, item -> n + depositAtoms(item.getString(field)) }
            .toString(),
        )
      }
      row.put("holdReceivedAtoms", "0")
      if (investments.size > 1) row.remove("depositTransactionHash")
    }
  }

  private suspend fun advanceDistribution(
    id: String,
    review: JSONObject,
    sources: List<JSONObject>,
    grant: EarnDepositApproval?,
    retrySavedPayouts: Boolean,
  ) {
    val legs = depositReviewLegs(review)
    val deposits = depositReviewDeposits(review)
    val receipts = linkedMapOf<String, String>()
    val sent = linkedMapOf<String, JSONObject>()
    var needsApproval = false
    setPhase(id, "payouts")
    // All sources have authenticated credit before any payout can enter this branch.
    for (source in sources) for (leg in legs) {
      val sourceId = source.getString("operationId")
      val refs = journal.get(id).getJSONObject("children").optJSONArray(leg)
      var child =
        refs?.let { array ->
          (0 until array.length())
            .map { engines.child("payouts", array.getString(it)) }
            .singleOrNull { it.getJSONObject("proposal").getString("operationId") == sourceId }
        }
      if (child == null) {
        if (grant == null) {
          needsApproval = true
          continue
        }
        child = engines.preparePayout(sourceId, leg)
        check(
          child.getJSONObject("proposal").getString("operationId") == sourceId &&
            child.getJSONObject("proposal").getString("leg") == leg
        )
        attach(id, leg, child.getString("operationId"))
      }
      sent["$sourceId:$leg"] =
        reconcileAndExecute("payouts", child.getString("operationId"), grant, retrySavedPayouts)
    }
    engines.reconcilePayoutGroup(review, grant)
    // An unresolved sibling must not hide an independently verified receipt.
    for (source in sources) for (leg in legs) {
      val sourceId = source.getString("operationId")
      val sentChild = sent["$sourceId:$leg"] ?: continue
      val child = engines.child("payouts", sentChild.getString("operationId"))
      val amount = engines.payoutReceipt(child) ?: continue
      check(
        depositAtoms(amount, true) >=
          depositAtoms(
            depositReviewBound(source, leg, review).getString("minimumOutputAtoms"),
            true,
          )
      )
      receipts["$sourceId:$leg"] = amount
      grant?.recordPayout(sourceId, leg, amount)
    }
    val allPayouts = receipts.size == sources.size * legs.size
    if (allPayouts)
      saveAmounts(id) {
        it.put("completedSteps", JSONArray(listOf("funding", "credit", "payouts")))
      }
    var completed = 0
    var pendingDeposit = false
    for ((slot, bound) in deposits.withIndex()) {
      val leg = "invest:$slot"
      val received =
        sources.fold(BigInteger.ZERO) { n, source ->
          n + depositAtoms(receipts[source.getString("operationId") + ":" + leg] ?: "0")
        }
      val ready = sources.all { receipts.containsKey(it.getString("operationId") + ":" + leg) }
      saveInvestment(id, slot) { investment ->
        check(investment.getString("recipient").equals(bound.getString("recipient"), true))
        investment.put("receivedAtoms", received.toString())
        if (investment.getString("status") !in setOf("invested", "depositing"))
          investment.put("status", if (ready) "received" else "pending")
      }
      if (!ready) continue
      val childId = depositChildId(id, slot)
      val refs = journal.get(id).getJSONObject("children").optJSONArray("deposit")
      val attached = refs != null && (0 until refs.length()).any { refs.getString(it) == childId }
      if (!attached) {
        if (grant == null) {
          needsApproval = true
          continue
        }
        val child = engines.prepareDeposit(childId, received.toString(), slot)
        check(child.getString("operationId") == childId)
        check(child.getJSONObject("proposal").getInt("investmentSlot") == slot)
        check(
          depositAtoms(child.getJSONObject("proposal").getString("budgetAtoms"), true) <= received
        )
        attach(id, "deposit", childId)
      } else {
        val existing = engines.child("deposit", childId)
        check(existing.getJSONObject("proposal").getInt("investmentSlot") == slot)
        if (
          grant != null &&
            !existing.sponsoredSpendSaved() &&
            existing.getString("status") in setOf("planned", "authorizationSaved")
        )
          engines.prepareDeposit(childId, received.toString(), slot)
      }
      saveInvestment(id, slot) {
        if (it.getString("status") != "invested") it.put("status", "depositing")
      }
      val settled = reconcileAndExecute("deposit", childId, grant)
      val investment = engines.investment(settled)
      if (investment == null) {
        pendingDeposit = true
        continue
      }
      check(
        depositAtoms(investment.assets, true) >=
          depositAtoms(bound.getString("minimumAssetsAtoms"), true) &&
          depositAtoms(investment.assets) <= received
      )
      check(
        depositAtoms(investment.shares, true) >=
          depositAtoms(bound.getString("minimumSharesAtoms"), true)
      )
      earnHash(investment.transactionHash)
      saveInvestment(id, slot) {
        it
          .put("depositedAtoms", investment.assets)
          .put("sharesAtoms", investment.shares)
          .put("transactionHash", investment.transactionHash)
          .put("status", "invested")
      }
      completed++
    }
    if (completed == deposits.size) {
      saveAmounts(id) {
        it
          .put("phase", "invested")
          .put("completedSteps", JSONArray(listOf("funding", "credit", "payouts", "deposit")))
        it.remove("pauseReason")
        if (deposits.size == 1)
          it.put(
            "depositTransactionHash",
            it.getJSONArray("investments").getJSONObject(0).getString("transactionHash"),
          )
      }
      engines.invested(id)
      grant?.invalidate()
      activeGrant = null
      engines.useGrant(null)
    } else if (grant == null) {
      journal.pause(id, if (needsApproval) "approvalExpired" else "submissionUnknown")
    } else setPhase(id, if (allPayouts || pendingDeposit) "depositing" else "payouts")
  }

  suspend fun reconcile(journeyId: String): Map<String, Any> {
    check(activeGrant == null) { "Read public progress while the native job owns reconciliation" }
    val before = journal.get(journeyId)
    val stoppedReason =
      before.optString("pauseReason").takeIf {
        before.getString("phase") == "paused" &&
          it.isNotEmpty() &&
          it !in setOf("settlementPending", "submissionUnknown")
      }
    advance(journeyId, null)
    val after = journal.get(journeyId)
    if (
      stoppedReason != null &&
        after.getString("phase") == "paused" &&
        after.optString("pauseReason") in
          setOf("settlementPending", "submissionUnknown", "approvalExpired")
    )
      journal.pause(journeyId, stoppedReason)
    return journal.publicSnapshot(journeyId)
  }

  suspend fun cancel(journeyId: String, revision: Int) {
    check(journal.get(journeyId).getInt("revision") == revision)
    activeGrant?.invalidate()
    activeGrant = null
    engines.useGrant(null)
    journal.pause(journeyId, "cancelled")
  }
}

/** Fixed error classification and code location only; never exception text or operation data. */
internal fun depositFailureDiagnostic(failure: Exception): Pair<String, String> {
  val code =
    when (failure) {
      is EarnRpcRejection -> {
        val method =
          failure.method.takeIf { it.matches(Regex("[A-Za-z][A-Za-z0-9_]{0,63}")) } ?: "REQUEST"
        val hint = failure.hint.takeIf { it.matches(Regex("[A-Z0-9_]{1,64}")) } ?: "REJECTED"
        "RPC_${method}_${failure.rpcCode}_$hint"
      }
      is RpcFailure -> failure.code.name
      is EarnGatewayFailure ->
        failure.code.takeIf { it.matches(Regex("[A-Z_]{1,64}")) } ?: "GATEWAY_REJECTED"
      else ->
        failure.javaClass.simpleName.takeIf { it.matches(Regex("[A-Za-z]{1,64}")) } ?: "VALIDATION"
    }
  val frame =
    failure.stackTrace.firstOrNull {
      it.className.startsWith("io.gizu.storedwallet.") &&
        it.fileName?.matches(Regex("[A-Za-z0-9_.-]+\\.kt")) == true &&
        it.lineNumber > 0
    }
  return code to (frame?.let { "${it.fileName}:${it.lineNumber}" } ?: "unknown")
}
