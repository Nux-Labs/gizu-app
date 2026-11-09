package io.gizu.storedwallet

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CashoutGroupReceiptTest {
  private val recipient = "0x" + "2".repeat(40)
  private val token = io.gizu.storedwallet.swap.MainnetPortfolio.USDC
  private val topic = "0x" + "d".repeat(64)
  private val refHash = "0x" + "a".repeat(64)

  private fun hash(d: String) = "0x" + d.repeat(64)

  private fun quote() =
    JSONObject()
      .put("destinationChainId", 143)
      .put("destinationToken", token)
      .put("destinationRecipient", recipient)
      .put("referenceBlock", "10")
      .put("referenceHash", refHash)
      .put("observedAtMs", 1000000)
      .put("minimumDestinationAtoms", "2999800")

  private fun log(d: String, amount: String, block: Int, index: Int = 0) =
    JSONObject()
      .put("address", token)
      .put("topics", JSONArray().put(topic).put(hash("0")).put("0x" + earnAddressWord(recipient)))
      .put("data", "0x" + earnNumberWord(amount))
      .put("transactionHash", hash(d))
      .put("blockNumber", "0x" + block.toString(16))
      .put("blockHash", hash("e"))
      .put("logIndex", "0x" + index.toString(16))
      .put("removed", false)

  private class Rpc(val logs: List<JSONObject>, var finalized: Int = 12) : TransferRpc {
    override suspend fun call(method: String, params: JSONArray): Any =
      when (method) {
        "eth_chainId" -> "0x8f"
        "eth_getBlockByNumber" -> {
          val n =
            if (params.getString(0) == "finalized") finalized
            else params.getString(0).removePrefix("0x").toInt(16)
          JSONObject()
            .put("number", "0x" + n.toString(16))
            .put("hash", "0x" + (if (n == 10) "a" else "e").repeat(64))
            .put("timestamp", "0x3e8")
        }
        "eth_getLogs" -> {
          val filter = params.getJSONObject(0)
          val from = filter.getString("fromBlock").removePrefix("0x").toInt(16)
          val to = filter.getString("toBlock").removePrefix("0x").toInt(16)
          JSONArray(
            logs.filter { it.getString("blockNumber").removePrefix("0x").toInt(16) in from..to }
          )
        }
        "eth_getTransactionReceipt" -> {
          val selected = logs.filter { it.getString("transactionHash") == params.getString(0) }
          JSONObject()
            .put("status", "0x1")
            .put("transactionHash", params.getString(0))
            .put("blockNumber", selected.first().getString("blockNumber"))
            .put("blockHash", "0x" + "e".repeat(64))
            .put("logs", JSONArray(selected))
        }
        else -> error(method)
      }
  }

  @Test
  fun groupIdentityMatchesBackendCanonicalCommitment() {
    val source1 =
      JSONObject()
        .put("kind", "swap")
        .put("profileChainId", 0)
        .put("cycleIndex", 0)
        .put("address", hash("1").take(42))
        .put("amountAtoms", "1000000")
    val source2 =
      JSONObject()
        .put("kind", "earn")
        .put("profileChainId", 4663)
        .put("cycleIndex", 0)
        .put("address", hash("3").take(42))
        .put("amountAtoms", "2000000")
    val proposal =
      JSONObject()
        .put("operationId", "cash_group")
        .put("amountAtoms", "3000000")
        .put("sources", JSONArray().put(source1).put(source2))
        .put("recipientIndices", JSONArray().put(3))
        .put("weightsBps", JSONArray().put(10000))
    val children =
      JSONArray()
        .put(JSONObject().put("source", 0).put("slot", 0).put("amountAtoms", "1000000"))
        .put(JSONObject().put("source", 1).put("slot", 0).put("amountAtoms", "2000000"))
    val group =
      JSONObject()
        .put("plan", JSONObject().put("proposal", proposal).put("children", children))
        .put("recipients", JSONArray().put(recipient))
    assertEquals(
      "0e26bdfdcbd73928d15787eff819c74d2f9a6de422807900fdd5896b95bbe083",
      cashoutGroupIdentity(group),
    )
    proposal.put("amountAtoms", "3000001")
    assertNotEquals(
      "0e26bdfdcbd73928d15787eff819c74d2f9a6de422807900fdd5896b95bbe083",
      cashoutGroupIdentity(group),
    )
  }

  @Test
  fun sharedSlotCollectsUnequalReceiptsAcrossFinalityPagesWithoutChoosingAChild() = runBlocking {
    // Larger event finalizes first, below total group minimum but above either child minimum.
    val rpc = Rpc(listOf(log("1", "2500123", 11), log("2", "500000", 12)), 11)
    val first = scanCashoutGroupReceipts(rpc, quote(), JSONObject(), { topic })
    assertEquals(
      listOf(hash("1")),
      first.getJSONArray("transactionHashes").let { a -> (0 until a.length()).map(a::getString) },
    )
    assertEquals("12", first.getString("nextScanBlock"))
    rpc.finalized = 12
    val second = scanCashoutGroupReceipts(rpc, quote(), first, { topic })
    assertEquals(2, second.getJSONArray("transactionHashes").length())
    val receipts =
      second.getJSONArray("transactionHashes").let { a ->
        (0 until a.length()).flatMap {
          confirmCashoutGroupReceipts(rpc, quote(), a.getString(it), { topic })
        }
      }
    assertEquals("3000123", receipts.sumAtoms("receivedAtoms"))
  }

  @Test
  fun confirmsAllCanonicalEventsInOneTransactionAndRejectsUnfinalizedOrRemoved() = runBlocking {
    val logs = listOf(log("1", "2500123", 11, 0), log("1", "500000", 11, 1))
    val rpc = Rpc(logs)
    assertEquals(2, confirmCashoutGroupReceipts(rpc, quote(), hash("1"), { topic }).size)
    rpc.finalized = 10
    try {
      confirmCashoutGroupReceipts(rpc, quote(), hash("1"), { topic })
      fail("Unfinalized receipt")
    } catch (_: IllegalStateException) {}
    rpc.finalized = 12
    logs[0].put("removed", true)
    assertEquals(
      "500000",
      confirmCashoutGroupReceipts(rpc, quote(), hash("1"), { topic }).sumAtoms("receivedAtoms"),
    )
  }
}
