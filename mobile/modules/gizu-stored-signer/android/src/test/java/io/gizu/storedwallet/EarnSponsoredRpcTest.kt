package io.gizu.storedwallet

import kotlinx.coroutines.runBlocking
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnSponsoredRpcTest {
  @Test
  fun diagnosticRetainsOnlySafeCodeAndNativeSourceLocation() {
    val failure = EarnRpcRejection("pm_getPaymasterData", -32000, "REJECTED")
    failure.stackTrace =
      arrayOf(
        StackTraceElement(
          "io.gizu.storedwallet.earn.EarnSponsoredRpc",
          "call",
          "EarnSponsoredRpc.kt",
          90,
        )
      )
    assertEquals(
      "RPC_pm_getPaymasterData_-32000_REJECTED" to "EarnSponsoredRpc.kt:90",
      depositFailureDiagnostic(failure),
    )
  }

  @Test
  fun rpcRejectionRetainsSafeMethodAndCodeWithoutProviderContents() = runBlocking {
    val client =
      okhttp3.OkHttpClient.Builder()
        .addInterceptor { chain ->
          okhttp3.Response.Builder()
            .request(chain.request())
            .protocol(okhttp3.Protocol.HTTP_1_1)
            .code(200)
            .message("OK")
            .body(
              """{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"rate limit exceeded SECRET_SIGNATURE_AND_ADDRESS"}}"""
                .toResponseBody()
            )
            .build()
        }
        .build()
    try {
      nativeEarnRpc(NativeRpcTransport("http://127.0.0.1:8080/", client), "eth_call", JSONArray())
      fail("Provider errors must not become successful reads")
    } catch (failure: EarnRpcRejection) {
      assertEquals("eth_call", failure.method)
      assertEquals(-32005L, failure.rpcCode)
      assertEquals("RATE_LIMITED", failure.hint)
      assertFalse(failure.message!!.contains("SECRET"))
    } finally {
      client.dispatcher.executorService.shutdown()
    }
  }

  private val owner = "0x" + "ab".repeat(20)
  private val confidential = "0x" + "cd".repeat(20)
  private val recipient = "0x" + "ef".repeat(20)
  private val hash = "0x" + "a".repeat(64)

  private fun proposal() =
    JSONObject()
      .put("operationId", "source-1")
      .put("revision", 7)
      .put("quoteId", "route-1")
      .put("chainId", 143)
      .put("kind", "sourceFunding")
      .put("token", MONAD_EARN_USDC.lowercase())
      .put("amountAtoms", "1000000")
      .put("confidentialAccount", confidential)
      .put("refundOwner", owner)
      .put("recipient", recipient)
      .put("deadline", 600)

  private fun response() =
    proposal()
      .put("token", MONAD_EARN_USDC)
      .put("confidentialAccount", confidential.uppercase().replace("0X", "0x"))
      .put("refundOwner", owner.uppercase().replace("0X", "0x"))
      .put("recipient", recipient.uppercase().replace("0X", "0x"))
      .put("expiresAt", 700)
      .put("minimumCreditAtoms", "999800")
      .put("originAsset", EARN_MONAD_ASSET)
      .put("providerFeeBps", 2)
      .put("authenticatedBodyHash", hash)

  @Test
  fun independentlyFetchedBindingAcceptsEquivalentChecksummedAddresses() = runBlocking {
    var fetched = ""
    val gateway =
      NativeEarnQuoteGateway(
        { endpoint, body ->
          assertEquals("quote-binding", endpoint)
          assertEquals("route-1", JSONObject(body).getString("quoteId"))
          response().toString().also { fetched = it }
        },
        { body ->
          assertEquals(fetched, body)
          hash
        },
        { 100 },
      )
    val proof = gateway.binding(proposal())!!
    assertEquals("999800", proof.minimumCreditAtoms)
    assertEquals(hash, proof.binding.authenticatedBodyHash)
    assertEquals(owner.lowercase(), proof.binding.refundOwner.lowercase())
  }

  @Test
  fun newFundingNetworksBindTheirOriginToTheSamePrivateCashRoute() = runBlocking {
    for ((chain, token, origin) in
      listOf(
        Triple(
          8453,
          "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        ),
        Triple(
          42161,
          "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
          "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
        ),
      )) {
      val p = proposal().put("chainId", chain).put("token", token)
      val r = response().put("chainId", chain).put("token", token).put("originAsset", origin)
      val gateway = NativeEarnQuoteGateway({ _, _ -> r.toString() }, { hash }, { 100 })
      val proof = gateway.binding(p)!!
      assertEquals(chain.toULong(), proof.binding.chainId)
      assertEquals(token, proof.binding.token)
      assertEquals(origin, proof.originAsset)
    }
  }

  @Test
  fun nativeBindingRejectsChangedAmountIdFeeAndExpiredProof() = runBlocking {
    for (changed in
      listOf(
        response().put("amountAtoms", "1000001"),
        response().put("operationId", "other"),
        response().put("providerFeeBps", 4),
        response().put("expiresAt", 701),
      )) {
      val gateway = NativeEarnQuoteGateway({ _, _ -> changed.toString() }, { hash }, { 100 })
      try {
        gateway.binding(proposal())
        fail("Changed native quote must fail")
      } catch (_: IllegalStateException) {}
    }
  }

  @Test
  fun sourceQuoteRequiresFixedFeeAndBoundedAbsoluteExpiry() = runBlocking {
    val gateway =
      NativeEarnQuoteGateway(
        { endpoint, body ->
          assertEquals("source-quote", endpoint)
          val request = JSONObject(body)
          assertEquals(owner, request.getString("sourceOwner"))
          assertEquals(confidential, request.getString("confidentialAccount"))
          response().toString()
        },
        { hash },
        { 100 },
      )
    val quote = gateway.create(1, "source-1", 7, owner, confidential, "1000000", false)
    assertEquals(700L, quote["expiresAt"])
    assertEquals(2, quote["providerFeeBps"])
    val bad =
      NativeEarnQuoteGateway(
        { _, _ -> response().put("expiresAt", 701).toString() },
        { hash },
        { 100 },
      )
    try {
      bad.create(1, "source-1", 7, owner, confidential, "1000000", false)
      fail("Overlong quote must fail")
    } catch (_: IllegalStateException) {}
  }

  @Test
  fun qualifiedVariableFeesAreReturnedWithTheExactPolicyForReview() = runBlocking {
    val fees =
      JSONObject()
        .put("version", "qualified-2026")
        .put("route", "source")
        .put("totalBps", 4)
        .put(
          "appFees",
          JSONArray().put(JSONObject().put("recipient", "provider.near").put("fee", 4)),
        )
        .put("referral", "qualified")
        .put("integratorFeeBps", 0)
        .put("applicationFeeAtoms", "0")
    val gateway =
      NativeEarnQuoteGateway(
        { _, _ -> response().put("providerFeeBps", 4).put("feePolicy", fees).toString() },
        { hash },
        { 100 },
      )
    val quote = gateway.create(1, "source-1", 7, owner, confidential, "1000000", false)
    assertEquals(4, quote["providerFeeBps"])
    assertEquals("qualified-2026", (quote["feePolicy"] as Map<*, *>)["version"])
  }

  @Test
  fun financialSponsoredReadsUseOneCanonicalBlockAndRequireFreshBlock() = runBlocking {
    for ((sourceChainId, token) in
      listOf(
        143 to MONAD_EARN_USDC,
        8453 to "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        42161 to "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      )) {
      var pinnedReads = 0
      val rpc =
        object : TransferRpc {
          override suspend fun call(method: String, params: JSONArray): Any =
            when (method) {
              "eth_chainId" -> "0x" + sourceChainId.toString(16)
              "eth_getBlockByNumber" ->
                JSONObject()
                  .put("number", "0x10")
                  .put("hash", hash)
                  .put("parentHash", "0x" + "b".repeat(64))
                  .put("timestamp", "0x" + (System.currentTimeMillis() / 1000).toString(16))
                  .put("baseFeePerGas", "0x1")
              "eth_getTransactionCount" -> {
                if (params.get(1) is JSONObject) pinnedReads++
                "0x4"
              }
              "eth_getCode",
              "eth_call" -> {
                assertEquals(hash, params.getJSONObject(1).getString("blockHash"))
                assertTrue(params.getJSONObject(1).getBoolean("requireCanonical"))
                pinnedReads++
                if (method == "eth_getCode") {
                  if (params.getString(0) in setOf(owner, recipient)) "0x" else "0x6000"
                } else
                  "0x" +
                    "0".repeat(63) +
                    if (params.getJSONObject(0).getString("data") == "0x313ce567") "6" else "0"
              }
              else -> error("Unexpected $method")
            }
        }
      val state =
        EarnSponsoredStateLoader(rpc) { hash }
          .load(
            proposal().put("expectedFrom", owner).put("chainId", sourceChainId).put("token", token)
          )
      assertEquals(sourceChainId.toULong(), state.chainId)
      assertEquals("0x0", state.entryPointNonce)
      assertEquals(4uL, state.transactionNonce)
      assertEquals(11, pinnedReads)
    }
  }
}
