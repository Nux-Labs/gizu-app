package io.gizu.storedwallet.swap

import io.gizu.storedwallet.NativeRpcTransport
import java.math.BigInteger
import org.json.JSONArray
import org.json.JSONObject

/** A chain swap assets can live on: its RPC and the Multicall3 deployment used for batch reads. */
internal data class SwapChain(val chainId: Long, val rpc: String, val multicall: String)

/**
 * The chains the swap asset ledger reads and sweeps. Adding an EVM chain is one entry here plus a
 * backend catalogue: swap recipients derive the same address on every EVM chain.
 */
internal object SwapChains {
  /** Multicall3 has the same address on every chain it is deployed to. */
  const val MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11"
  val ROBINHOOD = SwapChain(4663, "https://rpc.mainnet.chain.robinhood.com", MULTICALL3)
  val all = listOf(ROBINHOOD)

  fun of(chainId: Long): SwapChain? = all.firstOrNull { it.chainId == chainId }
}

/** One read: `data` is called on `target` and the raw ABI result is kept as 0x hex. */
internal data class SwapCall(val target: String, val data: String)

internal data class SwapCallResult(val success: Boolean, val data: String)

/**
 * Batches ERC-20 reads through Multicall3 `tryAggregate(false, calls)`, so a balance check costs a
 * few `eth_call`s regardless of how many token × holder pairs it covers. Read-only.
 */
internal class SwapMulticall(
  private val chain: SwapChain,
  private val post: suspend (String) -> Pair<Int, String> = { body ->
    NativeRpcTransport(chain.rpc).execute("POST", chain.rpc, body)
  },
) {
  /** Head of the chain, checked against [SwapChain.chainId] so a wrong RPC cannot answer. */
  suspend fun head(): String {
    val results = request(listOf("eth_chainId" to JSONArray(), "eth_blockNumber" to JSONArray()))
    check(quantity(results[0]) == BigInteger.valueOf(chain.chainId))
    quantity(results[1])
    return results[1]
  }

  suspend fun call(calls: List<SwapCall>, block: String): List<SwapCallResult> {
    if (calls.isEmpty()) return emptyList()
    val chunks = calls.chunked(CALLS_PER_MULTICALL)
    val results = mutableListOf<SwapCallResult>()
    for (batch in chunks.chunked(MULTICALLS_PER_REQUEST)) {
      val responses =
        request(
          batch.map { chunk ->
            "eth_call" to
              JSONArray()
                .put(JSONObject().put("to", chain.multicall).put("data", encodeTryAggregate(chunk)))
                .put(block)
          }
        )
      batch.zip(responses).forEach { (chunk, response) ->
        val decoded = decodeTryAggregate(response)
        require(decoded.size == chunk.size)
        results.addAll(decoded)
      }
    }
    return results
  }

  private suspend fun request(calls: List<Pair<String, JSONArray>>): List<String> {
    val payload =
      JSONArray(
        calls.mapIndexed { index, (method, params) ->
          JSONObject()
            .put("jsonrpc", "2.0")
            .put("id", index)
            .put("method", method)
            .put("params", params)
        }
      )
    val (status, body) = post(payload.toString())
    check(status in 200..299) { "Token balances unavailable. Retry." }
    return SwapHoldings.results(body, calls.size)
  }

  companion object {
    /** About 40 KB of calldata and well under any RPC gas cap for ERC-20 view calls. */
    const val CALLS_PER_MULTICALL = 250
    const val MULTICALLS_PER_REQUEST = 8
    private const val TRY_AGGREGATE = "bce38bd7"
    const val BALANCE_OF = "0x70a08231"
    const val SYMBOL = "0x95d89b41"
    const val DECIMALS = "0x313ce567"
    private val ADDRESS = Regex("0x[0-9a-fA-F]{40}")
    private val HEX = Regex("0x([0-9a-fA-F]{2})*")

    fun balanceOf(token: String, holder: String): SwapCall {
      require(holder.matches(ADDRESS))
      return SwapCall(token, BALANCE_OF + holder.removePrefix("0x").lowercase().padStart(64, '0'))
    }

    internal fun quantity(value: String): BigInteger = SwapHoldings.quantity(value)

    private fun word(value: Long): String = java.lang.Long.toHexString(value).padStart(64, '0')

    /** `tryAggregate(bool requireSuccess = false, (address target, bytes callData)[] calls)`. */
    internal fun encodeTryAggregate(calls: List<SwapCall>): String {
      require(calls.isNotEmpty())
      val elements =
        calls.map { call ->
          require(call.target.matches(ADDRESS) && call.data.matches(HEX))
          val data = call.data.removePrefix("0x").lowercase()
          val padded = data.padEnd((data.length + 63) / 64 * 64, '0')
          call.target.removePrefix("0x").lowercase().padStart(64, '0') +
            word(64) +
            word((data.length / 2).toLong()) +
            padded
        }
      val out = StringBuilder("0x").append(TRY_AGGREGATE).append(word(0)).append(word(64))
      out.append(word(calls.size.toLong()))
      var offset = 32L * calls.size
      for (element in elements) {
        out.append(word(offset))
        offset += element.length / 2
      }
      elements.forEach(out::append)
      return out.toString()
    }

    /** Decodes `(bool success, bytes returnData)[]`, bounds-checking every offset. */
    internal fun decodeTryAggregate(hex: String): List<SwapCallResult> {
      require(hex.matches(HEX))
      val bytes = hex.removePrefix("0x")
      val size = bytes.length / 2
      fun at(position: Long): Long {
        require(position >= 0 && position + 32 <= size)
        val value =
          BigInteger(bytes.substring((position * 2).toInt(), ((position + 32) * 2).toInt()), 16)
        require(value.bitLength() < 32)
        return value.toLong()
      }
      val array = at(0)
      val count = at(array)
      require(count in 0..4096)
      val base = array + 32
      return (0 until count).map { i ->
        val tuple = base + at(base + 32 * i)
        val success = at(tuple)
        require(success == 0L || success == 1L)
        val data = tuple + at(tuple + 32)
        val length = at(data)
        require(data + 32 + length <= size)
        SwapCallResult(
          success == 1L,
          "0x" + bytes.substring(((data + 32) * 2).toInt(), ((data + 32 + length) * 2).toInt()),
        )
      }
    }
  }
}
