package io.gizu.storedwallet

import io.gizu.storedwallet.portfolio.*
import org.junit.Assert.*
import org.junit.Test

class FundingPortfolioTest {
  private val owner = "0x" + "a".repeat(40)

  private fun observation(
    chain: Int,
    amount: String?,
    stale: Boolean = false,
    reserved: String? = "0",
  ) =
    FundingObservation(
      chain,
      1,
      owner,
      amount,
      123,
      amount != null,
      stale,
      amount == null,
      reserved,
    )

  @Test
  fun sameOwnerOnThreeChainsCountsEachNativeUsdcOnce() {
    val value =
      fundingPortfolio(
        listOf(
          observation(143, "10000000"),
          observation(8453, "10000000"),
          observation(42161, "5000000"),
        )
      )
    val cash = value["fundingCash"] as? Map<*, *>
    assertEquals("25000000", cash?.get("observedAtoms"))
    assertEquals("25000000", cash?.get("availableAtoms"))
    assertEquals(true, cash?.get("complete"))
    val rows = value["fundingSources"] as List<*>
    assertEquals(3, rows.size)
    assertEquals(listOf(143, 8453, 42161), rows.map { (it as Map<*, *>)["sourceChainId"] })
  }

  @Test
  fun failedSourceRetainsObservedMoneyWithoutClaimingCompleteSpendableTotal() {
    val value =
      fundingPortfolio(
        listOf(
          observation(143, "10000000"),
          observation(8453, "10000000", stale = true),
          observation(42161, null),
        )
      )
    val cash = value["fundingCash"] as? Map<*, *>
    assertEquals("20000000", cash?.get("observedAtoms"))
    assertNull(cash?.get("availableAtoms"))
    assertEquals(false, cash?.get("complete"))
    val rows = value["fundingSources"] as List<*>
    assertNull((rows[2] as Map<*, *>)["balanceAtoms"])
    assertNull((rows[1] as Map<*, *>)["availableAtoms"])
  }

  @Test
  fun reservationsReduceOnlyTheirChainAndLegacyMonadOwnersRemainDistinct() {
    val second = observation(143, "3000000").copy(accountIndex = 3, owner = "0x" + "b".repeat(40))
    val value =
      fundingPortfolio(
        listOf(
          observation(143, "10000000"),
          observation(8453, "10000000", reserved = "4000000"),
          observation(42161, "0"),
          second,
        )
      )
    assertEquals("19000000", (value["fundingCash"] as? Map<*, *>)?.get("availableAtoms"))
  }

  @Test
  fun duplicateSourceCannotInflateAggregate() {
    try {
      fundingPortfolio(listOf(observation(143, "1"), observation(143, "1")))
      fail("duplicate accepted")
    } catch (_: IllegalArgumentException) {}
  }

  @Test
  fun unknownReservationsDoNotBecomeVerifiedZero() {
    val value =
      fundingPortfolio(
        listOf(
          observation(143, "10", reserved = null),
          observation(8453, "0"),
          observation(42161, "0"),
        )
      )
    assertNull((value["fundingCash"] as? Map<*, *>)?.get("availableAtoms"))
    assertEquals(false, (value["fundingCash"] as? Map<*, *>)?.get("complete"))
  }

  @Test
  fun ownedOverlapExcludesRecipientOfSameTokenAndOtherAssets() {
    val recipient = "0x" + "b".repeat(40)
    val balances = mapOf(owner to "10000000", recipient to "3000000")
    assertEquals(
      "10000000",
      fundingIncludedAtoms(
        8453,
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        balances,
        setOf(owner),
      ),
    )
    assertEquals("0", fundingIncludedAtoms(8453, "0x" + "c".repeat(40), balances, setOf(owner)))
    assertEquals(
      "0",
      fundingIncludedAtoms(1, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", balances, setOf(owner)),
    )
  }
}
