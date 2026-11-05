package io.gizu.storedwallet

import android.content.Context
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

internal fun earnQuoteJournal(context: Context, record: WalletRecord) =
  EarnQuoteJournal(
    AndroidWalletFile(context, "gizu-earn-quotes-${record.journalId}.enc", 4 * 1024 * 1024),
    { checkNotNull(AndroidWalletKeys().existing()) },
    record.id,
    record.journalId,
  )

/** Server recovery ciphertext remains private inside wallet-generation-bound encryption. */
internal class EarnQuoteJournal(
  private val file: WalletFile,
  private val key: () -> SecretKey,
  val walletId: String,
  val generation: String,
) {
  private val aad = "gizu-earn-quotes:v1:$walletId:$generation".toByteArray()

  private fun read(): JSONArray {
    if (!file.exists()) return JSONArray()
    val clear = CryptoEnvelope.decrypt(key(), file.read(), aad)
    try {
      return JSONArray(String(clear, Charsets.UTF_8)).also { check(it.length() <= 100_000) }
    } finally {
      clear.fill(0)
    }
  }

  fun get(operationId: String, revision: Int): JSONObject? =
    read().let { rows ->
      (0 until rows.length()).map(rows::getJSONObject).singleOrNull {
        it.getString("operationId") == operationId && it.getInt("revision") == revision
      }
    }

  fun save(quote: JSONObject) {
    val envelope = quote.getString("recoveryEnvelope")
    check(envelope.length in 1..180000)
    val rows = read()
    val old =
      (0 until rows.length()).map(rows::getJSONObject).singleOrNull {
        it.getString("operationId") == quote.getString("operationId") &&
          it.getInt("revision") == quote.getInt("revision")
      }
    if (old != null) {
      check(
        old.keys().asSequence().toSet() == quote.keys().asSequence().toSet() &&
          old.keys().asSequence().all { old.get(it).toString() == quote.get(it).toString() }
      ) {
        "Protected quote changed"
      }
      return
    }
    check(rows.length() < 100_000)
    rows.put(JSONObject(quote.toString()))
    val clear = rows.toString().toByteArray()
    try {
      check(clear.size <= 15 * 1024 * 1024)
      file.write(CryptoEnvelope.encrypt(key(), clear, aad))
    } finally {
      clear.fill(0)
    }
  }
}
