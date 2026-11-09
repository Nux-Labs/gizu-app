package io.gizu.storedwallet

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeCashoutGatewayTest {
  private val recipient = "0x" + "2".repeat(40)
  private val hash = "0x" + "b".repeat(64)
  private val blockHash = "0x" + "c".repeat(64)
  private val referenceHash = "0x" + "a".repeat(64)
  private val topic = "0x" + "d".repeat(64)

  private fun prepared() =
    JSONObject()
      .put("destinationChainId", 143)
      .put("destinationToken", io.gizu.storedwallet.swap.MainnetPortfolio.USDC)
      .put("destinationRecipient", recipient)
      .put("leg", "withdrawal")
      .put("minimumDestinationAtoms", "98")
      .put("observedAtMs", 1000000)
      .put("referenceBlock", "10")
      .put("referenceHash", referenceHash)
      .put("recoveryEnvelope", "sealed")

  private fun log() =
    JSONObject()
      .put("address", io.gizu.storedwallet.swap.MainnetPortfolio.USDC)
      .put(
        "topics",
        JSONArray().put(topic).put("0x" + "0".repeat(64)).put("0x" + earnAddressWord(recipient)),
      )
      .put("data", "0x" + earnNumberWord("100"))
      .put("blockNumber", "0xb")
      .put("blockHash", blockHash)
      .put("transactionHash", hash)
      .put("logIndex", "0x7")
      .put("removed", false)

  private fun rpc(logs: JSONArray = JSONArray().put(log())) =
    object : TransferRpc {
      override suspend fun call(method: String, params: JSONArray): Any =
        when (method) {
          "eth_chainId" -> "0x8f"
          "eth_getBlockByNumber" -> {
            val ref = params.getString(0) == "0xa"
            JSONObject()
              .put(
                "number",
                if (ref) "0xa" else if (params.getString(0) == "finalized") "0xc" else "0xb",
              )
              .put("hash", if (ref) referenceHash else blockHash)
              .put("timestamp", "0x3e8")
          }
          "eth_getLogs" -> logs
          "eth_getTransactionReceipt" ->
            JSONObject()
              .put("status", "0x1")
              .put("transactionHash", hash)
              .put("blockNumber", "0xb")
              .put("blockHash", blockHash)
              .put("logs", logs)
          else -> error("Unexpected method $method")
        }
    }

  @Test
  fun restoredPaidSlotIgnoresLaterGiftWhilePendingSlotFinishes() = runBlocking {
    val pendingRecipient = "0x" + "3".repeat(40)
    val giftHash = "0x" + "f".repeat(64)
    val pendingHash = "0x" + "e".repeat(64)
    val gift =
      log()
        .put("transactionHash", giftHash)
        .put("data", "0x" + earnNumberWord("70"))
        .put("blockNumber", "0xc")
    val late =
      log()
        .put("transactionHash", pendingHash)
        .put("data", "0x" + earnNumberWord("60"))
        .put("blockNumber", "0xd")
    late.getJSONArray("topics").put(2, "0x" + earnAddressWord(pendingRecipient))
    val chainLogs = mapOf(hash to log(), giftHash to gift, pendingHash to late)
    var pendingFinalized = false
    var paidSlotScans = 0
    var paidReceiptChecks = 0
    var paidCanonical = true
    val baseRpc = rpc()
    val chain =
      object : TransferRpc {
        override suspend fun call(method: String, params: JSONArray): Any =
          when (method) {
            "eth_getBlockByNumber" -> {
              val tag = params.getString(0)
              val number =
                if (tag == "finalized") (if (pendingFinalized) 13 else 12)
                else tag.removePrefix("0x").toInt(16)
              JSONObject()
                .put("number", "0x" + number.toString(16))
                .put("hash", if (number == 10) referenceHash else blockHash)
                .put("timestamp", "0x3e8")
            }
            "eth_getLogs" -> {
              val to = params.getJSONObject(0).getJSONArray("topics").getString(2)
              if (to == "0x" + earnAddressWord(recipient)) {
                paidSlotScans++
                JSONArray().put(log()).put(gift)
              } else if (pendingFinalized) JSONArray().put(late) else JSONArray()
            }
            "eth_getTransactionReceipt" -> {
              val tx = params.getString(0)
              if (tx == hash) paidReceiptChecks++
              JSONObject()
                .put("status", if (tx == hash && !paidCanonical) "0x0" else "0x1")
                .put("transactionHash", tx)
                .put("blockNumber", chainLogs.getValue(tx).getString("blockNumber"))
                .put("blockHash", blockHash)
                .put("logs", JSONArray().put(chainLogs.getValue(tx)))
            }
            else -> baseRpc.call(method, params)
          }
      }
    val group =
      JSONObject()
        .put(
          "plan",
          JSONObject().put("proposal", JSONObject().put("sources", JSONArray().put(JSONObject()))),
        )
        .put("recipients", JSONArray().put(recipient).put(pendingRecipient))
    val paidChild =
      JSONObject()
        .put("slot", 0)
        .put("status", "paid")
        .put("minimumDestinationAtoms", "98")
        .put("receivedAtoms", "100")
        .put("preparedText", prepared().toString())
        .put("signedData", "{}")
        .put("intentHash", "legacy-known-hash")
        .put("receipt", JSONObject().put("transactionHash", hash).put("logIndex", 7))
    val pendingChild =
      JSONObject()
        .put("slot", 1)
        .put("status", "pending")
        .put("minimumDestinationAtoms", "50")
        .put("receivedAtoms", "0")
        .put(
          "preparedText",
          prepared()
            .put("destinationRecipient", pendingRecipient)
            .put("minimumDestinationAtoms", "50")
            .toString(),
        )
        .put("signedData", "{}")
    val row = JSONObject().put("children", JSONArray().put(paidChild).put(pendingChild))
    // A previous broad scan in the backup may already contain the later gift.
    row.put(
      "groupScan",
      JSONArray()
        .put(
          JSONObject()
            .put("nextScanBlock", "11")
            .put("transactionHashes", JSONArray().put(hash).put(giftHash))
        )
        .put(JSONObject()),
    )
    val before = paidChild.toString()
    val gateway =
      NativeCashoutGateway(
        auth = { JSONObject() },
        rpc = chain,
        transport = { _, body ->
          val hints = body.getJSONArray("destinationTransactionHashes")
          val result =
            JSONObject()
              .put("observedAtMs", System.currentTimeMillis())
              .put("authenticated", true)
              .put("operationScoped", true)
              .put("verification", "destination-receipt-group-v1")
          if (hints.getJSONArray(0).length() == 0 || hints.getJSONArray(1).length() == 0)
            result.put("status", "awaitingReceipt")
          else {
            val proofs =
              JSONArray(
                (0..1).map { slot ->
                  val selected =
                    hints.getJSONArray(slot).let { a ->
                      (0 until a.length()).map { chainLogs.getValue(a.getString(it)) }
                    }
                  val receipts =
                    selected.map { l ->
                      JSONObject()
                        .put("transactionHash", l.getString("transactionHash"))
                        .put("logIndex", 7)
                        .put(
                          "receivedAtoms",
                          l.getString("data").removePrefix("0x").toBigInteger(16).toString(),
                        )
                        .put(
                          "blockNumber",
                          l.getString("blockNumber").removePrefix("0x").toBigInteger(16).toString(),
                        )
                        .put("blockHash", blockHash)
                    }
                  JSONObject()
                    .put("slot", slot)
                    .put("destinationRecipient", if (slot == 0) recipient else pendingRecipient)
                    .put("minimumDestinationAtoms", if (slot == 0) "98" else "50")
                    .put("receivedAtoms", receipts.sumAtoms("receivedAtoms"))
                    .put("receipts", JSONArray(receipts))
                }
              )
            result.put("status", "paid").put("slots", proofs)
          }
        },
        eventTopic = { topic },
      )
    val waiting = gateway.groupStatus(row, group)
    assertEquals("awaitingReceipt", waiting.getString("status"))
    row.put("groupScan", waiting.getJSONArray("groupScan"))
    pendingFinalized = true
    // Restoring the old row must reconstruct the same fixed slot without trusting its scan hints.
    val restored = JSONObject(row.toString())
    val complete = gateway.groupStatus(restored, group)
    assertEquals("paid", complete.getString("status"))
    assertEquals("100", complete.getJSONArray("slots").getJSONObject(0).getString("receivedAtoms"))
    assertEquals("60", complete.getJSONArray("slots").getJSONObject(1).getString("receivedAtoms"))
    assertEquals(0, paidSlotScans)
    assertTrue(paidReceiptChecks > 0)
    assertEquals(before, restored.getJSONArray("children").getJSONObject(0).toString())
    assertEquals(
      listOf(hash),
      complete.getJSONArray("groupScan").getJSONObject(0).getJSONArray("transactionHashes").let { a
        ->
        (0 until a.length()).map(a::getString)
      },
    )
    paidCanonical = false
    try {
      gateway.groupStatus(restored, group)
      fail("Historical paid receipts must be revalidated")
    } catch (_: IllegalStateException) {}
    paidCanonical = true
    restored.getJSONArray("children").getJSONObject(0).put("receivedAtoms", "101")
    try {
      gateway.groupStatus(restored, group)
      fail("The exact saved paid amount must match its historical event")
    } catch (_: IllegalStateException) {}
  }

  @Test
  fun wholeGroupGatewayVerifiesEveryCanonicalEventAndRejectsChangedTotals() = runBlocking {
    for (scenario in listOf("valid", "changed", "slow-backend", "slow-native", "stale")) {
      val changed = scenario == "changed"
      var clock = System.currentTimeMillis()
      val logs =
        JSONArray()
          .put(log())
          .put(log().put("logIndex", "0x8").put("data", "0x" + earnNumberWord("60")))
      val sources =
        JSONArray()
          .put(JSONObject().put("address", "first"))
          .put(JSONObject().put("address", "second"))
      val group =
        JSONObject()
          .put("plan", JSONObject().put("proposal", JSONObject().put("sources", sources)))
          .put("recipients", JSONArray().put(recipient))
      val row =
        JSONObject()
          .put(
            "children",
            JSONArray(
              (0..1).map { index ->
                JSONObject()
                  .put("slot", 0)
                  .put("minimumDestinationAtoms", if (index == 0) "98" else "50")
                  .put("preparedText", prepared().toString())
                  .put("signedData", "{}")
              }
            ),
          )
      var calls = 0
      val chain = rpc(logs)
      val gateway =
        NativeCashoutGateway(
          auth = { JSONObject().put("owner", it.getString("address")) },
          rpc =
            object : TransferRpc {
              override suspend fun call(method: String, params: JSONArray): Any {
                if (scenario == "slow-native" && method == "eth_getTransactionReceipt")
                  clock += 90000
                return chain.call(method, params)
              }
            },
          transport = { path, body ->
            assertTrue(path.endsWith("group-status"))
            assertEquals(2, body.getJSONArray("owners").length())
            assertEquals(2, body.getJSONArray("children").length())
            calls++
            if (scenario == "slow-backend") clock += 90000
            val result =
              JSONObject()
                .put("authenticated", true)
                .put("operationScoped", true)
                .put("verification", "destination-receipt-group-v1")
                .put("observedAtMs", clock - if (scenario == "stale") 60001 else 0)
            if (body.getJSONArray("destinationTransactionHashes").getJSONArray(0).length() == 0)
              result.put("status", "awaitingReceipt")
            else
              result
                .put("status", "paid")
                .put(
                  "slots",
                  JSONArray()
                    .put(
                      JSONObject()
                        .put("slot", 0)
                        .put("destinationRecipient", recipient)
                        .put("minimumDestinationAtoms", "148")
                        .put("receivedAtoms", if (changed) "159" else "160")
                        .put(
                          "receipts",
                          JSONArray(
                            (7..8).map { index ->
                              JSONObject()
                                .put("transactionHash", hash)
                                .put("logIndex", index)
                                .put("receivedAtoms", if (index == 7) "100" else "60")
                                .put("blockNumber", "11")
                                .put("blockHash", blockHash)
                            }
                          ),
                        )
                    ),
                )
          },
          eventTopic = { topic },
          now = { clock },
        )
      if (changed || scenario == "stale") {
        try {
          gateway.groupStatus(row, group)
          fail("Changed total or stale backend proof")
        } catch (_: IllegalStateException) {}
      } else {
        val paid = gateway.groupStatus(row, group)
        assertEquals("paid", paid.getString("status"))
        assertEquals(2, calls)
        if (scenario == "slow-native")
          assertEquals(90000, clock - paid.getLong("nativeReceivedAtMs"))
        assertEquals(
          1,
          paid.getJSONArray("groupScan").getJSONObject(0).getJSONArray("transactionHashes").length(),
        )
      }
    }
  }

  @Test
  fun groupOwnersUseOneFreshSaltAndBoundedLocalProofGeneration() = runBlocking {
    var saltReads = 0
    var clock = 1000L
    val sources = (0 until 32).map { JSONObject().put("address", "source-$it") }
    val proofs =
      cashoutReadAuthentications(
        sources,
        {
          saltReads++
          "salt"
        },
        { source, salt ->
          clock += 20
          JSONObject().put("owner", source.getString("address")).put("salt", salt)
        },
        { clock },
      )
    assertEquals(1, saltReads)
    assertEquals(32, proofs.size)
    assertEquals(32, proofs.map { it.getString("owner") }.toSet().size)
    try {
      cashoutReadAuthentications(
        sources,
        { "salt" },
        { _, _ ->
          clock += 2000
          JSONObject()
        },
        { clock },
      )
      fail("A stale owner proof batch must not be sent")
    } catch (_: IllegalStateException) {}
  }

  @Test
  fun actualPublicReceiptCanExceedEstimateWithoutPrivateHistory() = runBlocking {
    var calls = 0
    val gateway =
      NativeCashoutGateway(
        auth = { JSONObject() },
        rpc = rpc(),
        transport = { _, body ->
          calls++
          if (!body.has("destinationTransactionHash"))
            JSONObject()
              .put("status", "awaitingReceipt")
              .put("verification", "destination-receipt-v1")
              .put("minimumDestinationAtoms", "98")
              .put("receivedAtoms", "0")
          else
            JSONObject()
              .put("status", "paid")
              .put("verification", "destination-receipt-v1")
              .put("authenticated", true)
              .put("operationScoped", true)
              .put("receivedAtoms", "100")
              .put("receipt", JSONObject().put("transactionHash", hash).put("logIndex", 7))
        },
        eventTopic = { topic },
      )
    val child = JSONObject().put("preparedText", prepared().toString()).put("signedData", "{}")
    val result = gateway.status(child, JSONObject(), emptySet())
    assertEquals("paid", result.getString("status"))
    assertEquals("100", result.getString("receivedAtoms"))
    assertEquals(2, calls)
    calls = 0
    val repeated = gateway.status(child, JSONObject(), setOf("$hash:7"))
    assertEquals("awaitingReceipt", repeated.getString("status"))
    assertEquals(1, calls)
  }

  @Test
  fun newReceiptModeRejectsChangedMinimumAndCannotQualifyPrivateFunding() = runBlocking {
    for (route in listOf("cashout", "private-funding")) {
      val gateway =
        NativeCashoutGateway(
          auth = { JSONObject() },
          rpc = rpc(),
          route = route,
          transport = { _, _ ->
            JSONObject()
              .put("status", "awaitingReceipt")
              .put("verification", "destination-receipt-v1")
              .put("minimumDestinationAtoms", "97")
              .put("receivedAtoms", "0")
          },
          eventTopic = { topic },
        )
      try {
        gateway.status(
          JSONObject().put("preparedText", prepared().toString()).put("signedData", "{}"),
          JSONObject(),
          emptySet(),
        )
        fail("Changed receipt policy must reject")
      } catch (_: IllegalStateException) {}
    }
  }
}
