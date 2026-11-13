package io.gizu.storedwallet.swap

import android.content.Context
import io.gizu.storedwallet.AndroidWalletFile
import io.gizu.storedwallet.AndroidWalletKeys
import io.gizu.storedwallet.CryptoEnvelope
import io.gizu.storedwallet.WalletFile
import io.gizu.storedwallet.WalletRecord
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

/** One token a swap bought, or that a recovery sweep found, on one chain. Public data only. */
internal data class SwapLedgerAsset(
  val chainId: Long,
  val token: String,
  val source: String,
  val firstSeenAt: Long,
)

/**
 * The swap asset ledger: which tokens this wallet holds from swaps, per chain, plus public
 * summaries of finished swaps. Never contains keys or signed payloads.
 *
 * The file is a wallet recovery history domain (`gizu-holdings`), so the ledger follows the wallet
 * into the encrypted recovery catalogue and survives a restore under a new journal.
 */
internal class SwapPortfolioStore(
  private val walletId: String,
  private val file: WalletFile,
  private val key: () -> SecretKey,
  private val journalId: String,
  private val clock: () -> Long = System::currentTimeMillis,
) {
  constructor(
    context: Context,
    record: WalletRecord,
  ) : this(
    record.id,
    AndroidWalletFile(context, "gizu-holdings-${record.journalId}.enc", 1_048_576),
    { checkNotNull(AndroidWalletKeys().existing()) },
    record.journalId,
  )

  private val aad = "gizu-holdings:v1:$walletId:$journalId".toByteArray()

  private fun load(): JSONObject = stored().first

  /** The normalized ledger, and whether the file on disk still needs rewriting as v2. */
  private fun stored(): Pair<JSONObject, Boolean> {
    if (!file.exists()) return empty(walletId) to false
    val clear = CryptoEnvelope.decrypt(key(), file.read(), aad)
    return try {
      val root = JSONObject(String(clear, Charsets.UTF_8))
      normalize(root, walletId) to (root.getInt("version") != VERSION)
    } finally {
      clear.fill(0)
    }
  }

  private fun save(root: JSONObject) {
    val clear = root.toString().toByteArray()
    try {
      file.write(CryptoEnvelope.encrypt(key(), clear, aad))
    } finally {
      clear.fill(0)
    }
  }

  fun assets(): List<SwapLedgerAsset> = assets(load())

  /** Tracked token addresses on [chainId], in the order they were first seen. */
  fun targets(chainId: Long = ROBINHOOD): List<String> =
    assets().filter { it.chainId == chainId }.map { it.token }

  fun history(): List<Map<String, Any?>> {
    val history = load().getJSONObject("history")
    return history
      .keys()
      .asSequence()
      .map { id ->
        val item = history.getJSONObject(id)
        historyView(id, item)
      }
      .toList()
      .sortedByDescending { it["recordedAt"] as Long }
  }

  fun watch(target: String, chainId: Long = ROBINHOOD, source: String = SOURCE_SWAP) {
    val (root, legacy) = stored()
    val before = root.toString()
    add(root, chainId, target, source, clock())
    // Also persists a source upgrade, an earlier sighting, or the first v2 rewrite of a v1 file.
    if (legacy || root.toString() != before) save(root)
  }

  /** A chain is swept once, then again after [SWEEP_INTERVAL_MS]; a restore clears the marks. */
  fun sweepDue(chainId: Long): Boolean {
    val last = load().getJSONObject("swept").optLong(chainId.toString(), 0)
    val now = clock()
    return last <= 0 || now - last !in 0 until SWEEP_INTERVAL_MS
  }

  /** Adds tokens a sweep found with a balance and marks the chain swept. Returns new tokens. */
  fun recordSweep(chainId: Long, found: List<String>): List<String> {
    val root = load()
    val now = clock()
    val added = found.filter { add(root, chainId, it, SOURCE_DISCOVERED, now) }
    root.getJSONObject("swept").put(chainId.toString(), now)
    save(root)
    return added
  }

  fun remember(state: String, status: String) {
    val plan = JSONObject(state).getJSONObject("plan")
    watch(plan.getString("target"))
    val view = JSONObject(status)
    if (view.getString("phase") !in listOf("COMPLETE", "CANCELLED")) return
    val root = load()
    // Public summaries survive later starts/cancellations; never archive secret-bearing state.
    view.put("target", plan.getString("target"))
    view.put("recipientIndices", plan.getJSONArray("recipientIndices"))
    view.put("recordedAt", clock())
    archive(root.getJSONObject("history"), view)
    save(root)
  }

  companion object {
    const val ROBINHOOD = 4663L
    const val SOURCE_SWAP = "swap"
    const val SOURCE_DISCOVERED = "discovered"
    /** Per chain; the owned portfolio reads every tracked token, so the ledger stays bounded. */
    const val CHAIN_LIMIT = 256
    const val SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000L
    private const val VERSION = 2
    private val ADDRESS = Regex("0x[0-9a-f]{40}")
    private val SOURCES = setOf(SOURCE_SWAP, SOURCE_DISCOVERED)

    internal fun empty(walletId: String): JSONObject =
      JSONObject()
        .put("version", VERSION)
        .put("walletId", walletId)
        .put("assets", JSONArray())
        .put("history", JSONObject())
        .put("swept", JSONObject())

    /**
     * Validates a ledger and upgrades version 1, which tracked bare Robinhood addresses and had no
     * wallet binding. The encryption AAD already binds the wallet; v2 also records it inside.
     */
    internal fun normalize(root: JSONObject, walletId: String): JSONObject {
      val result = empty(walletId)
      when (root.getInt("version")) {
        1 -> {
          val tokens = root.getJSONArray("tokens")
          for (i in 0 until tokens.length()) add(result, ROBINHOOD, tokens.getString(i), SOURCE_SWAP, 0)
        }
        VERSION -> {
          check(root.getString("walletId") == walletId)
          val assets = root.getJSONArray("assets")
          for (i in 0 until assets.length()) {
            val item = assets.getJSONObject(i)
            val source = item.getString("source")
            require(source in SOURCES)
            add(result, item.getLong("chainId"), item.getString("token"), source, item.getLong("firstSeenAt"))
          }
          val swept = root.optJSONObject("swept") ?: JSONObject()
          for (chain in swept.keys()) {
            require(chain.toLongOrNull()?.let { it > 0 } == true)
            result.getJSONObject("swept").put(chain, swept.getLong(chain))
          }
        }
        else -> error("Unsupported swap ledger version")
      }
      val history = root.optJSONObject("history") ?: JSONObject()
      for (id in history.keys()) result.getJSONObject("history").put(id, history.getJSONObject(id))
      return result
    }

    /**
     * A restored ledger keeps every asset either side knew and every finished swap summary. Sweep
     * marks are dropped so the restored wallet checks its chains again.
     */
    internal fun recovered(root: JSONObject, walletId: String): JSONObject =
      normalize(root, walletId).put("swept", JSONObject())

    internal fun mergeRecovered(a: JSONObject, b: JSONObject, walletId: String): JSONObject {
      val result = recovered(a, walletId)
      val other = recovered(b, walletId)
      for (asset in assets(other)) add(result, asset.chainId, asset.token, asset.source, asset.firstSeenAt)
      val history = result.getJSONObject("history")
      val incoming = other.getJSONObject("history")
      for (id in incoming.keys()) archive(history, incoming.getJSONObject(id))
      return result
    }

    internal fun assets(root: JSONObject): List<SwapLedgerAsset> {
      val assets = root.getJSONArray("assets")
      return (0 until assets.length()).map {
        val item = assets.getJSONObject(it)
        SwapLedgerAsset(
          item.getLong("chainId"),
          item.getString("token"),
          item.getString("source"),
          item.getLong("firstSeenAt"),
        )
      }
    }

    /**
     * Adds a token once per chain. An existing entry keeps its earliest sighting, and a token a
     * swap bought stays a swap asset even when a sweep also finds it.
     */
    internal fun add(
      root: JSONObject,
      chainId: Long,
      token: String,
      source: String,
      firstSeenAt: Long,
    ): Boolean {
      require(chainId > 0 && source in SOURCES && firstSeenAt >= 0)
      require(token.matches(Regex("0x[0-9a-fA-F]{40}")))
      val normalized = token.lowercase()
      check(normalized.matches(ADDRESS))
      val assets = root.getJSONArray("assets")
      for (i in 0 until assets.length()) {
        val item = assets.getJSONObject(i)
        if (item.getLong("chainId") != chainId || item.getString("token") != normalized) continue
        if (source == SOURCE_SWAP) item.put("source", SOURCE_SWAP)
        if (firstSeenAt > 0 && (item.getLong("firstSeenAt") == 0L || firstSeenAt < item.getLong("firstSeenAt")))
          item.put("firstSeenAt", firstSeenAt)
        return false
      }
      if ((0 until assets.length()).count { assets.getJSONObject(it).getLong("chainId") == chainId } >= CHAIN_LIMIT)
        return false
      assets.put(
        JSONObject()
          .put("chainId", chainId)
          .put("token", normalized)
          .put("source", source)
          .put("firstSeenAt", firstSeenAt)
      )
      return true
    }

    internal fun historyView(id: String, item: JSONObject): Map<String, Any?> {
      val privateSale =
        item.optString("direction") == "sell" &&
          item.optString("completionTarget") == "confidential"
      return mapOf(
        "operationId" to id,
        "phase" to item.getString("phase"),
        "direction" to item.getString("direction"),
        "symbol" to item.optString("targetSymbol"),
        "completionTarget" to item.optString("completionTarget", "public"),
        "privateCreditedAtoms" to item.optString("privateCreditedAtoms", "0"),
        "receivedAtoms" to
          if (privateSale) item.getString("privateCreditedAtoms")
          else item.optString("receivedTargetAtoms", "0"),
        "soldAtoms" to item.optString("soldAtoms", "0"),
        "receivedUsdgAtoms" to item.optString("receivedUsdgAtoms", "0"),
        "recordedAt" to item.getLong("recordedAt"),
      )
    }

    internal fun archive(history: JSONObject, view: JSONObject) {
      val id = view.getString("operationId")
      // A later cancellation cannot rewrite evidence that an operation completed.
      if (history.optJSONObject(id)?.optString("phase") != "COMPLETE") history.put(id, view)
    }
  }
}
