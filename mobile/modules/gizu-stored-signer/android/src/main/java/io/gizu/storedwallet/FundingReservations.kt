package io.gizu.storedwallet

import android.content.Context
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

internal data class FundingNetwork(val chainId: Int, val token: String, val rpc: String) {
  val originAsset: String
    get() =
      when (chainId) {
        143 -> "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx"
        8453 -> "nep141:base-$token.omft.near"
        42161 -> "nep141:arb-$token.omft.near"
        else -> error("Unsupported funding network")
      }
}

/** Exact public funding assets. Action destination chains have separate admission. */
internal fun fundingNetwork(chainId: Int): FundingNetwork =
  when (chainId) {
    143 ->
      FundingNetwork(143, "0x754704bc059f8c67012fed69bc8a327a5aafb603", "https://rpc.monad.xyz")
    8453 ->
      FundingNetwork(8453, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "https://mainnet.base.org")
    42161 ->
      FundingNetwork(
        42161,
        "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
        "https://arb1.arbitrum.io/rpc",
      )
    else -> error("Unsupported funding network")
  }

/** New networks spend Account 1 only; existing Monad return accounts stay eligible. */
internal fun fundingCandidate(index: Int, sourceChainId: Int = 143): Boolean =
  if (sourceChainId == 143) index != 0 else sourceChainId in setOf(8453, 42161) && index == 1

internal fun fundingSourceId(chainId: Int, owner: String): String =
  "${chainId}:${fundingNetwork(chainId).token}:${owner.lowercase()}"

internal fun fundingSourceId(row: JSONObject): String {
  val chainId = row.optInt("sourceChainId", 143)
  val network = fundingNetwork(chainId)
  check(row.optString("token", network.token).equals(network.token, true))
  check(row.optInt("decimals", 6) == 6)
  check(chainId == 143 || row.getInt("sourceIndex") == 1)
  return fundingSourceId(chainId, row.getString("address"))
}

