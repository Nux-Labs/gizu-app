package io.gizu.storedwallet

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Journal inventory only: no reconciliation, account selection, signing or networking. */
internal fun readEarnInvestmentPositions(
  context: Context,
  record: WalletRecord,
  walletId: String,
): List<Map<String, Any>> {
  check(record.id == walletId && record.verified)
  fun file(name: String) =
    AndroidWalletFile(context, "gizu-earn-$name-${record.journalId}.enc", 4 * 1024 * 1024)
  val key = { checkNotNull(AndroidWalletKeys().existing()) }
  return earnInvestmentPositions(
    record,
    walletId,
    EarnVaultJournal(file("vault"), key, record.id, record.journalId).all(),
    EarnSponsoredJournal(file("sponsored"), key, record.id, record.journalId).all(),
    EarnLiquidityJournal(file("liquidity"), key, record.id, record.journalId).all(),
    EarnWithdrawalJournal(file("withdrawal"), key, record.id, record.journalId).all(),
  )
}

internal fun earnInvestmentPositions(
  record: WalletRecord,
  walletId: String,
  vault: List<JSONObject>,
  sponsored: List<JSONObject>,
  liquidity: List<JSONObject>,
  withdrawals: List<JSONObject>,
): List<Map<String, Any>> {
  check(record.id == walletId && record.verified)
  val cycles =
    JSONArray(record.earnCycles).objects().ifEmpty {
      if (record.earnChain == 0) emptyList()
      else
        listOf(
          JSONObject().put("cycleIndex", record.earnCycleIndex).put("chainId", record.earnChain)
        )
    }
  check(cycles.map { it.getInt("cycleIndex") }.distinct().size == cycles.size)
  val result = mutableListOf<Map<String, Any>>()
  for (cycle in cycles) recordForCycle(record, cycle).use { selected ->
    val chain = selected.earnChain
    check(chain in setOf(1, 4663))
    val profile = if (chain == 1) "ethereum-usdc" else "robinhood-usdg"
    val distribution = savedCycleDistribution(selected)
    val slots: List<Int?> =
      distribution?.let { distributionWeights(it).indices.toList() } ?: listOf(null)
    val intentId =
      if (selected.earnCycleIndex == 0) "earn-v1:${record.id.lowercase()}:$profile"
      else "earn-v2:${record.id.lowercase()}:$profile:${selected.earnCycleIndex}"
    val owners = cycleAddresses(selected)
    val confidential = cycleConfidential(selected)
    for (slot in slots) {
      val owner = owners[slot ?: 1]
      fun matches(op: JSONObject, withdrawal: Boolean = false): Boolean {
        val p = op.getJSONObject("proposal")
        if (
          op.optString("walletId", record.id) != record.id ||
            p.optInt("cycleIndex", 0) != selected.earnCycleIndex
        )
          return false
        if (
          slot == null && p.has("investmentSlot") ||
            slot != null &&
              (!p.has("investmentSlot") || p.optDouble("investmentSlot", -1.0) != slot.toDouble())
        )
          return false
        if (withdrawal) {
          if (
            p.optInt("profileChainId", -1) != chain ||
              (!p.optString("expectedSigner").equals(confidential, true) &&
                !p.optString("expectedSigner").equals(sharedConfidential(selected), true))
          )
            return false
        } else if (
          p.optInt("chainId", -1) != chain ||
            p.optInt("profileChainId", chain) != chain ||
            !p.optString("expectedFrom").equals(owner, true)
        )
          return false
        if (
          p.has("vault") &&
            !p.getString("vault").equals(if (chain == 1) ETH_EARN_VAULT else HOOD_EARN_VAULT, true)
        )
          return false
        return true
      }
      val primary =
        (if (chain == 1) vault else sponsored).filter {
          matches(it) &&
            it.getJSONObject("proposal").optString("kind") in
              (if (chain == 1) setOf("vaultDeposit", "vaultRedeemAll")
              else setOf("hoodDeposit", "hoodRedeemAll"))
        }
      val returns =
        (if (chain == 1) liquidity else sponsored).filter {
          matches(it) &&
            it.getJSONObject("proposal").optString("kind") in
              (if (chain == 1) setOf("returnUsdc", "returnEth") else setOf("hoodTokenReturn"))
        }
      val payouts =
        withdrawals.filter {
          matches(it, true) &&
            it.getJSONObject("proposal").optString("kind") == "confidentialWithdrawal"
        }
      fun completed(op: JSONObject): Boolean =
        if (op.has("steps"))
          op.steps().isNotEmpty() && op.steps().all { it.getString("status") == "finalized" }
        else op.optString("status") == "finalized"
      fun pending(op: JSONObject): Boolean {
        if (op.has("steps")) return op.earnBlocked()
        val status = op.optString("status")
        if (status in setOf("paid", "finalized", "reverted", "nonceCancelled")) return false
        if (
          op.sponsoredSpendSaved() ||
            op.has("signedData") ||
            op.optBoolean("signingPending") ||
            op.optBoolean("signingAuthorizationPending")
        )
          return true
        if (status in setOf("cancelled", "expired")) return false
        return !op.optBoolean("cancelled")
      }
      val last = primary.lastOrNull(::completed)
      val completedReturns = returns.filter(::completed)
      // A settled return closes the redeem that produced it. A later redeem is a new withdrawal.
      val settledReturnAt =
        completedReturns.maxOfOrNull { sponsored.indexOf(it) }?.takeIf { it >= 0 }
      fun supersededRedeem(op: JSONObject): Boolean {
        val at = settledReturnAt ?: return false
        if (op.getJSONObject("proposal").optString("kind") != "hoodRedeemAll") return false
        val index = sponsored.indexOf(op)
        return index >= 0 && index < at
      }
      fun open(op: JSONObject) = pending(op) && !supersededRedeem(op)
      val depositStillOpen =
        last != null &&
          last.getJSONObject("proposal").getString("kind") in
            setOf("vaultDeposit", "hoodDeposit") &&
          (settledReturnAt == null || sponsored.indexOfLast { it === last } > settledReturnAt)
      val activity =
        when {
          (primary + returns + payouts).any(::open) -> "pending"
          depositStillOpen -> "invested"
          last != null &&
            (if (last.has("steps")) last.steps().last().optString("residualShares", "")
            else last.optString("residualShares", "")) != "0" -> "invested"
          // Paid return children cannot attest unswept native/token residuals. Keep
          // this target reachable until the existing fresh exit checker verifies it.
          last != null || completedReturns.isNotEmpty() -> "redeemed"
          else -> null
        }
      val attention =
        if (chain != 4663) null
        else {
          val redeemPending =
            primary.any {
              open(it) && it.getJSONObject("proposal").optString("kind") == "hoodRedeemAll"
            }
          val returnPending = returns.any(::pending)
          val redeemSettled =
            last?.let {
              it.getJSONObject("proposal").optString("kind") == "hoodRedeemAll" &&
                it.optString("residualShares") == "0"
            } == true
          val latestPrimaryAt = last?.let { sponsored.indexOf(it) } ?: -1
          val currentReturns = returns.filter { sponsored.indexOf(it) > latestPrimaryAt }
          val returnFinalized = currentReturns.any(::completed)
          val returnSettled =
            currentReturns.any { op ->
              completed(op) &&
                (op.optJSONObject("settlement")?.optString("status") == "credited" ||
                  savedMinimumReturnReceipt(op, record.id, record.journalId) != null)
            }
          when {
            returnPending -> "returning"
            redeemPending -> "confirming"
            returnFinalized && !returnSettled -> "checking"
            redeemSettled && !returnSettled -> "unfinished"
            else -> null
          }
        }
      if (activity != null)
        result.add(
          buildMap {
            put("intentId", intentId)
            put("cycleIndex", selected.earnCycleIndex)
            put("profileId", profile)
            if (slot != null) put("investmentSlot", slot)
            put("activity", activity)
            put("recoveryRequired", record.earnRecoveryRequired || record.discoveryRecoveryRequired)
            if (attention != null) put("withdrawalAttention", attention)
          }
        )
    }
  }
  return result
}
