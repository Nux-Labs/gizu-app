package io.gizu.storedwallet

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativePrivateFundingGatewayTest {
  private val noRpc =
    object : TransferRpc {
      override suspend fun call(method: String, params: JSONArray): Any =
        error("No receipt exists, so no RPC expected")
    }

  @Test
  fun privateFundingUsesFixedRouteAndPreservesRobinhoodReceiptPolicyWhileCashoutRemainsWithdrawal() =
    runBlocking {
      for (route in listOf("cashout", "private-funding")) {
        val calls = mutableListOf<Pair<String, JSONObject>>()
        var authentications = 0
        val source = JSONObject().put("kind", "swap").put("address", "private-source")
        val gateway =
          NativeCashoutGateway(
            auth = { descriptor ->
              assertSame(source, descriptor)
              authentications++
              JSONObject().put("standard", "erc191").put("payload", "native-read-auth")
            },
            rpc = noRpc,
            route = route,
            transport = { path, body ->
              calls += path to JSONObject(body.toString())
              if (path.endsWith("/prepare"))
                JSONObject()
                  .put("destinationChainId", if (route == "cashout") 143 else 4663)
                  .put("recoveryEnvelope", "opaque-private-recovery")
              else JSONObject().put("status", "pending")
            },
          )
        val prepared =
          gateway.prepare("private_source_0", source, "target-investment-wallet", "396000")
        if (route == "cashout") assertEquals("withdrawal", prepared.getString("leg"))
        else assertFalse(prepared.has("leg"))
        val child =
          JSONObject()
            .put("preparedText", prepared.toString())
            .put(
              "signedData",
              JSONObject()
                .put("standard", "erc191")
                .put("payload", "exact-signed-private-transfer")
                .put("signature", "native-signature")
                .toString(),
            )
        assertEquals("pending", gateway.status(child, source, emptySet()).getString("status"))
        assertEquals(
          listOf("$EARN_NATIVE_BACKEND/$route/prepare", "$EARN_NATIVE_BACKEND/$route/status"),
          calls.map { it.first },
        )
        assertEquals(2, authentications)
        assertEquals("396000", calls[0].second.getString("amountAtoms"))
        assertEquals("target-investment-wallet", calls[0].second.getString("recipient"))
        assertEquals("opaque-private-recovery", calls[1].second.getString("recoveryEnvelope"))
        assertEquals(
          "exact-signed-private-transfer",
          calls[1].second.getJSONObject("submittedIntent").getString("payload"),
        )
        assertFalse(calls.any { it.second.has("source") || it.second.has("profileChainId") })
      }
    }

  @Test
  fun savedPrivateFundingScansItsCanonicalRobinhoodReceiptWithoutHistoryOrNewSigning() = runBlocking {
    val referenceHash = "0x" + "a".repeat(64)
    val prepared = JSONObject()
      .put("destinationChainId", 4663)
      .put("destinationToken", HOOD_EARN_USDG)
      .put("destinationRecipient", "0x" + "2".repeat(40))
      .put("minimumDestinationAtoms", "98")
      .put("observedAtMs", 1000000)
      .put("referenceBlock", "10")
      .put("referenceHash", referenceHash)
      .put("recoveryEnvelope", "saved-sealed-quote")
    val child = JSONObject()
      .put("preparedText", prepared.toString())
      .put("signedData", JSONObject().put("payload", "exact-saved-signature").toString())
    val transaction = "0x" + "b".repeat(64)
    val transfer = JSONObject().put("address", HOOD_EARN_USDG)
      .put("topics", JSONArray().put("0x" + "d".repeat(64)).put("0x" + "0".repeat(64)).put("0x" + earnAddressWord("0x" + "2".repeat(40))))
      .put("data", "0x" + earnNumberWord("100"))
      .put("blockNumber", "0xb").put("blockHash", referenceHash)
      .put("transactionHash", transaction).put("logIndex", "0x7").put("removed", false)
    val rpc = object : TransferRpc {
      override suspend fun call(method: String, params: JSONArray): Any = when (method) {
        "eth_chainId" -> "0x1237"
        "eth_getBlockByNumber" -> {
          assertNotEquals("finalized", params.getString(0))
          JSONObject().put("number", if(params.getString(0)=="0xa") "0xa" else "0xb").put("hash", referenceHash).put("timestamp", "0x3e8")
        }
        "eth_getLogs" -> {
          assertEquals("0xb", params.getJSONObject(0).getString("fromBlock"))
          JSONArray().put(transfer)
        }
        "eth_getTransactionReceipt" -> JSONObject().put("status", "0x1").put("transactionHash", transaction)
          .put("blockNumber", "0xb").put("blockHash", referenceHash).put("logs", JSONArray().put(transfer))
        else -> error("Unexpected RPC $method")
      }
    }
    val gateway = NativeCashoutGateway(
      auth = { JSONObject().put("payload", "fresh-read-only-auth") },
      rpc = rpc,
      route = "private-funding",
      transport = { path, body ->
        assertTrue(path.endsWith("/private-funding/status"))
        assertEquals("exact-saved-signature", body.getJSONObject("submittedIntent").getString("payload"))
        if (body.has("destinationTransactionHash")) {
          assertEquals(transaction, body.getString("destinationTransactionHash"))
          JSONObject().put("status", "paid").put("receivedAtoms", "100")
            .put("authenticated", true).put("operationScoped", true)
            .put("receipt", JSONObject().put("transactionHash", transaction).put("logIndex", 7))
        } else JSONObject().put("status", "awaitingReceipt").put("verification", "signed-route-receipt-v1")
          .put("receivedAtoms", "0").put("minimumDestinationAtoms", "98")
      },
      eventTopic = { "0x" + "d".repeat(64) },
    )
    val result = gateway.status(child, JSONObject(), emptySet())
    assertEquals("paid", result.getString("status"))
    assertEquals("100", result.getString("receivedAtoms"))
  }

  @Test
  fun callerCannotChooseAnArbitraryGatewayRoute() {
    for (route in
      listOf("https://foreign.example", "private-funding/../cashout", "withdrawal")) assertThrows(
      IllegalStateException::class.java
    ) {
      NativeCashoutGateway(auth = { JSONObject() }, rpc = noRpc, route = route)
    }
  }
}
