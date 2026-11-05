package io.gizu.storedwallet

import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.*

internal fun publicAccountAddress(record: WalletRecord, index: Int): String {
  val end = JSONObject(record.roleRegistry).getInt("nextRecipient")
  check(index == 0 || index == 1 || index in 3 until end) {
    "Funding source is not an allocated public account"
  }
  return deriveAccountAddressRange(record.entropy, index.toUInt(), 1u).single()
}

internal fun publicAccountIndices(record: WalletRecord): List<Int> {
  return portfolioAccountIndices(record.roleRegistry).map { it.toInt() }
}

internal fun cycleAddresses(record: WalletRecord): List<String> =
  savedCycleDistribution(record)?.let {
    deriveEarnDistributionAddresses(
      record.entropy,
      record.earnChain.toULong(),
      record.earnCycleIndex.toUInt(),
      distributionWeights(it).size.toUInt(),
    )
  }
    ?: deriveEarnCycleAddresses(
      record.entropy,
      record.earnChain.toULong(),
      record.earnCycleIndex.toUInt(),
    )

internal fun cycleInvestmentAddress(
  record: WalletRecord,
  slot: Int? = selectedInvestmentSlot(record),
): String {
  val distribution = savedCycleDistribution(record)
  if (distribution == null) {
    check(slot == null)
    return cycleAddresses(record)[1]
  }
  require(slot != null && slot in distributionWeights(distribution).indices)
  return cycleAddresses(record)[slot]
}

internal fun cycleConfidential(record: WalletRecord) =
  deriveEarnCycleConfidentialAddress(
    record.entropy,
    record.earnChain.toULong(),
    record.earnCycleIndex.toUInt(),
  )

internal fun requireActiveEarnCycle(record: WalletRecord, p: JSONObject) {
  check(p.optInt("cycleIndex", 0) == record.earnCycleIndex) {
    "Select the saved investment before resuming its operation"
  }
  if (p.has("investmentSlot")) {
    val distribution = checkNotNull(savedCycleDistribution(record))
    val slot = p.getInt("investmentSlot")
    check(
      p.getDouble("investmentSlot") == slot.toDouble() &&
        slot in distributionWeights(distribution).indices
    )
    check(slot == selectedInvestmentSlot(record)) {
      "Select the saved investment wallet before resuming its operation"
    }
    if (p.has("expectedFrom"))
      check(p.getString("expectedFrom").equals(cycleInvestmentAddress(record, slot), true))
  } else if (
    p.optString("kind") in
      setOf(
        "vaultDeposit",
        "vaultRedeemAll",
        "hoodDeposit",
        "hoodRedeemAll",
        "hoodRedeem",
        "authorizeHood7702",
        "hoodTokenReturn",
        "fusionEthOrder",
        "fusionUsdcApproval",
        "fusionUsdcPermit",
        "returnUsdc",
        "returnEth",
        "confidentialWithdrawal",
        "cancelPendingLiquidity",
      )
  ) {
    check(savedCycleDistribution(record) == null) { "Missing saved investment slot" }
  }
}

internal fun cycleReadAuth(
  record: WalletRecord,
  salt: ByteArray,
  random: ByteArray,
  started: ULong,
  now: ULong,
) =
  authenticateEarnCycleRead(
    record.entropy,
    record.earnChain.toULong(),
    record.earnCycleIndex.toUInt(),
    salt,
    random,
    started,
    now,
  )

internal fun currentCycleRows(record: WalletRecord, rows: List<JSONObject>) =
  rows.filter {
    val proposal = it.getJSONObject("proposal")
    proposal.optInt("cycleIndex", 0) == record.earnCycleIndex &&
      (!proposal.has("investmentSlot") ||
        proposal.getInt("investmentSlot") == selectedInvestmentSlot(record))
  }

internal fun recordForCycle(record: WalletRecord, cycle: JSONObject) =
  WalletRecord(
    record.id,
    record.credential,
    record.entropy.copyOf(),
    record.verified,
    record.journalId,
    record.roleRegistry,
    cycle.getInt("chainId"),
    record.earnRecoveryRequired,
    cycle.getInt("cycleIndex"),
    record.earnCycles,
    record.discoveryHighWater,
    record.discoveryRecoveryRequired,
  )

internal fun earnWithdrawalIndices(record: WalletRecord): Set<Int> {
  val rows = org.json.JSONArray(record.earnCycles)
  return (0 until rows.length())
    .map(rows::getJSONObject)
    .flatMap { row ->
      val indices = row.optJSONObject("withdrawalIndices")
      (if (row.has("withdrawalIndex")) listOf(row.getInt("withdrawalIndex")) else emptyList()) +
        (indices?.keys()?.asSequence()?.map { indices.getInt(it) }?.toList() ?: emptyList())
    }
    .toSet()
}
