package io.gizu.storedwallet

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnDistributionTest {
  private fun plan(vararg weights: Int) =
    JSONObject().put("version", 1).put("weightsBps", JSONArray(weights.toList()))

  @Test
  fun cumulativeAllocationsConserveCreditAcrossEverySource() {
    val distribution = plan(1723, 2441, 5836)
    var offset = 0L
    val cumulative = MutableList(3) { java.math.BigInteger.ZERO }
    for (credit in listOf(10001L, 31L, 9921L)) {
      val amounts =
        (0..2).map {
          nativePayoutAmount("$credit", "$offset", "invest:$it", distribution).toBigInteger()
        }
      assertEquals(credit.toBigInteger(), amounts.reduce(java.math.BigInteger::add))
      amounts.forEachIndexed { i, amount -> cumulative[i] += amount }
      offset += credit
    }
    assertEquals(
      (0..2).map { nativePayoutAmount("$offset", "0", "invest:$it", distribution).toBigInteger() },
      cumulative,
    )
    assertEquals("10", nativePayoutAmount("101", "0", "hold"))
    assertEquals("91", nativePayoutAmount("101", "0", "invest"))
  }

  @Test
  fun malformedWeightsAndSlotsAreRejected() {
    for (distribution in
      listOf(
        plan(9999),
        plan(0, 10000),
        plan(5000, 5001),
        plan(1, 1, 1, 1, 1, 9995),
        plan(10000).put("version", 2),
      )) {
      assertThrows(Exception::class.java) {
        nativePayoutAmount("10000", "0", "invest:0", distribution)
      }
    }
    assertThrows(Exception::class.java) {
      nativePayoutAmount("10000", "0", "invest:1", plan(10000))
    }
    assertThrows(Exception::class.java) { nativePayoutAmount("10000", "0", "invest", plan(10000)) }
  }

  @Test
  fun selectedSlotHidesSiblingOperationsButKeepsSharedSourcesAndPayouts() {
    DepositFixtures.record().use { base ->
      WalletRecord(
          base.id,
          base.credential,
          base.entropy.copyOf(),
          true,
          base.journalId,
          base.roleRegistry,
          4663,
          false,
          1,
          JSONArray()
            .put(
              JSONObject()
                .put("cycleIndex", 1)
                .put("chainId", 4663)
                .put("distribution", plan(3000, 7000))
                .put("investmentSlot", 1)
            )
            .toString(),
        )
        .use { record ->
          fun operation(kind: String, slot: Int? = null) =
            JSONObject()
              .put(
                "proposal",
                JSONObject().put("kind", kind).put("cycleIndex", 1).also {
                  if (slot != null) it.put("investmentSlot", slot)
                },
              )
          val source = operation("sourceFunding")
          val payout = operation("confidentialPayout")
          val sibling = operation("vaultDeposit", 0)
          val selected = operation("vaultDeposit", 1)
          assertEquals(
            listOf(source, payout, selected),
            currentCycleRows(record, listOf(source, payout, sibling, selected)),
          )
          assertThrows(IllegalStateException::class.java) {
            attachInvestmentSlot(record, JSONObject().put("investmentSlot", 0))
          }
          assertEquals(1, attachInvestmentSlot(record, JSONObject()).getInt("investmentSlot"))
        }
    }
  }
}
