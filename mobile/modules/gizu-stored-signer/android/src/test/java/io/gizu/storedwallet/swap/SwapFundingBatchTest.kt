package io.gizu.storedwallet.swap

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SwapFundingBatchTest {
  private fun child(index: Int) =
    JSONObject()
      .put("sourceIndex", index)
      .put("fundingAddress", "0x" + "$index".repeat(40))
      .put("operationId", "child$index")
      .put("budgetAtoms", if (index == 0) "7" else "3")
      .put("state", "initial$index")
      .put("status", JSONObject().put("phase", "PREPARING").toString())

  private fun batch() =
    SwapFundingBatch.create(
      JSONObject().put("fundingBatchId", "batch1").put("fundingBatchSize", 2),
      JSONArray().put(child(0)).put(child(1)),
    )

  @Test
  fun onlyCanonicalCompletionAdvancesAndResumePreservesAllChildren() {
    val batch = batch()
    batch.record("signed-child0", JSONObject().put("phase", "FUNDING").toString())
    assertFalse(batch.advanceIfComplete())
    assertEquals(0, batch.currentIndex)
    batch.record("settled-child0", JSONObject().put("phase", "COMPLETE").toString())
    assertNotEquals(
      "COMPLETE",
      batch.publicStatus(JSONObject().put("phase", "COMPLETE")).getString("phase"),
    )
    assertTrue(batch.advanceIfComplete())
    assertEquals(1, batch.currentIndex)
    val restored = SwapFundingBatch.restore(JSONObject(batch.json.toString()))
    assertEquals(1, restored.currentIndex)
    assertEquals("initial1", restored.current.getString("state"))
    assertEquals(
      "settled-child0",
      restored.json.getJSONArray("children").getJSONObject(0).getString("state"),
    )
    assertFalse(restored.advanceIfComplete())
  }

  @Test
  fun cancellationNeverErasesSignedEarlierChildrenOrAdvancesUnsignedChildren() {
    val batch = batch()
    batch.record("signed-first", JSONObject().put("phase", "CANCELLED").toString())
    batch.cancel()
    val restored = SwapFundingBatch.restore(JSONObject(batch.json.toString()))
    assertTrue(restored.cancelled)
    assertFalse(restored.advanceIfComplete())
    assertEquals(0, restored.currentIndex)
    assertEquals("signed-first", restored.current.getString("state"))
    assertEquals(2, restored.size)
  }

  @Test
  fun restoredBatchRejectsSkippingAnIncompleteChild() {
    val batch = batch()
    batch.json.put("currentIndex", 1)
    assertThrows(Exception::class.java) { SwapFundingBatch.restore(batch.json) }
  }

  @Test
  fun startingAnotherInvestmentRetainsEncryptedSignedBatchHistory() {
    val previous =
      JSONObject()
        .put("operationId", "batch1")
        .put("state", "signed-private-state")
        .put("fundingBatch", batch().json)
    val history = SwapFundingBatch.archive(previous, "batch2")
    assertEquals(1, history.length())
    assertEquals("signed-private-state", history.getJSONObject(0).getString("state"))
    val current =
      JSONObject()
        .put("operationId", "batch2")
        .put("state", "new-child-state")
        .put("history", history)
    assertEquals(1, SwapFundingBatch.archive(current, "batch2").length())
    assertEquals(2, SwapFundingBatch.archive(current, "batch3").length())
    assertFalse(SwapFundingBatch.archive(current, "batch3").getJSONObject(1).has("history"))
  }

  private val privateAsset = "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx"

  private fun pooled(): SwapFundingBatch {
    val owner = "0x" + "1".repeat(40)
    val children = JSONArray()
    for ((index, chain) in listOf(143, 8453).withIndex()) children.put(
      JSONObject()
        .put("operationId", "fund$index")
        .put("sourceIndex", 1)
        .put("sourceChainId", chain)
        .put("sourceId", "$chain:${owner.lowercase()}")
        .put(
          "token",
          if (chain == 143) "0x754704bc059f8c67012fed69bc8a327a5aafb603"
          else "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        )
        .put("fundingAddress", owner)
        .put("budgetAtoms", if (index == 0) "10000000" else "5000000")
        .put("state", "initial$index")
        .put("status", JSONObject().put("phase", "PLANNING").toString())
    )
    return SwapFundingBatch.createPooled(
      JSONObject().put("fundingBatchId", "pool1").put("fundingBatchSize", 2),
      children,
      JSONObject()
        .put("walletId", "wallet")
        .put("generation", "generation")
        .put("confidentialAccount", "0x" + "2".repeat(40))
        .put("privateAsset", privateAsset)
        .put("originalBudgetAtoms", "17000000")
        .put("approvedExistingPrivateAtoms", "2000000")
        .put(
          "savedPlan",
          JSONObject()
            .put("kind", "confidentialPayout")
            .put("target", "0x" + "a".repeat(40))
            .put("chainId", 4663)
            .put("recipientIndices", JSONArray(listOf(3, 4, 5)))
            .put("weights", JSONArray(listOf(3, 3, 4))),
        ),
    )
  }

  private fun complete(batch: SwapFundingBatch, atoms: String) {
    val status =
      JSONObject()
        .put("operationId", batch.current.getString("operationId"))
        .put("phase", "COMPLETE")
        .put("kind", "confidentialFunding")
        .put("completionTarget", "confidential")
        .put("creditedAtoms", atoms)
    batch.record("confirmed-credit-${batch.currentIndex}", status.toString())
  }

  @Test
  fun mixedNetworkSwapWaitsForAllCreditsThenExecutesOnlyOnce() {
    val batch = pooled()
    assertFalse(batch.needsExecution)
    complete(batch, "9900000")
    val restored = SwapFundingBatch.restore(JSONObject(batch.json.toString()))
    assertTrue(restored.advanceIfComplete())
    assertFalse(restored.needsExecution)
    assertThrows(IllegalStateException::class.java) { restored.executionPlan() }
    complete(restored, "4900000")
    assertTrue(restored.needsExecution)
    assertNotEquals(
      "COMPLETE",
      restored.publicStatus(JSONObject().put("phase", "COMPLETE")).getString("phase"),
    )
    val plan = restored.executionPlan()
    assertEquals("16800000", plan.getString("amountAtoms"))
    assertEquals("[3,4,5]", plan.getJSONArray("recipientIndices").toString())
    assertEquals("[3,3,4]", plan.getJSONArray("weights").toString())
    restored.attachExecution(
      JSONObject()
        .put("operationId", "execution")
        .put("fundingAddress", "0x" + "1".repeat(40))
        .put("state", JSONObject().put("plan", plan).toString())
        .put("status", JSONObject().put("phase", "REVIEW").toString())
    )
    assertTrue(restored.executing)
    assertEquals("execution", restored.current.getString("operationId"))
    assertThrows(IllegalStateException::class.java) { restored.attachExecution(JSONObject()) }
    restored.record("execution-complete", JSONObject().put("phase", "COMPLETE").toString())
    assertEquals(
      "COMPLETE",
      restored.publicStatus(JSONObject().put("phase", "COMPLETE")).getString("phase"),
    )
  }

  @Test
  fun sameAccountOnTwoChainsIsDistinctButDuplicateSourceCannotInflatePool() {
    val batch = pooled()
    assertEquals(2, SwapFundingBatch.restore(JSONObject(batch.json.toString())).fundingSize)
    val duplicate = JSONObject(batch.json.toString())
    duplicate
      .getJSONArray("children")
      .getJSONObject(1)
      .put("sourceChainId", 143)
      .put("sourceId", batch.json.getJSONArray("children").getJSONObject(0).getString("sourceId"))
      .put("token", "0x754704bc059f8c67012fed69bc8a327a5aafb603")
    assertThrows(IllegalStateException::class.java) { SwapFundingBatch.restore(duplicate) }
  }

  @Test
  fun cancellationAfterFirstCreditRetainsCreditAndNeverCreatesExecution() {
    val batch = pooled()
    complete(batch, "9900000")
    batch.cancel()
    val restored = SwapFundingBatch.restore(JSONObject(batch.json.toString()))
    assertEquals("9900000", restored.current.getString("creditedAtoms"))
    assertFalse(restored.advanceIfComplete())
    assertFalse(restored.needsExecution)
    assertThrows(IllegalStateException::class.java) { restored.executionPlan() }
  }

  @Test
  fun privateBalanceAloneCreatesOneExecutionWithoutPublicFundingChildren() {
    val manifest =
      JSONObject(pooled().json.toString()).put("approvedExistingPrivateAtoms", "17000000")
    val batch =
      SwapFundingBatch.createPooled(
        JSONObject().put("fundingBatchId", "privateOnly").put("fundingBatchSize", 0),
        JSONArray(),
        manifest,
      )
    assertEquals(0, batch.fundingSize)
    assertTrue(batch.needsExecution)
    val plan = batch.executionPlan()
    assertEquals("17000000", plan.getString("amountAtoms"))
    batch.attachExecution(
      JSONObject()
        .put("operationId", "privateExecution")
        .put("fundingAddress", "0x" + "1".repeat(40))
        .put("state", JSONObject().put("plan", plan).toString())
        .put("status", JSONObject().put("phase", "REVIEW").toString())
    )
    val restored = SwapFundingBatch.restore(JSONObject(batch.json.toString()))
    assertTrue(restored.executing)
    assertTrue(restored.pending)
    assertEquals(0, restored.credits().length())
    assertEquals("privateExecution", restored.current.getString("operationId"))
  }
}