/** Device-wide source budget locks shared by Swap and Earn. Unknown signatures never expire. */
internal class FundingReservations(
  private val file: WalletFile,
  private val key: () -> SecretKey,
  walletId: String,
  generation: String,
  private val now: () -> Long = System::currentTimeMillis,
) {
  constructor(
    context: Context,
    record: WalletRecord,
  ) : this(
    AndroidWalletFile(
      context,
      "gizu-funding-reservations-${record.journalId}.enc",
      4 * 1024 * 1024,
    ),
    { checkNotNull(AndroidWalletKeys().existing()) },
    record.id,
    record.journalId,
  )

  private val aad = "gizu-funding-reservations:v1:$walletId:$generation".toByteArray()

  companion object {
    private val globalLock = Any()
  }

  private fun read(): JSONArray {
    if (!file.exists()) return JSONArray()
    val clear = CryptoEnvelope.decrypt(key(), file.read(), aad)
    try {
      val root = JSONObject(String(clear, Charsets.UTF_8))
      check(root.getInt("version") in setOf(1, 2))
      return root.getJSONArray("batches")
    } finally {
      clear.fill(0)
    }
  }

  private fun write(rows: JSONArray) {
    val clear = JSONObject().put("version", 2).put("batches", rows).toString().toByteArray()
    check(clear.size < 3 * 1024 * 1024)
    try {
      file.write(CryptoEnvelope.encrypt(key(), clear, aad))
    } finally {
      clear.fill(0)
    }
  }

  private fun batches(rows: JSONArray) = (0 until rows.length()).map(rows::getJSONObject)

  private fun legs(batch: JSONObject) =
    batch.getJSONArray("legs").let { p -> (0 until p.length()).map(p::getJSONObject) }

  private fun operation(rows: JSONArray, id: String): Pair<JSONObject, JSONObject>? {
    val matches =
      batches(rows).flatMap { batch ->
        legs(batch).filter { it.optString("operationId") == id }.map { batch to it }
      }
    check(matches.size <= 1) {
      "Conflicting saved funding operation identity; reconcile before spending"
    }
    return matches.singleOrNull()
  }

  private fun active(batch: JSONObject, leg: JSONObject) =
    !leg.optBoolean("completed") &&
      !leg.optBoolean("cancelled") &&
      (leg.optBoolean("signed") || leg.has("operationId") || batch.getLong("expiresAt") > now())

  private fun reserved(rows: JSONArray, address: String, sourceChainId: Int) =
    batches(rows).fold(java.math.BigInteger.ZERO) { sum, batch ->
      sum +
        legs(batch)
          .filter {
            fundingSourceId(it) == fundingSourceId(sourceChainId, address) && active(batch, it)
          }
          .fold(java.math.BigInteger.ZERO) { a, l -> a + l.getString("budgetAtoms").toBigInteger() }
    }

  fun reservedAtoms(address: String, sourceChainId: Int = 143): String =
    synchronized(globalLock) { reserved(read(), address, sourceChainId).toString() }

  fun reserveBatch(id: String, feature: String, cycleIndex: Int, selected: JSONArray) =
    synchronized(globalLock) {
      require(
        feature in setOf("swap", "earn") &&
          id.matches(Regex("[-a-zA-Z0-9_]{1,128}")) &&
          selected.length() in 1..256
      )
      val rows = read()
      check(batches(rows).none { it.getString("id") == id })
      val seen = mutableSetOf<String>()
      for (i in 0 until selected.length()) {
        val l = selected.getJSONObject(i)
        val address = l.getString("address").lowercase()
        check(seen.add(fundingSourceId(l)))
        val spend = l.getString("budgetAtoms").toBigInteger()
        check(
          spend.signum() > 0 &&
            reserved(rows, address, l.optInt("sourceChainId", 143)) + spend <=
              l.getString("balanceAtoms").toBigInteger()
        ) {
          "These funds are already reserved by Swap or Earn"
        }
        l.put("signed", false).put("completed", false)
      }
      rows.put(
        JSONObject()
          .put("id", id)
          .put("feature", feature)
          .put("cycleIndex", cycleIndex)
          .put("expiresAt", now() + 120_000)
          .put("legs", selected)
      )
      write(rows)
    }

  fun bind(
    batchId: String,
    address: String,
    operationId: String,
    budgetAtoms: String,
    sourceChainId: Int = 143,
  ) =
    synchronized(globalLock) {
      val rows = read()
      val batch = batches(rows).single { it.getString("id") == batchId }
      val leg =
        legs(batch).single { fundingSourceId(it) == fundingSourceId(sourceChainId, address) }
      val existing = operation(rows, operationId)
      check(existing == null || existing.second === leg) {
        "Funding operation identity is already registered"
      }
      check(
        active(batch, leg) &&
          leg.getString("budgetAtoms") == budgetAtoms &&
          (!leg.has("operationId") || leg.getString("operationId") == operationId)
      ) {
        "Funding review expired or changed; review a fresh plan"
      }
      leg.put("operationId", operationId)
      write(rows)
    }

  /** Rebuild a sticky owner lock from a device-authenticated signed journal after interruption. */
  fun adoptSavedSource(
    id: String,
    address: String,
    index: Int,
    budget: String,
    cycle: Int,
    feature: String = "earn",
    sourceChainId: Int = 143,
  ) =
    synchronized(globalLock) {
      val rows = read()
      val existing = operation(rows, id)
      val found = existing?.second
      if (found != null) {
        check(
          checkNotNull(existing).first.getString("feature") == feature &&
            (feature == "swap" || existing.first.getInt("cycleIndex") == cycle) &&
            found.getString("budgetAtoms") == budget &&
            found.getString("address").equals(address, true) &&
            fundingSourceId(found) == fundingSourceId(sourceChainId, address) &&
            found.getInt("sourceIndex") == index
        )
        found.put("signed", true)
      } else
        rows.put(
          JSONObject()
            .put("id", "recovery_$id")
            .put("feature", feature)
            .put("cycleIndex", cycle)
            .put("expiresAt", 0)
            .put("registrationComplete", true)
            .put(
              "legs",
              JSONArray()
                .put(
                  JSONObject()
                    .put("sourceIndex", index)
                    .put("sourceChainId", sourceChainId)
                    .put("token", fundingNetwork(sourceChainId).token)
                    .put("address", address)
                    .put("budgetAtoms", budget)
                    .put("balanceAtoms", budget)
                    .put("signed", true)
                    .put("completed", false)
                    .put("operationId", id)
                ),
            )
        )
      write(rows)
    }

  fun hasUnsettledSigned(address: String, sourceChainId: Int = 143): Boolean =
    synchronized(globalLock) {
      batches(read()).any { b ->
        legs(b).any { l ->
          fundingSourceId(l) == fundingSourceId(sourceChainId, address) &&
            l.optBoolean("signed") &&
            !l.optBoolean("completed") &&
            !l.optBoolean("cancelled")
        }
      }
    }

  fun reserveOperation(
    id: String,
    feature: String,
    cycleIndex: Int,
    address: String,
    index: Int,
    budget: String,
    balance: String,
    sourceChainId: Int = 143,
  ) {
    val selected =
      JSONArray()
        .put(
          JSONObject()
            .put("address", address)
            .put("sourceIndex", index)
            .put("sourceChainId", sourceChainId)
            .put("token", fundingNetwork(sourceChainId).token)
            .put("budgetAtoms", budget)
            .put("balanceAtoms", balance)
        )
    reserveBatch("operation_$id", feature, cycleIndex, selected)
    bind("operation_$id", address, id, budget, sourceChainId)
  }

  fun commitBatch(id: String) =
    synchronized(globalLock) {
      val rows = read()
      val b = batches(rows).single { it.getString("id") == id }
      val selected = legs(b)
      check(
        selected.all { it.has("operationId") && active(b, it) } &&
          selected.map { it.getString("operationId") }.distinct().size == selected.size
      )
      b.put("registrationComplete", true)
      write(rows)
    }

  fun assertActive(operationId: String) =
    synchronized(globalLock) {
      val rows = read()
      val pair = operation(rows, operationId)
      if (pair != null) {
        check(
          pair.first.getString("feature") != "earn" ||
            legs(pair.first).size == 1 ||
            pair.first.optBoolean("registrationComplete")
        ) {
          "Complete registration of every selected funding source before authorizing"
        }
        check(active(pair.first, pair.second)) { "Funding reservation is no longer active" }
        check(
          batches(rows).flatMap(::legs).none {
            it.optString("operationId") != operationId &&
              fundingSourceId(it) == fundingSourceId(pair.second) &&
              it.optBoolean("signed") &&
              !it.optBoolean("completed")
          }
        ) {
          "Another saved source signature requires reconciliation"
        }
      }
    }

  fun assertCancellationAllowed(operationId: String) =
    synchronized(globalLock) {
      val rows = read()
      val pair = operation(rows, operationId) ?: return@synchronized
      val batch = pair.first
      val selected = pair.second
      check(!selected.optBoolean("signed")) { "Saved source authority must be reconciled" }
      check(batch.getString("feature") != "earn" || legs(batch).none { it.optBoolean("signed") }) {
        "This Earn batch has started; resume the remaining source instead of discarding it"
      }
    }

  fun releaseUnsigned(operationId: String) = cancelUnsigned(operationId)

  fun markSigned(operationId: String) =
    synchronized(globalLock) {
      val rows = read()
      val pair = operation(rows, operationId) ?: return@synchronized
      check(active(pair.first, pair.second))
      pair.second.put("signed", true)
      write(rows)
    }

  /** Caller must have independent canonical transaction/operation confirmation. */
  fun complete(operationId: String, beforeRelease: () -> Unit = {}) =
    synchronized(globalLock) {
      val rows = read()
      val leg = operation(rows, operationId)?.second ?: return@synchronized
      if (leg.optBoolean("completed")) return@synchronized
      beforeRelease()
      leg.put("completed", true)
      write(rows)
    }

  fun cancelUnsigned(operationId: String) =
    synchronized(globalLock) {
      assertCancellationAllowed(operationId)
      val rows = read()
      val found = operation(rows, operationId)?.second
      check(found == null || !found.optBoolean("signed"))
      found?.put("cancelled", true)
      write(rows)
    }

  fun cancelBatchUnsigned(batchId: String) =
    synchronized(globalLock) {
      val rows = read()
      val b = batches(rows).single { it.getString("id") == batchId }
      check(b.getString("feature") != "earn" || legs(b).none { it.optBoolean("signed") }) {
        "This Earn batch has started; resume its remaining sources"
      }
      legs(b).filterNot { it.optBoolean("signed") }.forEach { it.put("cancelled", true) }
      write(rows)
    }

  /** A version-2 parent can stop future sources without releasing any signed ownership. */
  fun cancelParentUnsigned(batchId: String, expectedOperationIds: Set<String>) =
    synchronized(globalLock) {
      val rows = read()
      val batch = batches(rows).single { it.getString("id") == batchId }
      val sources = legs(batch)
      check(batch.getString("feature") == "earn" && batch.getBoolean("registrationComplete"))
      check(
        expectedOperationIds.isNotEmpty() &&
          sources.size == expectedOperationIds.size &&
          sources.map { it.getString("operationId") }.toSet() == expectedOperationIds
      )
      sources.forEach { fundingSourceId(it) }
      sources.filterNot { it.optBoolean("signed") }.forEach { it.put("cancelled", true) }
      write(rows)
    }

  fun batch(batchId: String): JSONObject =
    synchronized(globalLock) {
      JSONObject(batches(read()).single { it.getString("id") == batchId }.toString())
    }
}
