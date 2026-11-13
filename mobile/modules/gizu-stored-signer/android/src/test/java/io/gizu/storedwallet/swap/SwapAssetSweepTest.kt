package io.gizu.storedwallet.swap

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SwapAssetSweepTest {
  private val held = "0x" + "aa".repeat(20)
  private val empty = "0x" + "bb".repeat(20)
  private val broken = "0x" + "cc".repeat(20)
  private val holders = listOf("0x" + "01".repeat(20), "0x" + "02".repeat(20))

  private fun words(vararg values: String) = values.joinToString("") { it.padStart(64, '0') }

  /** Answers balanceOf per (token, holder) from [balances]; a missing token reverts. */
  private fun multicall(balances: Map<String, Map<String, Long>>, seen: MutableList<String>) =
    SwapMulticall(SwapChains.ROBINHOOD) { body ->
      val requests = JSONArray(body)
      val responses = JSONArray()
      for (i in 0 until requests.length()) {
        val request = requests.getJSONObject(i)
        val result =
          when (request.getString("method")) {
            "eth_chainId" -> "0x1237"
            "eth_blockNumber" -> "0x10"
            else -> {
              val data = request.getJSONArray("params").getJSONObject(0).getString("data").substring(10)
              val count = SwapHoldings.quantity("0x" + data.substring(128, 192)).toInt()
              val tuples =
                (0 until count).map { index ->
                  val start = 128 + 64 + 64 * count + index * 64 * 5
                  val token = "0x" + data.substring(start + 24, start + 64)
                  val holder = "0x" + data.substring(start + 192 + 8 + 24, start + 192 + 8 + 64)
                  seen.add(token)
                  val balance = balances[token]?.get(holder)
                  if (balance == null) words("0", "40", "0")
                  else words("1", "40", "20", balance.toString(16))
                }
              var offset = 32 * count
              val offsets =
                tuples.joinToString("") { tuple -> words(offset.toString(16)).also { offset += tuple.length / 2 } }
              "0x" + words("20", count.toString(16)) + offsets + tuples.joinToString("")
            }
          }
        responses.put(JSONObject().put("id", request.getInt("id")).put("result", result))
      }
      200 to responses.toString()
    }

  @Test
  fun reportsOnlyTokensSomeRecipientHolds() = runBlocking {
    val seen = mutableListOf<String>()
    val sweep =
      SwapAssetSweep(
        SwapChains.ROBINHOOD,
        multicall(
          mapOf(
            held to mapOf(holders[0] to 0L, holders[1] to 5L),
            empty to mapOf(holders[0] to 0L, holders[1] to 0L),
          ),
          seen,
        ),
      )
    assertEquals(listOf(held), sweep.held(listOf(held, empty, broken, held.uppercase().replace("0X", "0x")), holders))
    assertEquals(setOf(held, empty, broken), seen.toSet())
  }

  @Test
  fun nothingToCheckMakesNoRequests() = runBlocking {
    val sweep = SwapAssetSweep(SwapChains.ROBINHOOD, SwapMulticall(SwapChains.ROBINHOOD) { error("no request") })
    assertTrue(sweep.held(emptyList(), holders).isEmpty())
    assertTrue(sweep.held(listOf(held), emptyList()).isEmpty())
  }

  @Test
  fun malformedOrOversizedInputIsRejected() {
    val sweep = SwapAssetSweep(SwapChains.ROBINHOOD, SwapMulticall(SwapChains.ROBINHOOD) { error("no request") })
    assertThrows(IllegalArgumentException::class.java) { runBlocking { sweep.held(listOf("0x12"), holders) } }
    val many = (0..SwapAssetSweep.MAX_TOKENS).map { "0x" + it.toString(16).padStart(40, '0') }
    assertThrows(IllegalArgumentException::class.java) { runBlocking { sweep.held(many, holders) } }
  }

  @Test
  fun onlyAPositiveStandardBalanceCounts() {
    assertTrue(SwapAssetSweep.positive("0x" + "1".padStart(64, '0')))
    assertFalse(SwapAssetSweep.positive("0x" + "0".repeat(64)))
    assertFalse(SwapAssetSweep.positive("0x"))
    assertFalse(SwapAssetSweep.positive("0x01"))
  }
}
