package io.gizu.storedwallet.swap

import android.content.Context
import io.gizu.storedwallet.AndroidWalletFile
import io.gizu.storedwallet.AndroidWalletKeys
import io.gizu.storedwallet.CryptoEnvelope
import io.gizu.storedwallet.WalletRecord
import org.json.JSONArray
import org.json.JSONObject

/** Independent of the replaceable active journal. Never contains keys or signed payloads. */
internal class SwapPortfolioStore(context: Context, record: WalletRecord) {
  private val file = AndroidWalletFile(context, "gizu-holdings-${record.journalId}.enc", 1_048_576)
  private val aad = "gizu-holdings:v1:${record.id}:${record.journalId}".toByteArray()

  private fun key() = checkNotNull(AndroidWalletKeys().existing())

  private fun load(): JSONObject {
    if (!file.exists())
      return JSONObject().put("version", 1).put("tokens", JSONArray()).put("history", JSONObject())
    val clear = CryptoEnvelope.decrypt(key(), file.read(), aad)
    return try {
      JSONObject(String(clear, Charsets.UTF_8)).also { check(it.getInt("version") == 1) }
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

  fun targets(): List<String> {
    val tokens = load().getJSONArray("tokens")
    return (0 until tokens.length()).map { tokens.getString(it) }
  }

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

  fun watch(target: String) {
    require(target.matches(Regex("0x[0-9a-fA-F]{40}")))
    val normalized = target.lowercase()
    val root = load()
    val tokens = root.getJSONArray("tokens")
    if ((0 until tokens.length()).none { tokens.getString(it) == normalized }) {
      tokens.put(normalized)
      save(root)
    }
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
    view.put("recordedAt", System.currentTimeMillis())
    archive(root.getJSONObject("history"), view)
    save(root)
  }

  companion object {
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
