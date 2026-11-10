package io.gizu.storedwallet.swap

import java.math.BigInteger
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import uniffi.gizu_stored_signer_core.buildSwapHolding
import uniffi.gizu_stored_signer_core.swapHoldingIndices

class SwapHoldingsTest {
  private val token = "0x" + "ab".repeat(20)

  @Test
  fun sharedHoldingsFixtureMatchesSwiftAndRust() {
    val fixture =
      JSONObject(
        javaClass.classLoader!!.getResourceAsStream("swap-holdings.json")!!.bufferedReader().use {
          it.readText()
        }
      )
    val indices = swapHoldingIndices(fixture.getString("registry"), listOf(6u))
    assertEquals(listOf(3u, 4u, 5u, 7u, 8u, 9u), indices)
    val amounts = fixture.getJSONArray("balances")
    val actual =
      JSONObject(
        buildSwapHolding(
          fixture.getString("token"),
          indices,
          (0 until amounts.length()).map { amounts.getString(it) },
          fixture.getString("symbolAbi"),
          fixture.getString("decimalsAbi"),
        )
      )
    val expected = fixture.getJSONObject("expected")
    for (key in listOf("token", "symbol", "balanceAtoms")) assertEquals(
      expected.getString(key),
      actual.getString(key),
    )
    for (key in listOf("chainId", "decimals")) assertEquals(
      expected.getInt(key),
      actual.getInt(key),
    )
    val expectedBatches = expected.getJSONArray("batches")
    val actualBatches = actual.getJSONArray("batches")
    assertEquals(expectedBatches.length(), actualBatches.length())
    for (i in 0 until expectedBatches.length()) {
      for (key in listOf("id", "balanceAtoms")) assertEquals(
        expectedBatches.getJSONObject(i).getString(key),
        actualBatches.getJSONObject(i).getString(key),
      )
    }
    assertEquals(
      fixture.getString("token") to listOf(7, 8, 9),
      SwapHoldings.selection(
        fixture.getString("token") + ":7",
        10,
        listOf(fixture.getString("token")),
        setOf(6),
      ),
    )
  }

  @Test
  fun allWalletSelectionIncludesPartialGroupsAndExcludesEarn() {
    assertEquals(
      token to listOf(3, 4, 5, 7, 8, 9, 10, 11),
      SwapHoldings.selection("$token:all", 12, listOf(token), setOf(6)),
    )
    assertThrows(Exception::class.java) { SwapHoldings.selection("$token:all", 12, emptyList()) }
  }

  @Test
  fun balancesMatchResponseIdsRatherThanProviderOrder() {
    assertEquals(
      listOf("0x5", "0xa"),
      SwapHoldings.results("""[{"id":1,"result":"0xa"},{"id":0,"result":"0x5"}]""", 2),
    )
  }

  @Test
  fun missingDuplicateAndFailedBalancesNeverBecomeZero() {
    for (body in
      listOf(
        "[]",
        """[{"id":0,"result":"0x0"},{"id":0,"result":"0x0"}]""",
        """[{"id":0,"error":{}}]""",
      )) {
      assertThrows(Exception::class.java) { SwapHoldings.results(body, 2) }
    }
    assertThrows(Exception::class.java) { SwapHoldings.quantity("0x") }
    assertEquals(BigInteger("18446744073709551616"), SwapHoldings.quantity("0x10000000000000000"))
  }

  @Test
  fun sellSelectionRequiresTrackedTokenAndAllocatedRecipientBatch() {
    assertEquals(token to listOf(6, 7, 8), SwapHoldings.selection("$token:6", 12, listOf(token)))
    for (index in listOf(-1, 0, 1, 2, 4, 12, Int.MAX_VALUE)) {
      assertThrows(Exception::class.java) {
        SwapHoldings.selection("$token:$index", 12, listOf(token))
      }
    }
    assertThrows(Exception::class.java) { SwapHoldings.selection("$token:3", 12, emptyList()) }
  }

  @Test
  fun subsequentCancellationDoesNotEraseCompletedPurchaseHistory() {
    val history = JSONObject()
    SwapPortfolioStore.archive(
      history,
      JSONObject().put("operationId", "buy").put("phase", "COMPLETE"),
    )
    SwapPortfolioStore.archive(
      history,
      JSONObject().put("operationId", "next").put("phase", "CANCELLED"),
    )
    SwapPortfolioStore.archive(
      history,
      JSONObject().put("operationId", "buy").put("phase", "CANCELLED"),
    )
    assertEquals("COMPLETE", history.getJSONObject("buy").getString("phase"))
    assertEquals("CANCELLED", history.getJSONObject("next").getString("phase"))
  }
}
