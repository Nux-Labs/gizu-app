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
  fun twoFifteenUsesNoPrivatePieceBelowTheBridge() = runBlocking {
    val raised =
      selectPrivateDepositSources("2150000", listOf(source(1), source(2)), PAYOUT_QUOTE_FLOOR) {
        if (it.getInt("cycleIndex") == 1) "2000000" else "200000"
      }
    assertEquals("0", raised.publicBudget)
    assertEquals(2150000L, raised.sources.sumOf { it.getString("amountAtoms").toLong() })
    assertTrue(
      raised.sources.all { it.getString("amountAtoms").toLong() >= PAYOUT_QUOTE_FLOOR.toLong() }
    )
    val blocked =
      selectPrivateDepositSources("2150000", listOf(source(1), source(2)), PAYOUT_QUOTE_FLOOR) {
        if (it.getInt("cycleIndex") == 1) "2000000" else "150000"
      }
    assertEquals("2000000", blocked.sources.single().getString("amountAtoms"))
    assertEquals("150000", blocked.publicBudget)
  }

  @Test
  fun publicRemainderBelowTheBridgeMinimumIsRaisedFromPrivate() {
    val one = JSONObject().put("version", 1).put("weightsBps", org.json.JSONArray(listOf(10000)))
    assertEquals(PAYOUT_BRIDGE_MINIMUM, minimumRoutablePublicBudget(one))
    val split =
      JSONObject().put("version", 1).put("weightsBps", org.json.JSONArray(listOf(4300, 5700)))
    val required = minimumRoutablePublicBudget(split)
    assertTrue(required * 4300.toBigInteger() / 10000.toBigInteger() >= PAYOUT_BRIDGE_MINIMUM)
    val raised =
      rebalancePrivateDepositSources(
        PrivateDepositSelection(listOf(source(1).put("amountAtoms", "2186703")), "90294"),
        required.toString(),
      )
    assertEquals(required.toString(), raised.publicBudget)
    assertTrue(raised.sources.single().getString("amountAtoms").toBigInteger() >= required)
    assertThrows(DepositBelowRouteMinimum::class.java) {
      rebalancePrivateDepositSources(
        PrivateDepositSelection(emptyList(), "90294"),
        required.toString(),
      )
    }
  }

  @Test
  fun unrouteablePublicRemainderReportsTheExactPrivateAlternative() {
    val failure =
      assertThrows(DepositBelowRouteMinimum::class.java) {
        requireRoutablePublicRemainder(
          PrivateDepositSelection(listOf(source(1).put("amountAtoms", "1800000")), "142172"),
          JSONObject().put("version", 1).put("weightsBps", org.json.JSONArray(listOf(10000))),
        )
      }
    assertEquals(
      "You can deposit 1.8 USDC from routable private balances before fees. " +
        "The remaining 0.142172 USDC needs public funding, which requires at least 0.2 USDC. " +
        "Change the amount to 1.8 USDC and review the fees.",
      failure.message,
    )
  }

  @Test
  fun noRoutablePrivateSourceReportsMinimumInsteadOfSuggestingALowerAmount() {
    val failure =
      assertThrows(DepositBelowRouteMinimum::class.java) {
        requireRoutablePublicRemainder(
          PrivateDepositSelection(emptyList(), "142172"),
          JSONObject().put("version", 1).put("weightsBps", org.json.JSONArray(listOf(10000))),
        )
      }
    assertEquals(
      "No private balance can fund this deposit. Each private source needs at least 0.17 USDC " +
        "for this distribution. Public funding needs at least 0.2 USDC; this deposit has 0.142172 USDC " +
        "left to fund. Lowering the amount will not make these balances routable.",
      failure.message,
    )
    requireRoutablePublicRemainder(
      PrivateDepositSelection(emptyList(), "200000"),
      JSONObject().put("version", 1).put("weightsBps", org.json.JSONArray(listOf(10000))),
    )
    requireRoutablePublicRemainder(PrivateDepositSelection(emptyList(), "0"), null)
  }

  @Test
  fun remainderLimitsUseSavedWeightsAndPreserveSixDecimalPrecision() {
    val split =
      JSONObject().put("version", 1).put("weightsBps", org.json.JSONArray(listOf(4300, 5700)))
    val failure =
      assertThrows(DepositBelowRouteMinimum::class.java) {
        requireRoutablePublicRemainder(
          PrivateDepositSelection(listOf(source(1).put("amountAtoms", "1942171")), "1"),
          split,
        )
      }
    assertTrue(failure.message!!.contains("deposit 1.942171 USDC"))
    assertTrue(failure.message!!.contains("remaining 0.000001 USDC"))
    assertTrue(failure.message!!.contains("at least 0.465117 USDC"))
    requireRoutablePublicRemainder(PrivateDepositSelection(emptyList(), "465117"), split)
  }

  @Test
  fun legacyPublicFundingMinimumDoesNotMisrepresentPrivateSourceEligibility() {
    val failure =
      assertThrows(DepositBelowRouteMinimum::class.java) {
        requireRoutablePublicRemainder(PrivateDepositSelection(emptyList(), "1900000"), null)
      }
    assertEquals(
      "This saved deposit needs at least 2 USDC of public funding, but its public-funded amount " +
        "is 1.9 USDC. Lowering the amount will not fix this route minimum.",
      failure.message,
    )
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
