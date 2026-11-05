package io.gizu.storedwallet.swap

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SwapSalePolicyTest {
  @Test
  fun newSalesUseExistingHoldersWithoutPublicAllocationOrReroll() {
    val plan = confidentialSalePlan("0x" + "a".repeat(40), JSONArray(listOf(3, 7, 11)))
    assertEquals("confidential", plan.getString("completionTarget"))
    assertEquals("[3,7,11]", plan.getJSONArray("holderIndices").toString())
    assertEquals(
      plan.getJSONArray("holderIndices").toString(),
      plan.getJSONArray("recipientIndices").toString(),
    )
    assertFalse(plan.has("legsRandom"))
    assertFalse(plan.has("weights"))
    assertEquals(
      plan.toString(),
      confidentialSalePlan("0x" + "a".repeat(40), JSONArray(listOf(3, 7, 11))).toString(),
    )
    for (bad in listOf(emptyList(), listOf(2), listOf(3, 3), listOf(3, 4, 5, 6, 7, 8))) {
      assertThrows(Exception::class.java) {
        confidentialSalePlan("0x" + "a".repeat(40), JSONArray(bad))
      }
    }
  }

  @Test
  fun privateSaleHistoryUsesVerifiedCreditAndPreservesOldPublicHistory() {
    val view =
      JSONObject()
        .put("phase", "COMPLETE")
        .put("direction", "sell")
        .put("targetSymbol", "AMZN")
        .put("receivedTargetAtoms", "900000000")
        .put("recordedAt", 123L)
    val legacy = SwapPortfolioStore.historyView("legacy", view)
    assertEquals("public", legacy["completionTarget"])
    assertEquals("900000000", legacy["receivedAtoms"])
    view.put("completionTarget", "confidential").put("privateCreditedAtoms", "7000000")
    val current = SwapPortfolioStore.historyView("private", view)
    assertEquals("confidential", current["completionTarget"])
    assertEquals("7000000", current["receivedAtoms"])
    assertEquals("7000000", current["privateCreditedAtoms"])
  }
}
