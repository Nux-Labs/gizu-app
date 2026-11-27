package io.gizu.storedwallet.swap

import io.gizu.storedwallet.StoredPasskey
import io.gizu.storedwallet.WalletRecord
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SwapBatchApprovalTest {
  private val wallet = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12"
  private val registry = "{\"version\":1,\"nextRecipient\":6}"

  private fun state(index: Int) =
    JSONObject()
      .put("id", "child$index")
      .put("approvedMs", JSONObject.NULL)
      .put("cancelled", false)
      .put("reapproval", JSONObject.NULL)
      .put("source", "0x" + (index + 1).toString().repeat(40))
      .put("confidential", "0x" + "a".repeat(40))
      .put("recipients", JSONArray(listOf("R1", "R2", "R3")))
      .put(
        "plan",
        JSONObject()
          .put("kind", "confidentialSwap")
          .put("sourceIndex", index)
          .put("target", "target")
          .put("amountAtoms", "1000000")
          .put("recipientIndices", JSONArray(listOf(3, 4, 5))),
      )
      .put(
        "data",
        JSONObject()
          .put("budget", "0xf4240")
          .put("fundingAmount", "0xf41dc")
          .put("fundingFee", "0x64")
          .put(
            "fundingQuote",
            JSONObject().put("depositAddress", "native deposit").put("minAmountOut", "0xf41da"),
          )
          .put("prepared", JSONArray().put(JSONObject().put("maxFeePerGas", "0x10")))
          .put("estimates", JSONArray(listOf(30, 30, 40)))
          .put("rateAmount", "0x3e8")
          .put("rateEnd", "0xa")
          .put("signedOperation", JSONObject.NULL)
          .put("payouts", JSONArray().put(JSONObject().put("signed", JSONObject.NULL)))
          .put(
            "orders",
            JSONArray()
              .put(JSONObject().put("permit", JSONObject.NULL).put("signature", JSONObject.NULL)),
          ),
      )

  private fun child(index: Int) =
    JSONObject()
      .put("operationId", "child$index")
      .put("sourceIndex", index)
      .put("fundingAddress", "0x" + (index + 1).toString().repeat(40))
      .put("budgetAtoms", "1000000")
      .put("state", state(index).toString())
      .put("status", JSONObject().put("phase", "REVIEW").toString())

  private fun scope(children: List<JSONObject> = listOf(child(0), child(1))) =
    SwapBatchApproval.create(
      wallet,
      wallet,
      registry,
      "batch1",
      children,
      "all exact native child reviews",
    )

  private fun record(generation: String = wallet) =
    WalletRecord(
      wallet,
      StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
      ByteArray(32),
      true,
      generation,
      registry,
    )

  @Test
  fun approvedOrSignedFutureChildCanNeverBeDrivenAsPreview() {
    assertTrue(SwapBatchApproval.safeToPreview(state(0)))
    assertFalse(SwapBatchApproval.safeToPreview(state(0).put("approvedMs", 1000)))
    val s = state(0)
    s.getJSONObject("data").put("signedOperation", JSONArray(listOf("hash", "signed bytes")))
    assertFalse(SwapBatchApproval.safeToPreview(s))
    val p = state(0)
    p.getJSONObject("data")
      .getJSONArray("payouts")
      .getJSONObject(0)
      .put("signed", "spending signature")
    assertFalse(SwapBatchApproval.safeToPreview(p))
  }

  @Test
  fun oneEphemeralGrantAuthorizesBothListedChildrenAndLowerFeesOnly() {
    val scope = scope()
    record().use { r ->
      assertThrows(IllegalStateException::class.java) { scope.assertAuthorized(r, state(0), 1000) }
      scope.approveAfterPasskey(r, 1000)
      scope.assertAuthorized(r, state(0), 1001)
      val lower = state(1)
      lower.getJSONObject("data").put("fundingFee", "0x32").put("prepared", JSONObject.NULL)
      scope.assertAuthorized(r, lower, 1001)
      assertThrows(IllegalStateException::class.java) { scope.assertAuthorized(r, state(3), 1001) }
    }
  }

  @Test
  fun changedPlanRecipientQuoteAmountOrHigherFeeRequiresFreshApproval() {
    val scope = scope()
    record().use { r ->
      scope.approveAfterPasskey(r, 1000)
      for (variant in 0..4) {
        val s = state(0)
        when (variant) {
          0 -> s.getJSONObject("plan").put("target", "other")
          1 -> s.getJSONArray("recipients").put(0, "other")
          2 -> s.getJSONObject("data").getJSONObject("fundingQuote").put("depositAddress", "other")
          3 -> s.getJSONObject("data").put("fundingAmount", "0xf41db")
          4 -> s.getJSONObject("data").put("fundingFee", "0x65")
        }
        assertThrows(IllegalStateException::class.java) { scope.assertAuthorized(r, s, 1001) }
      }
    }
  }

  @Test
  fun expiryRestartGenerationChangeAndInvalidationRequirePasskey() {
    val s = scope()
    record().use { r ->
      s.approveAfterPasskey(r, 1000)
      s.assertAuthorized(r, state(1), 181000)
      s.assertAuthorized(r, state(0), 900999)
      assertThrows(IllegalStateException::class.java) { s.assertAuthorized(r, state(0), 901000) }
      assertThrows(IllegalStateException::class.java) {
        scope().assertAuthorized(r, state(0), 1001)
      }
      assertThrows(IllegalStateException::class.java) { s.approveAfterPasskey(r, 1002) }
    }
    record("27cfcc2e-0891-4e31-a7d4-03780d7b4f12").use { r ->
      assertThrows(IllegalStateException::class.java) { s.assertAuthorized(r, state(0), 1001) }
    }
    s.invalidate()
    record().use { r ->
      assertThrows(IllegalStateException::class.java) { s.assertAuthorized(r, state(0), 1001) }
    }
  }

  @Test
  fun allSourcesUseSameTargetsRecipientsAndPrivateAccount() {
    val changed = child(1)
    val s = JSONObject(changed.getString("state"))
    s.getJSONObject("plan").put("recipientIndices", JSONArray(listOf(6, 7, 8)))
    changed.put("state", s.toString())
    assertThrows(IllegalStateException::class.java) { scope(listOf(child(0), changed)) }
  }

  private fun fundingChild(index: Int, chain: Int): JSONObject {
    val child =
      child(index)
        .put("sourceIndex", 1)
        .put("sourceChainId", chain)
        .put("fundingAddress", "0x" + "1".repeat(40))
    val s = state(index).put("source", "0x" + "1".repeat(40)).put("recipients", JSONArray())
    s.getJSONObject("plan")
      .put("kind", "confidentialFunding")
      .put("sourceIndex", 1)
      .put("sourceChainId", chain)
      .put("chainId", 4663)
      .put("recipientIndices", JSONArray())
    return child.put("state", s.toString())
  }

  @Test
  fun pooledFundingApprovalAdmitsSameAccountOnDifferentNetworksAndBindsOrigin() {
    val first = fundingChild(0, 143)
    val second = fundingChild(1, 8453)
    val scope = scope(listOf(first, second))
    record().use { r ->
      scope.approveAfterPasskey(r, 1000)
      scope.assertAuthorized(r, JSONObject(first.getString("state")), 1001)
      scope.assertAuthorized(r, JSONObject(second.getString("state")), 1001)
      val rebound = JSONObject(second.getString("state"))
      rebound.getJSONObject("plan").put("sourceChainId", 42161)
      assertThrows(IllegalStateException::class.java) { scope.assertAuthorized(r, rebound, 1001) }
    }
  }
}
