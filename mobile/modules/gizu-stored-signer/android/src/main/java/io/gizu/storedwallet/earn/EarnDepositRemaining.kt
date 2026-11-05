package io.gizu.storedwallet

import android.content.Context
import java.math.BigInteger
import org.json.JSONArray
import org.json.JSONObject

internal data class DepositRemainingSource(val row: JSONObject, val minimumCredit: String)

internal fun depositRemainingSourceRecord(
  original: JSONObject,
  saved: JSONObject?,
  referenced: Boolean,
): JSONObject {
  check(!referenced || saved != null) { "Missing saved source history" }
  check(saved == null || saved.getString("operationId") == original.getString("operationId"))
  return saved ?: original
}

/** Fresh unsigned economics, immutable signed children. No authority or allocation is created. */
internal class EarnDepositRemaining(
  private val journal: EarnDepositJournal,
  private val gateway: EarnDepositGateway,
  private val source: suspend (JSONObject) -> DepositRemainingSource,
  private val payout: suspend (String) -> JSONObject,
  private val receipt: (JSONObject) -> String?,
  private val reservation: () -> JSONObject,
  private val deposit: (String) -> JSONObject,
  private val now: () -> Long = System::currentTimeMillis,
) {
  suspend fun refresh(record: WalletRecord, id: String, revision: Int): JSONObject {
    val root = journal.get(id)
    check(root.getInt("revision") == revision && root.getString("phase") == "paused")
    val old = root.getJSONObject("review")
    val refs = root.getJSONObject("children")
    savedCycleDistribution(record)?.let { distribution ->
      return refreshDistribution(record, root, old, refs, distribution, id, revision)
    }
    val depositRef = refs.optJSONArray("deposit")
    if (depositRef != null && deposit(depositRef.getString(0)).sponsoredSpendSaved()) return root
    val next = JSONObject(old.toString())
    val rows = JSONArray()
    val sources = JSONArray()
    var offset = BigInteger.ZERO
    var minimumInvest = BigInteger.ZERO
    var paidInvest = BigInteger.ZERO
    var expiry = Long.MAX_VALUE
    for (previous in old.getJSONArray("sources").objects().sortedBy { it.getInt("accountIndex") }) {
      val sourceId = previous.getString("operationId")
      val updated =
        source(
          old.getJSONArray("fundingRows").objects().single {
            it.getString("operationId") == sourceId
          }
        )
      val p = updated.row.getJSONObject("proposal")
      val credit = depositAtoms(updated.minimumCredit, true)
      val held = (offset + credit) / BigInteger.TEN - offset / BigInteger.TEN
      val s =
        JSONObject(previous.toString())
          .put("amountAtoms", p.getString("amountAtoms"))
          .put("maximumFeeAtoms", p.getString("maximumTokenFeeAtoms"))
          .put("minimumCreditAtoms", credit.toString())
      s.put(
        "retainedAtoms",
        (depositAtoms(p.getString("budgetAtoms")) -
            depositAtoms(p.getString("amountAtoms")) -
            depositAtoms(p.getString("maximumTokenFeeAtoms")))
          .toString(),
      )
      for ((leg, input) in listOf("hold" to held, "invest" to credit - held)) {
        val child =
          refs.optJSONArray(leg)?.let { a ->
            (0 until a.length())
              .map { payout(a.getString(it)) }
              .singleOrNull { it.getJSONObject("proposal").getString("operationId") == sourceId }
          }
        val settled = child?.let(receipt)
        val bound =
          JSONObject(previous.getJSONObject(leg).toString()).put("inputAtoms", input.toString())
        if (settled != null) {
          check(child!!.getJSONObject("proposal").getString("amountAtoms") == input.toString())
          bound.put("minimumOutputAtoms", settled).put("estimatedOutputAtoms", settled)
          if (leg == "invest") paidInvest += depositAtoms(settled, true)
        } else if (child?.has("signedData") == true) {
          val fixed = child.getJSONObject("proposal")
          check(fixed.getString("amountAtoms") == input.toString())
          val minimum = depositAtoms(fixed.getString("minimumDestinationAtoms"), true)
          bound
            .put("minimumOutputAtoms", minimum.toString())
            .put(
              "estimatedOutputAtoms",
              maxOf(minimum, depositAtoms(bound.getString("estimatedOutputAtoms"))).toString(),
            )
        } else {
          val preview =
            gateway.payoutPreview(record, sourceId, p.getInt("revision"), leg, input.toString())
          bound
            .put("minimumOutputAtoms", preview.getString("minimumOutputAtoms"))
            .put("estimatedOutputAtoms", preview.getString("estimatedOutputAtoms"))
            .put("providerFeeBps", preview.getInt("providerFeeBps"))
          expiry = minOf(expiry, preview.getLong("expiresAtMs"))
        }
        s.put(leg, bound)
        if (leg == "invest")
          minimumInvest += depositAtoms(bound.getString("minimumOutputAtoms"), true)
      }
      rows.put(updated.row)
      sources.put(s)
      offset += credit
      if (!updated.row.sponsoredSpendSaved()) expiry = minOf(expiry, p.getLong("deadline") * 1000)
    }
    val preview =
      gateway.depositPreview(
        record,
        id,
        root.getInt("revision"),
        minimumInvest.toString(),
        paidInvest.toString(),
      )
    expiry = minOf(expiry, preview.getLong("expiresAtMs"))
    check(expiry > now())
    next
      .put("roleRegistry", JSONObject(record.roleRegistry))
      .put("quotedAtMs", now())
      .put("expiresAtMs", minOf(expiry, now() + 45000))
      .put("sources", sources)
      .put("fundingRows", rows)
      .put("reservation", reservation())
      .put("policyVersion", preview.getString("policyVersion"))
    next.put("deposit", vaultApprovalBounds(preview))
    EarnDepositApproval.fromReview(record, next).invalidate()
    return journal.saveRemainingReview(id, revision, next)
  }

  private suspend fun refreshDistribution(
    record: WalletRecord,
    root: JSONObject,
    old: JSONObject,
    refs: JSONObject,
    distribution: JSONObject,
    id: String,
    revision: Int,
  ): JSONObject {
    check(nativeJsonEqual(distribution, old.getJSONObject("distribution")))
    val weights = distributionWeights(distribution)
    val rows = JSONArray()
    val sources = JSONArray()
    val minimums = MutableList(weights.size) { BigInteger.ZERO }
    val paid = MutableList(weights.size) { BigInteger.ZERO }
    var offset = BigInteger.ZERO
    var expiry = Long.MAX_VALUE
    for (previous in old.getJSONArray("sources").objects().sortedBy { it.getInt("accountIndex") }) {
      val sourceId = previous.getString("operationId")
      val updated =
        source(
          old.getJSONArray("fundingRows").objects().single {
            it.getString("operationId") == sourceId
          }
        )
      val proposal = updated.row.getJSONObject("proposal")
      val credit = depositAtoms(updated.minimumCredit, true)
      val amounts = distributionAmounts(distribution, credit, offset)
      val current =
        JSONObject(previous.toString())
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
      val allocations = JSONArray()
      for (slot in weights.indices) {
        val leg = "invest:$slot"
        val input = amounts[slot].toString()
        val child =
          refs.optJSONArray(leg)?.let { references ->
            (0 until references.length())
              .map { payout(references.getString(it)) }
              .singleOrNull { it.getJSONObject("proposal").getString("operationId") == sourceId }
          }
        if (child != null) check(child.getJSONObject("proposal").getString("leg") == leg)
        val settled = child?.let(receipt)
        val bound =
          JSONObject(previous.getJSONArray("allocations").getJSONObject(slot).toString())
            .put("inputAtoms", input)
        check(bound.getString("recipient").equals(cycleInvestmentAddress(record, slot), true))
        if (settled != null) {
          check(child!!.getJSONObject("proposal").getString("amountAtoms") == input)
          bound.put("minimumOutputAtoms", settled).put("estimatedOutputAtoms", settled)
          paid[slot] += depositAtoms(settled, true)
        } else if (child?.has("signedData") == true) {
          val fixed = child.getJSONObject("proposal")
          check(fixed.getString("amountAtoms") == input)
          val minimum = depositAtoms(fixed.getString("minimumDestinationAtoms"), true)
          bound
            .put("minimumOutputAtoms", minimum.toString())
            .put(
              "estimatedOutputAtoms",
              maxOf(minimum, depositAtoms(bound.getString("estimatedOutputAtoms"))).toString(),
            )
        } else {
          val preview =
            gateway.payoutPreview(record, sourceId, proposal.getInt("revision"), leg, input)
          bound
            .put("minimumOutputAtoms", preview.getString("minimumOutputAtoms"))
            .put("estimatedOutputAtoms", preview.getString("estimatedOutputAtoms"))
            .put("providerFeeBps", preview.getInt("providerFeeBps"))
          expiry = minOf(expiry, preview.getLong("expiresAtMs"))
        }
        minimums[slot] += depositAtoms(bound.getString("minimumOutputAtoms"), true)
        allocations.put(bound)
      }
      current.put("allocations", allocations)
      rows.put(updated.row)
      sources.put(current)
      offset += credit
      if (!updated.row.sponsoredSpendSaved())
        expiry = minOf(expiry, Math.multiplyExact(proposal.getLong("deadline"), 1000))
    }
    val depositRows =
      refs.optJSONArray("deposit")?.let { references ->
        (0 until references.length()).map { deposit(references.getString(it)) }
      } ?: emptyList()
    check(depositRows.size <= weights.size)
    val depositSlots = depositRows.map { it.getJSONObject("proposal").getInt("investmentSlot") }
    check(
      depositSlots.distinct().size == depositSlots.size &&
        depositSlots.all { it in weights.indices }
    )
    val deposits =
      weights.indices.map { slot ->
        val child =
          depositRows.singleOrNull { it.getJSONObject("proposal").getInt("investmentSlot") == slot }
        val previous = old.getJSONArray("deposits").getJSONObject(slot)
        check(
          previous.getInt("slot") == slot &&
            previous.getString("recipient").equals(cycleInvestmentAddress(record, slot), true)
        )
        if (child != null)
          check(
            child
              .getJSONObject("proposal")
              .getString("expectedFrom")
              .equals(cycleInvestmentAddress(record, slot), true)
          )
        val invested =
          root.getJSONArray("investments").getJSONObject(slot).getString("status") == "invested"
        check(!invested || child?.sponsoredSpendSaved() == true) {
          "Missing completed investment child"
        }
        if (child?.sponsoredSpendSaved() == true) JSONObject(previous.toString())
        else {
          val preview =
            gateway.depositPreview(
              record,
              id,
              root.getInt("revision"),
              minimums[slot].toString(),
              paid[slot].toString(),
              slot,
            )
          check(preview.getString("policyVersion") == old.getString("policyVersion"))
          expiry = minOf(expiry, preview.getLong("expiresAtMs"))
          vaultApprovalBounds(preview)
            .put("slot", slot)
            .put("recipient", cycleInvestmentAddress(record, slot))
        }
      }
    check(expiry > now())
    val next =
      JSONObject(old.toString())
        .put("roleRegistry", JSONObject(record.roleRegistry))
        .put("quotedAtMs", now())
        .put("expiresAtMs", minOf(expiry, now() + 45000))
        .put("sources", sources)
        .put("fundingRows", rows)
        .put("reservation", reservation())
        .put("deposits", JSONArray(deposits))
        .put("deposit", aggregateDepositBounds(deposits))
    EarnDepositApproval.fromReview(record, next).invalidate()
    return journal.saveRemainingReview(id, revision, next)
  }
}

