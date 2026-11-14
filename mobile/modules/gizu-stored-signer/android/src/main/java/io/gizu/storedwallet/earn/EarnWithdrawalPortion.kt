package io.gizu.storedwallet

import org.json.JSONObject

internal fun nextWithdrawalReserve(p: JSONObject): java.math.BigInteger =
  (p.getString("maximumTokenFeeAtoms").toBigInteger() * 260.toBigInteger() + 99.toBigInteger()) /
    100.toBigInteger()

/** A requested share portion can finish while other shares remain invested. */
internal fun withdrawnRequestedPortion(op: JSONObject): Boolean {
  val p = op.getJSONObject("proposal")
  if (
    op.optString("status") != "finalized" ||
      p.optString("kind") != "hoodRedeemAll" ||
      !p.has("requestedWithdrawalAtoms") ||
      !redeemedUsdg(op)
  )
    return false
  val selected = p.getString("amountAtoms").toBigInteger()
  val remaining = op.getString("residualShares").toBigInteger()
  // Exact burn and Withdraw logs already bind selected shares. Latest holdings can change later.
  check(selected.signum() > 0 && remaining.signum() >= 0)
  return true
}

internal fun requireWithdrawalSourceScope(redeem: JSONObject, proposal: JSONObject) {
  val source = redeem.getJSONObject("proposal")
  check(
    redeem.getString("status") == "finalized" &&
      source.getString("kind") == "hoodRedeemAll" &&
      redeemedUsdg(redeem)
  ) {
    "This withdrawal portion has not confirmed its proceeds"
  }
  check(redeem.optString("residualShares") == "0" || withdrawnRequestedPortion(redeem)) {
    "The selected withdrawal portion has not completed"
  }
  check(proposal.getString("withdrawalOperationId") == redeem.getString("operationId")) {
    "Private return source changed"
  }
  check(
    source.getString("expectedFrom").equals(proposal.getString("expectedFrom"), true) &&
      nativeJsonEqual(source.opt("cycleIndex") ?: 0, proposal.opt("cycleIndex") ?: 0) &&
      nativeJsonEqual(source.opt("investmentSlot"), proposal.opt("investmentSlot"))
  ) {
    "Private return wallet or portion changed"
  }
  val budget = proposal.getString("returnBudgetAtoms").toBigInteger()
  val spent =
    proposal.getString("amountAtoms").toBigInteger() +
      proposal.getString("maximumTokenFeeAtoms").toBigInteger()
  check(
    budget.signum() > 0 &&
      budget <= redeem.getString("redeemedUsdgAtoms").toBigInteger() &&
      spent.signum() > 0 &&
      spent <= budget
  ) {
    "Private return exceeds this withdrawal's proceeds"
  }
  if (
    source.has("requestedWithdrawalAtoms") &&
      redeem.getString("residualShares").toBigInteger().signum() > 0
  ) {
    val reserve = nextWithdrawalReserve(source)
    check(proposal.getString("withdrawalReserveAtoms").toBigInteger() >= reserve) {
      "The remaining investment needs its next-withdrawal gas reserve"
    }
  }
}

/** Included in the first native prompt even when it must also authorize delegation setup. */
internal fun requestedWithdrawalReview(
  p: JSONObject,
  previewAssets: String,
  heldShares: String,
): String {
  fun usdg(value: String): String {
    val n = value.toBigInteger()
    return "${n/1000000.toBigInteger()}.${(n%1000000.toBigInteger()).toString().padStart(6,'0')}"
  }
  if (p.has("requestedWithdrawalAtoms")) {
    val requested = p.getString("requestedWithdrawalAtoms").toBigInteger()
    val assets = previewAssets.toBigInteger()
    val tolerance =
      ((requested * 10.toBigInteger() + 9999.toBigInteger()) / 10000.toBigInteger()).max(
        java.math.BigInteger.ONE
      )
    val selected = p.getString("amountAtoms").toBigInteger()
    check(
      requested.signum() > 0 &&
        assets.signum() > 0 &&
        selected.signum() > 0 &&
        selected <= heldShares.toBigInteger() &&
        assets + java.math.BigInteger.ONE >= requested &&
        assets <= requested + tolerance
    )
    if (p.optBoolean("withdrawAllShares")) check(selected == heldShares.toBigInteger())
    return "\nRequested withdrawal: ${usdg(requested.toString())} USDG\nNative preview: ${usdg(previewAssets)} USDG\nExact selected shares: $selected\nMaximum network fee: ${usdg(p.getString("maximumTokenFeeAtoms"))} USDG\nApproximate amount: at most 0.10% upward price drift and one base unit of rounding. Other shares remain invested."
  }
  if (p.has("withdrawalOperationId"))
    return "\nReturn only the proceeds of withdrawal ${p.getString("withdrawalOperationId")}\nTransfer: ${usdg(p.getString("amountAtoms"))} USDG\nMaximum network fee: ${usdg(p.getString("maximumTokenFeeAtoms"))} USDG\nRetained withdrawal reserve: ${usdg(p.getString("withdrawalReserveAtoms"))} USDG\nPrivate USDC destination: ${p.getString("confidentialAccount")}"
  return ""
}

/** Only native-retired, same-nonce attempts can compete safely for one requested portion. */
internal fun requestedWithdrawal(p: JSONObject): Boolean =
  p.optString("kind") == "hoodRedeemAll" && p.has("withdrawalRequestId") ||
    p.optString("kind") == "hoodTokenReturn" && p.has("withdrawalOperationId")

