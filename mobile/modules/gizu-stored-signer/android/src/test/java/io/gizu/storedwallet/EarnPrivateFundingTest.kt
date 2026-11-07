package io.gizu.storedwallet

import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnPrivateFundingTest {
  @Test
  fun tinyPublicRemainderPaysRealOverheadWithoutChangingTotalBudget() {
    val initial = PrivateDepositSelection(listOf(source(1).put("amountAtoms", "4999999")), "1")
    val adjusted = rebalancePrivateDepositSources(initial, "22000")
    assertEquals("22000", adjusted.publicBudget)
    assertEquals("4978000", adjusted.sources.single().getString("amountAtoms"))
    val dust =
      rebalancePrivateDepositSources(
        PrivateDepositSelection(listOf(source(1).put("amountAtoms", "15000")), "10000"),
        "22000",
      )
    assertTrue(dust.sources.isEmpty())
    assertEquals("25000", dust.publicBudget)
  }

  private fun source(cycle: Int) =
    JSONObject()
      .put("kind", "earn")
      .put("profileChainId", 4663)
      .put("cycleIndex", cycle)
      .put("address", "0x" + cycle.toString().padStart(40, '0'))

  @Test
  fun privateFirstUsesExactBudgetAndPublicRemainder() = runBlocking {
    val amounts = mapOf(1 to "3000000", 2 to "4000000")
    val selected =
      selectPrivateDepositSources("9000000", listOf(source(1), source(2))) {
        amounts.getValue(it.getInt("cycleIndex"))
      }
    assertEquals("2000000", selected.publicBudget)
    assertEquals(listOf("3000000", "4000000"), selected.sources.map { it.getString("amountAtoms") })
    val onlyPrivate =
      selectPrivateDepositSources("5000000", listOf(source(1), source(2))) {
        amounts.getValue(it.getInt("cycleIndex"))
      }
    assertEquals("0", onlyPrivate.publicBudget)
    assertEquals("2000000", onlyPrivate.sources.last().getString("amountAtoms"))
  }

  @Test
  fun failedReadNeverTurnsIntoZeroOrPublicFallback() {
    assertThrows(IllegalStateException::class.java) {
      runBlocking {
        selectPrivateDepositSources("1000000", listOf(source(1))) { error("unavailable") }
      }
    }
  }

  @Test
  fun privateDustCannotBlockPublicFundingOrCreateZeroDistributionLegs() = runBlocking {
    val selected =
      selectPrivateDepositSources("1000000", listOf(source(1), source(2))) {
        if (it.getInt("cycleIndex") == 1) "1" else "9999"
      }
    assertTrue(selected.sources.isEmpty())
    assertEquals("1000000", selected.publicBudget)
  }

  @Test
  fun duplicatePrivateIdentityCannotIncreaseAvailableFunds() {
    assertThrows(IllegalStateException::class.java) {
      runBlocking {
        selectPrivateDepositSources("3000000", listOf(source(1), source(1))) { "1000000" }
      }
    }
  }
}
