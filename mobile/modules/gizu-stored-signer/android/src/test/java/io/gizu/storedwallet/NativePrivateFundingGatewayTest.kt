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
  fun callerCannotChooseAnArbitraryGatewayRoute() {
    for (route in
      listOf("https://foreign.example", "private-funding/../cashout", "withdrawal")) assertThrows(
      IllegalStateException::class.java
    ) {
      NativeCashoutGateway(auth = { JSONObject() }, rpc = noRpc, route = route)
    }
  }
}