internal fun sameWithdrawalNonce(a: JSONObject, b: JSONObject): Boolean =
  requestedWithdrawal(a) &&
    requestedWithdrawal(b) &&
    a.getString("kind") == b.getString("kind") &&
    a.getLong("chainId") == b.getLong("chainId") &&
    a.getString("expectedFrom").equals(b.getString("expectedFrom"), true) &&
    nativeJsonEqual(a.opt("cycleIndex") ?: 0, b.opt("cycleIndex") ?: 0) &&
    nativeJsonEqual(a.opt("investmentSlot"), b.opt("investmentSlot")) &&
    quantity(a.getString("nonce")) == quantity(b.getString("nonce"))

internal fun expiredWithdrawalReturnReplacement(
  old: JSONObject,
  current: JSONObject,
  walletId: String,
): Boolean {
  val a = old.getJSONObject("proposal")
  val b = current.getJSONObject("proposal")
  return old.optString("status") == "expired" &&
    old.getString("walletId") == walletId &&
    a.optString("kind") == "hoodTokenReturn" &&
    sameWithdrawalNonce(a, b) &&
    a.getString("withdrawalOperationId") == b.getString("withdrawalOperationId") &&
    a.getString("confidentialAccount").equals(b.getString("confidentialAccount"), true)
}

/** A canonical competing receipt consumes the nonce; retained old bytes can no longer execute. */
internal fun closeCompetingRequestedWithdrawals(journal: EarnSponsoredJournal) {
  val rows = journal.all()
  val confirmed =
    rows.filter {
      it.optString("status") in setOf("finalized", "reverted") &&
        it.sponsoredSpendSaved() &&
        it.has("transactionHash") &&
        requestedWithdrawal(it.getJSONObject("proposal"))
    }
  for (old in rows) {
    if (old.optString("status") != "expired" || !old.sponsoredSpendSaved()) continue
    if (
      confirmed.any {
        sameWithdrawalNonce(old.getJSONObject("proposal"), it.getJSONObject("proposal"))
      }
    )
      journal.update(old.getString("operationId"), old.getInt("revision")) {
        it.put("status", "nonceCancelled")
      }
  }
}

/** Do not redeem a saved request twice or spend the retained investment before its return ends. */
internal fun requireRequestedWithdrawalAdmission(
  rows: List<JSONObject>,
  current: JSONObject,
  walletId: String,
  generation: String,
) {
  val p = current.getJSONObject("proposal")
  if (p.optString("kind") != "hoodRedeemAll" || !p.has("withdrawalRequestId")) return
  for (old in rows) {
    val q = old.getJSONObject("proposal")
    if (
      old.getString("operationId") == current.getString("operationId") ||
        q.optString("kind") != "hoodRedeemAll" ||
        !q.has("withdrawalRequestId") ||
        !q.getString("expectedFrom").equals(p.getString("expectedFrom"), true) ||
        q.getLong("chainId") != p.getLong("chainId") ||
        !nativeJsonEqual(q.opt("cycleIndex") ?: 0, p.opt("cycleIndex") ?: 0) ||
        !nativeJsonEqual(q.opt("investmentSlot"), p.opt("investmentSlot")) ||
        !old.sponsoredSpendSaved()
    )
      continue
    val status = old.getString("status")
    if (status in setOf("reverted", "nonceCancelled")) continue
    if (status == "expired") {
      check(sameWithdrawalNonce(q, p)) {
        "Reconcile the previous withdrawal nonce before replacing it"
      }
      continue
    }
    check(
      status == "finalized" &&
        q.getString("withdrawalRequestId") != p.getString("withdrawalRequestId")
    ) {
      "This withdrawal request already has a signed redemption"
    }
    val returns =
      rows.filter {
        it.getJSONObject("proposal").optString("withdrawalOperationId") ==
          old.getString("operationId") &&
          !it.optBoolean("cancelled") &&
          !refundedSponsoredReturn(it, walletId, generation) &&
          it.optString("status") !in setOf("cancelled", "reverted", "nonceCancelled")
      }
    check(
      returns.isNotEmpty() && returns.all { completedReturnLifecycle(it, walletId, generation) }
    ) {
      "Finish returning the previous withdrawal before redeeming another portion"
    }
  }
}

/** Native journal evidence only: a JS supplied source ID or budget is never sufficient. */
internal fun requireWithdrawalReturnSource(
  rows: List<JSONObject>,
  op: JSONObject,
  walletId: String,
  shares: String,
  generation: String? = null,
) {
  val p = op.getJSONObject("proposal")
  if (p.getString("kind") != "hoodTokenReturn") return
  if (!p.has("withdrawalOperationId")) {
    check(!p.has("returnBudgetAtoms") && shares == "0") {
      "A return with invested shares requires a confirmed withdrawal source"
    }
    return
  }
  val id = p.getString("withdrawalOperationId")
  val source = rows.single { it.getString("operationId") == id }
  check(source.getString("walletId") == walletId && source.sponsoredSpendSaved())
  earnHash(source.getString("transactionHash"))
  requireWithdrawalSourceScope(source, p)
  if (
    shares.toBigInteger().signum() > 0 &&
      source.getJSONObject("proposal").has("requestedWithdrawalAtoms")
  )
    check(
      p.getString("withdrawalReserveAtoms").toBigInteger() >=
        nextWithdrawalReserve(source.getJSONObject("proposal"))
    ) {
      "The remaining investment needs its next-withdrawal gas reserve"
    }
  check(
    rows.none { prior ->
      prior.getString("operationId") != op.getString("operationId") &&
        prior.getJSONObject("proposal").optString("withdrawalOperationId") == id &&
        prior.sponsoredSpendSaved() &&
        prior.optString("status") !in setOf("reverted", "nonceCancelled") &&
        !expiredWithdrawalReturnReplacement(prior, op, walletId) &&
        !(generation != null && refundedSponsoredReturn(prior, walletId, generation))
    }
  ) {
    "This withdrawal's proceeds already have a signed private return"
  }
}
