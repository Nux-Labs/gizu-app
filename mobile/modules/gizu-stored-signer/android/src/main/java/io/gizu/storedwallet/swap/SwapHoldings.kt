package io.gizu.storedwallet.swap

import io.gizu.storedwallet.WalletRecord
import io.gizu.storedwallet.earnWithdrawalIndices
import java.math.BigInteger
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.buildSwapHolding
import uniffi.gizu_stored_signer_core.decodeSwapSymbol
import uniffi.gizu_stored_signer_core.deriveAccountAddressRange
import uniffi.gizu_stored_signer_core.selectSwapHolding
import uniffi.gizu_stored_signer_core.swapHoldingIndices

/** Read-only balances at one block, across all locally allocated recipient accounts. */
internal class SwapHoldings(
  private val chain: SwapChain = SwapChains.ROBINHOOD,
  private val multicall: SwapMulticall = SwapMulticall(chain),
) {
  suspend fun read(record: WalletRecord, targets: List<String>): Map<String, Any?> {
    val indices = recipientIndices(record)
    val block = multicall.head()
    val addresses = recipientAddresses(record, indices)
    val tokens = targets.distinct()
    tokens.forEach { require(it.matches(Regex("0x[0-9a-f]{40}"))) }
    // Metadata and every token × recipient balance share one pinned block and a few eth_calls.
    val calls =
      tokens.flatMap { target ->
        listOf(SwapCall(target, SwapMulticall.SYMBOL), SwapCall(target, SwapMulticall.DECIMALS)) +
          addresses.map { SwapMulticall.balanceOf(target, it) }
      }
    val results = multicall.call(calls, block)
    // A tracked token that cannot answer fails the read rather than showing a guessed balance.
    check(results.all { it.success }) { "Token balances unavailable. Retry." }
    val perToken = 2 + addresses.size
    val holdings =
      tokens.mapIndexedNotNull { index, target ->
        val rows = results.subList(index * perToken, (index + 1) * perToken).map { it.data }
        val encoded =
          buildSwapHolding(target, indices.map { it.toUInt() }, rows.drop(2), rows[0], rows[1])
        if (encoded == "null") null
        else {
          val item = JSONObject(encoded)
          val batches = item.getJSONArray("batches")
          mapOf(
            "token" to item.getString("token"),
            "chainId" to item.getLong("chainId"),
            "symbol" to item.getString("symbol"),
            "decimals" to item.getInt("decimals"),
            "balanceAtoms" to item.getString("balanceAtoms"),
            "batches" to
              (0 until batches.length()).map { i ->
                val row = batches.getJSONObject(i)
                mapOf("id" to row.getString("id"), "balanceAtoms" to row.getString("balanceAtoms"))
              },
          )
        }
      }
    return mapOf(
      "holdings" to holdings,
      "checkedAt" to System.currentTimeMillis(),
      "block" to block,
    )
  }

  companion object {
    /** Swap recipients: allocated accounts from index 3, minus Earn withdrawal accounts. */
    internal fun recipientIndices(record: WalletRecord): List<Int> =
      swapHoldingIndices(record.roleRegistry, earnWithdrawalIndices(record).map { it.toUInt() })
        .map { it.toInt() }

    internal fun recipientAddresses(record: WalletRecord, indices: List<Int>): List<String> =
      indices.map { deriveAccountAddressRange(record.entropy, it.toUInt(), 1u).single() }

    internal fun results(body: String, count: Int): List<String> {
      val values = JSONArray(body)
      require(values.length() == count)
      val byId = mutableMapOf<Int, String>()
      for (index in 0 until values.length()) {
        val item = values.getJSONObject(index)
        val id = item.getInt("id")
        require(id in 0 until count && !byId.containsKey(id) && !item.has("error"))
        byId[id] = item.getString("result")
      }
      return (0 until count).map { checkNotNull(byId[it]) }
    }

    internal fun quantity(value: String): BigInteger {
      require(value.matches(Regex("0x[0-9a-fA-F]{1,64}")))
      return BigInteger(value.substring(2), 16)
    }

    internal fun decodeSymbol(value: String): String = decodeSwapSymbol(value)

    /** JS chooses an opaque batch ID; ownership and allocated range are checked natively. */
    internal fun selection(
      id: String,
      nextRecipient: Int,
      tracked: List<String>,
      excluded: Set<Int> = emptySet(),
    ): Pair<String, List<Int>> {
      val selected =
        selectSwapHolding(
          id,
          JSONObject().put("version", 1).put("nextRecipient", nextRecipient).toString(),
          excluded.map { it.toUInt() },
          tracked,
        )
      return selected.target to selected.indices.map { it.toInt() }
    }
  }
}
