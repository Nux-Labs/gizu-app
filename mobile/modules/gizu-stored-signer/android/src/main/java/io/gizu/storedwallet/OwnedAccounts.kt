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

internal fun cycleAddresses(record: WalletRecord) =
  deriveEarnCycleAddresses(
    record.entropy,
    record.earnChain.toULong(),
    record.earnCycleIndex.toUInt(),
  )

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
  rows.filter { it.getJSONObject("proposal").optInt("cycleIndex", 0) == record.earnCycleIndex }

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
    .filter { it.has("withdrawalIndex") }
    .map { it.getInt("withdrawalIndex") }
    .toSet()
}
