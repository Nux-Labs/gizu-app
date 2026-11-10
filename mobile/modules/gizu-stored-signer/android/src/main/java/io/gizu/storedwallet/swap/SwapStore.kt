package io.gizu.storedwallet.swap

import android.content.Context
import io.gizu.storedwallet.AndroidWalletFile
import io.gizu.storedwallet.AndroidWalletKeys
import io.gizu.storedwallet.CryptoEnvelope
import io.gizu.storedwallet.WalletRecord
import org.json.JSONObject

/** Encrypted swap machine state. Signed payloads stay in this file and never cross Expo. */
internal class SwapStore(val context: Context, record: WalletRecord) {
  val portfolio = SwapPortfolioStore(context, record)
  private val file =
    AndroidWalletFile(context, "gizu-swap-${record.journalId}.enc", SWAP_FILE_LIMIT)
  private val key = { checkNotNull(AndroidWalletKeys().existing()) }
  private val aad = "gizu-swap:v1:${record.id}:${record.journalId}".toByteArray()
  val walletId = record.id

  fun load(): JSONObject? {
    if (!file.exists()) return null
    val clear = CryptoEnvelope.decrypt(key(), file.read(), aad)
    try {
      val root = JSONObject(String(clear, Charsets.UTF_8))
      check(root.getInt("version") == 1 && root.getString("walletId") == walletId)
      check(root.getString("state").length <= SWAP_STATE_LIMIT)
      root.optJSONObject("fundingBatch")?.let { SwapFundingBatch.restore(it) }
      return root
    } finally {
      clear.fill(0)
    }
  }

  fun save(
    operationId: String,
    state: String,
    fundingAddress: String,
    fundingBatch: JSONObject? = null,
  ) {
    check(state.length <= SWAP_STATE_LIMIT && fundingAddress.startsWith("0x"))
    val history = SwapFundingBatch.archive(load(), operationId)
    val root =
      JSONObject()
        .put("version", 1)
        .put("walletId", walletId)
        .put("operationId", operationId)
        .put("fundingAddress", fundingAddress)
        .put("state", state)
        .put("history", history)
    if (fundingBatch != null) root.put("fundingBatch", fundingBatch)
    val clear = root.toString().toByteArray()
    check(clear.size <= SWAP_FILE_LIMIT)
    try {
      file.write(CryptoEnvelope.encrypt(key(), clear, aad))
    } finally {
      clear.fill(0)
    }
  }

  companion object {
    private const val SWAP_FILE_LIMIT = 268_435_456
    private const val SWAP_STATE_LIMIT = 67_108_864
  }
}
