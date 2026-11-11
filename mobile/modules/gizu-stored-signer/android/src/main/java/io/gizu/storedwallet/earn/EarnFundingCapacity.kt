package io.gizu.storedwallet

import org.json.JSONObject

/**
 * Distribution funding must leave space for its whole downstream investment. All four permanent
 * operation journals admit 256 pending rows while retaining settled history across pages. Check
 * both before displaying approval and in the native authority callback before a new delegation or
 * funding signature. Already-signed source bytes retain their recovery path.
 */
internal fun requireDistributionFundingCapacity(
  record: WalletRecord,
  child: JSONObject,
  sponsored: List<JSONObject>,
  payouts: List<JSONObject>,
  vaults: List<JSONObject>,
  liquidity: List<JSONObject>,
  payoutJournalBytes: Long = org.json.JSONArray(payouts).toString().toByteArray().size.toLong(),
  payoutGroupGrowthBytes: Long =
    if (record.earnChain == 4663) EARN_PAYOUT_GROUP_STORAGE_BYTES.toLong() else 0L,
) {
  val distribution = savedCycleDistribution(record) ?: return
  val proposal = child.getJSONObject("proposal")
  if (proposal.getString("kind") != "sourceFunding" || child.sponsoredSpendSaved()) return
  requireActiveEarnCycle(record, proposal)
  check(proposal.getInt("profileChainId") == record.earnChain)
  val slots = distributionWeights(distribution).indices
  val sources =
    (sponsored + child)
      .filter { row ->
        val p = row.getJSONObject("proposal")
        p.optString("kind") == "sourceFunding" &&
          p.optInt("cycleIndex", 0) == record.earnCycleIndex &&
          p.optInt("profileChainId", 0) == record.earnChain &&
          (!row.optBoolean("cancelled") || row.sponsoredSpendSaved())
      }
      .map { it.getString("operationId") }
      .toSet()
  check(child.getString("operationId") in sources)
  val sponsoredIds = sponsored.map { it.getString("operationId") }.toSet()
  val missingSources = sources.count { it !in sponsoredIds }
  val allocatedPayouts =
    payouts
      .mapNotNull { row ->
        val p = row.getJSONObject("proposal")
        val source = p.optString("operationId")
        val leg = p.optString("leg")
        if (
          p.optString("kind") == "confidentialPayout" &&
            source in sources &&
            p.optInt("cycleIndex", 0) == record.earnCycleIndex &&
            p.optInt("profileChainId", 0) == record.earnChain &&
            nativeJsonEqual(p.opt("distribution"), distribution) &&
            leg in slots.map { "invest:$it" }
        )
          "$source:$leg"
        else null
      }
      .toSet()
  val missingPayouts =
    sources.sumOf { source -> slots.count { "$source:invest:$it" !in allocatedPayouts } }
  check(payouts.count(::journalEntryPending) + missingPayouts <= 256) {
    "Saved payout history has no space for every distribution wallet. Recover saved activity before funding."
  }

  check(
    payoutJournalBytes +
      missingPayouts.toLong() * DISTRIBUTION_PAYOUT_STORAGE_BYTES +
      payoutGroupGrowthBytes <= EARN_PAYOUT_JOURNAL_STORAGE_BYTES
  ) {
    "Encrypted recovery storage has no space for every distribution payout. No funding was authorized."
  }

  // Only a usable row for this exact cycle, slot and derived owner occupies a required future
  // position. Other pending rows still consume active capacity.
  val addresses = cycleAddresses(record)
  fun existingSlots(rows: List<JSONObject>, kind: String): Set<Int> =
    rows
      .mapNotNull { row ->
        val p = row.getJSONObject("proposal")
        val slot = p.optInt("investmentSlot", -1)
        if (
          p.optString("kind") == kind &&
            p.optInt("cycleIndex", 0) == record.earnCycleIndex &&
            p.optInt("chainId", 0) == record.earnChain &&
            slot in slots &&
            p.optDouble("investmentSlot", -1.0) == slot.toDouble() &&
            p.optString("expectedFrom").equals(addresses[slot], true) &&
            !row.optBoolean("cancelled") &&
            row.optString("status") !in setOf("reverted", "expired", "nonceCancelled")
        )
          slot
        else null
      }
      .toSet()
  val sponsoredDeposits =
    if (record.earnChain == 4663) slots.count { it !in existingSlots(sponsored, "hoodDeposit") }
    else 0
  check(sponsored.count(::journalEntryPending) + missingSources + sponsoredDeposits <= 256) {
    "Saved sponsored history has no space for the complete distribution. Recover saved activity before funding."
  }
  if (record.earnChain == 1) {
    val missingVaults = slots.count { it !in existingSlots(vaults, "vaultDeposit") }
    check(vaults.count(::journalEntryPending) + missingVaults <= 256) {
      "Saved vault history has no space for every distribution wallet. Recover saved activity before funding."
    }
    // The allowance route needs an approval and an order per wallet. The zero-ETH permit route
    // stores permit and order in one row, so reserving two also covers either bootstrap choice.
    val missingLiquidity =
      listOf("fusionUsdcApproval", "fusionEthOrder").sumOf { kind ->
        slots.count { it !in existingSlots(liquidity, kind) }
      }
    check(liquidity.count(::journalEntryPending) + missingLiquidity <= 256) {
      "Saved liquidity history has no space for every distribution wallet. Recover saved activity before funding."
    }
  }
}
