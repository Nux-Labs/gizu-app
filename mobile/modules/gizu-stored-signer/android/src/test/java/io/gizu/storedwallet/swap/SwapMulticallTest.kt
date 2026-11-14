package io.gizu.storedwallet.swap

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** ABI vectors were produced with viem's `encodeFunctionData`/`encodeFunctionResult`. */
class SwapMulticallTest {
  private val intc = "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681"
  private val spcx = "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea"
  private val holder = "0x" + "11".repeat(20)

  private fun words(vararg values: String) = values.joinToString("") { it.padStart(64, '0') }

  @Test
  fun tryAggregateCalldataMatchesViem() {
    val expected =
      "0xbce38bd7" +
        words("0", "40", "2", "40", "e0") +
        words(intc.removePrefix("0x"), "40", "24") +
        "70a08231" +
        "00".repeat(12) +
        "11".repeat(20) +
        "00".repeat(28) +
        words(spcx.removePrefix("0x"), "40", "4") +
        "95d89b41" +
        "00".repeat(28)
    assertEquals(
      expected,
      SwapMulticall.encodeTryAggregate(
        listOf(SwapMulticall.balanceOf(intc, holder), SwapCall(spcx, SwapMulticall.SYMBOL))
      ),
    )
  }

  @Test
  fun tryAggregateResultDecodesSuccessAndFailureLikeViem() {
    val encoded =
      "0x" + words("20", "2", "40", "c0") + words("1", "40", "20", "2a") + words("0", "40", "0")
    assertEquals(
      listOf(SwapCallResult(true, "0x" + "2a".padStart(64, '0')), SwapCallResult(false, "0x")),
      SwapMulticall.decodeTryAggregate(encoded),
    )
  }

  @Test
  fun liveRobinhoodResponseDecodesSymbolDecimalsAndBalance() {
    // Captured from Multicall3 on Robinhood Chain for INTC: symbol(), decimals(), balanceOf(0x…).
    val live =
      "0x" +
        words("20", "3", "60", "120", "1a0") +
        words("1", "40", "60", "20", "4") +
        "494e5443".padEnd(64, '0') +
        words("1", "40", "20", "12") +
        words("1", "40", "20", "0")
    val decoded = SwapMulticall.decodeTryAggregate(live)
    assertEquals(3, decoded.size)
    assertTrue(decoded.all { it.success })
    assertEquals("INTC", SwapHoldings.decodeSymbol(decoded[0].data))
    assertEquals(18, SwapHoldings.quantity(decoded[1].data).toInt())
    assertFalse(SwapAssetSweep.positive(decoded[2].data))
  }

  @Test
  fun malformedResultsAreRejected() {
    assertThrows(IllegalArgumentException::class.java) {
      SwapMulticall.decodeTryAggregate("0x" + words("20", "1", "20", "1", "40", "ff"))
    }
    assertThrows(IllegalArgumentException::class.java) { SwapMulticall.decodeTryAggregate("0x12") }
  }

  @Test
  fun callsAreChunkedPinnedToOneBlockAndCheckedAgainstTheChain() = runBlocking {
    val bodies = mutableListOf<JSONArray>()
    val multicall =
      SwapMulticall(SwapChains.ROBINHOOD) { body ->
        val requests = JSONArray(body)
        bodies.add(requests)
        val responses = JSONArray()
        for (i in 0 until requests.length()) {
          val request = requests.getJSONObject(i)
          val result =
            when (request.getString("method")) {
              "eth_chainId" -> "0x1237"
              "eth_blockNumber" -> "0x99"
              else -> {
                val data = request.getJSONArray("params").getJSONObject(0).getString("data")
                val count = SwapHoldings.quantity("0x" + data.substring(10 + 128, 10 + 192)).toInt()
                "0x" +
                  words("20", count.toString(16)) +
                  (0 until count).joinToString("") { words((32 * count + 128 * it).toString(16)) } +
                  (0 until count).joinToString("") { words("1", "40", "20", "1") }
              }
            }
          responses.put(
            JSONObject().put("jsonrpc", "2.0").put("id", request.getInt("id")).put("result", result)
          )
        }
        200 to responses.toString()
      }
    val block = multicall.head()
    assertEquals("0x99", block)
    val calls =
      (0 until SwapMulticall.CALLS_PER_MULTICALL * 3 + 7).map {
        SwapMulticall.balanceOf(intc, holder)
      }
    val results = multicall.call(calls, block)
    assertEquals(calls.size, results.size)
    assertTrue(results.all { it.success && SwapAssetSweep.positive(it.data) })
    val callRequests =
      bodies.drop(1).flatMap { batch -> (0 until batch.length()).map { batch.getJSONObject(it) } }
    assertEquals(4, callRequests.size)
    assertTrue(callRequests.all { it.getJSONArray("params").getString(1) == "0x99" })
    assertTrue(
      callRequests.all {
        it.getJSONArray("params").getJSONObject(0).getString("to") == SwapChains.MULTICALL3
      }
    )
  }

  @Test
  fun aWrongChainCannotAnswer() {
    val multicall =
      SwapMulticall(SwapChains.ROBINHOOD) {
        200 to
          JSONArray()
            .put(JSONObject().put("id", 0).put("result", "0x1"))
            .put(JSONObject().put("id", 1).put("result", "0x99"))
            .toString()
      }
    assertThrows(IllegalStateException::class.java) { runBlocking { multicall.head() } }
  }
}
