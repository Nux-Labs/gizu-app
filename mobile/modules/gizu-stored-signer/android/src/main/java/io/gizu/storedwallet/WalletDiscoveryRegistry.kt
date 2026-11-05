package io.gizu.storedwallet

import android.content.Context
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.walletDiscoveryCandidates

/** Read-only owner descriptors. There is deliberately no allocation weight or spend approval. */
internal class WalletDiscoveryRegistry(
  private val file: WalletFile,
  private val key: () -> SecretKey,
  private val record: WalletRecord,
  private val countFile: WalletFile? = null,
) {
  constructor(
    context: Context,
    record: WalletRecord,
  ) : this(
    AndroidWalletFile(context, "gizu-discovered-wallets-${record.journalId}.enc", 16 * 1024 * 1024),
    { checkNotNull(AndroidWalletKeys().existing()) },
    record,
    AndroidWalletFile(context, "gizu-discovery-count-${record.journalId}.enc", 8192),
  )

  companion object {
    private val lock = Any()
  }

  private val aad = "gizu-discovered-wallets:v1:${record.id}:${record.journalId}".toByteArray()

  private fun read(): JSONObject {
    if (!file.exists())
      return JSONObject().put("version", 1).put("owners", JSONArray()).put("progress", JSONObject())
    val clear = CryptoEnvelope.decrypt(key(), file.read(), aad)
    try {
      return JSONObject(String(clear, Charsets.UTF_8)).also { check(it.getInt("version") == 1) }
    } finally {
      clear.fill(0)
    }
  }

  private fun write(root: JSONObject) {
    val clear = root.toString().toByteArray()
    try {
      file.write(CryptoEnvelope.encrypt(key(), clear, aad))
      countFile?.write(
        CryptoEnvelope.encrypt(
          key(),
          root.getJSONArray("owners").length().toString().toByteArray(),
          aad + ":count".toByteArray(),
        )
      )
    } finally {
      clear.fill(0)
    }
  }

  fun count(): Int {
    if (countFile == null || !countFile.exists()) return descriptors().size
    val clear = CryptoEnvelope.decrypt(key(), countFile.read(), aad + ":count".toByteArray())
    try {
      return String(clear, Charsets.UTF_8).toInt().also { require(it >= 0) }
    } finally {
      clear.fill(0)
    }
  }

  fun descriptors(): List<JSONObject> =
    synchronized(lock) {
      val values = read().getJSONArray("owners")
      (0 until values.length()).map(values::getJSONObject)
    }

  private fun identity(row: JSONObject) =
    "${row.getInt("chainId")}:${row.getInt("cycleIndex")}:${row.getString("derivation")}:${row.getString("role")}:${row.optInt("slot", -1)}"

  fun merge(root: JSONObject) =
    synchronized(lock) {
      check(root.getInt("version") == 1)
      val current = read()
      val merged = linkedMapOf<String, JSONObject>()
      for (source in listOf(current.getJSONArray("owners"), root.getJSONArray("owners"))) for (i in
        0 until source.length()) {
        val row = source.getJSONObject(i)
        require(row.getInt("chainId") in setOf(1, 4663) && row.getInt("cycleIndex") in 0..1_000_000)
        require(
          row.getString("derivation") in setOf("legacy", "distribution-v1") &&
            row.getString("role") in setOf("hold", "invest", "confidential")
        )
        if (row.getString("derivation") == "distribution-v1")
          require(row.getString("role") == "invest" && row.getInt("slot") in 0..4)
        // Persist only descriptors, never caller-provided addresses or authority.
        val descriptor =
          JSONObject()
            .put("chainId", row.getInt("chainId"))
            .put("cycleIndex", row.getInt("cycleIndex"))
            .put("derivation", row.getString("derivation"))
            .put("role", row.getString("role"))
        if (row.has("slot")) descriptor.put("slot", row.getInt("slot"))
        merged[identity(descriptor)] = descriptor
      }
      current.put("owners", JSONArray(merged.values.toList()))
      write(current)
    }

  fun progress(chain: Int, cycle: Int): Pair<Int, Int> =
    synchronized(lock) {
      val saved = read().getJSONObject("progress").optJSONObject(chain.toString())
      if (saved?.optInt("cycle", -1) != cycle) 0 to 0
      else saved.getInt("next") to saved.getInt("count")
    }

  fun observed(
    chain: Int,
    cycle: Int,
    next: Int,
    count: Int,
    candidate: JSONObject?,
    found: Boolean,
  ) =
    synchronized(lock) {
      val root = read()
      if (found) {
        val row = checkNotNull(candidate)
        val descriptor =
          JSONObject()
            .put("chainId", chain)
            .put("cycleIndex", cycle)
            .put("derivation", row.getString("derivation"))
            .put("role", row.getString("role"))
        if (row.has("slot")) descriptor.put("slot", row.getInt("slot"))
        val owners = root.getJSONArray("owners")
        if (
          (0 until owners.length()).none {
            identity(owners.getJSONObject(it)) == identity(descriptor)
          }
        )
          owners.put(descriptor)
      }
      root
        .getJSONObject("progress")
        .put(
          chain.toString(),
          JSONObject().put("cycle", cycle).put("next", next).put("count", count),
        )
      write(root)
    }

  fun owners(chain: Int, confidential: Boolean): List<Pair<JSONObject, String>> =
    descriptors()
      .filter {
        it.getInt("chainId") == chain && (it.getString("role") == "confidential") == confidential
      }
      .groupBy { it.getInt("cycleIndex") }
      .flatMap { (cycle, rows) ->
        val candidates =
          JSONArray(walletDiscoveryCandidates(record.entropy, chain.toULong(), cycle.toUInt()))
        rows.map { descriptor ->
          val found =
            (0 until candidates.length()).map(candidates::getJSONObject).single {
              it.getString("derivation") == descriptor.getString("derivation") &&
                it.getString("role") == descriptor.getString("role") &&
                it.optInt("slot", -1) == descriptor.optInt("slot", -1)
            }
          descriptor to found.getString("address").lowercase()
        }
      }
}

/** Balance observations are owned only when the actual saved derivation metadata matches. */
internal fun discoveredOwnerTracked(record: WalletRecord, descriptor: JSONObject): Boolean {
  val row =
    JSONArray(record.earnCycles).objects().singleOrNull {
      it.getInt("chainId") == descriptor.getInt("chainId") &&
        it.getInt("cycleIndex") == descriptor.getInt("cycleIndex")
    } ?: return false
  return when (descriptor.getString("derivation")) {
    "legacy" -> descriptor.getString("role") == "confidential" || !row.has("distribution")
    "distribution-v1" -> {
      val plan = row.optJSONObject("distribution") ?: return false
      descriptor.getString("role") == "invest" &&
        descriptor.getInt("slot") in distributionWeights(plan).indices
    }
    else -> false
  }
}

internal fun discoveredMetadataResolved(
  record: WalletRecord,
  descriptors: List<JSONObject>,
): Boolean {
  if (record.discoveryRecoveryRequired && descriptors.isEmpty()) return false
  return descriptors.all { discoveredOwnerTracked(record, it) }
}