/** Only the existing native empty-intents read permission may authenticate pre-review history. */
internal fun requireDepositReadPermission(
  record: WalletRecord,
  wallet: String?,
  generation: String?,
  until: Long,
  now: Long,
) {
  check(
    record.verified &&
      record.id == wallet &&
      record.journalId == generation &&
      now in (until - 120000) until until
  ) {
    "Unlock your wallet again to reconcile saved payouts before reviewing the remaining deposit."
  }
}

internal suspend fun reconcileDepositPayoutBeforeReview(
  row: JSONObject,
  reconcile: suspend (JSONObject) -> JSONObject,
): JSONObject {
  if (!row.has("signedData") || row.getString("status") == "paid") return row
  return reconcile(row)
}

internal fun nativeDepositRemaining(
  context: Context,
  store: WalletStore,
  record: WalletRecord,
  journal: EarnDepositJournal,
  foreground: () -> Unit,
  readAuth: suspend () -> uniffi.gizu_stored_signer_core.EarnReadAuthentication,
): EarnDepositRemaining {
  val root = journal.all().single { it.getInt("cycleIndex") == record.earnCycleIndex }
  val sourceRefs = root.getJSONObject("children").optJSONArray("funding")
  val referenced =
    sourceRefs?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } ?: emptySet()
  val reservationId = root.getJSONObject("review").getJSONObject("reservation").getString("id")
  val sponsored = earnSponsoredJournal(context, record)
  val payouts = earnPayoutJournal(context, record)
  val quotes = earnQuoteJournal(context, record)
  val rootAdapter =
    EarnDepositEngineAdapter(
      context,
      store,
      record.id,
      record.journalId,
      record.earnCycleIndex,
      foreground,
    )
  return EarnDepositRemaining(
    journal,
    EarnDepositGateway(),
    { original ->
      foreground()
      val saved =
        sponsored
          .all()
          .singleOrNull { it.getString("operationId") == original.getString("operationId") }
          ?.let {
            rootAdapter.reconcileBeforeRemaining("funding", it.getString("operationId"), readAuth)
          }
      var current =
        depositRemainingSourceRecord(
          original,
          saved,
          original.getString("operationId") in referenced,
        )
      val credited = if (saved != null) rootAdapter.credit(saved) else null
      if (!current.sponsoredSpendSaved()) {
        check(
          !current.optBoolean("cancelled") &&
            !current.optBoolean("signingPending") &&
            !current.optBoolean("conflict")
        )
        val pair = EarnSourceReplanner(quotes).replan(record, current)
        current =
          if (saved != null)
            sponsored.refreshUnsignedSource(
              saved.getString("operationId"),
              saved.getInt("revision"),
              pair.first,
              pair.second,
            )
          else
            JSONObject(current.toString())
              .put("proposal", pair.first)
              .put("unsignedUserOperation", pair.second)
      }
      val p = current.getJSONObject("proposal")
      val minimum =
        credited
          ?: quotes
            .get(current.getString("operationId"), p.getInt("revision"))
            ?.getString("minimumCreditAtoms")
          ?: error("Missing source credit proof")
      DepositRemainingSource(current, minimum)
    },
    { id -> rootAdapter.reconcileBeforeRemaining("payouts", id, readAuth) },
    rootAdapter::payoutReceipt,
    { fundingReservations(context, record).batch(reservationId) },
    sponsored::get,
  )
}
