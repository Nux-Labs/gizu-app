package io.gizu.storedwallet

import org.json.JSONObject

internal interface CashoutGateway {
  suspend fun prepare(
    operationId: String,
    source: JSONObject,
    recipient: String,
    amount: String,
  ): JSONObject

  suspend fun submit(signed: String): JSONObject

  suspend fun status(child: JSONObject, source: JSONObject, usedReceipts: Set<String>): JSONObject
}

internal class NativeCashoutGateway(
  private val auth: suspend (JSONObject) -> JSONObject,
  private val rpc: TransferRpc = EarnSponsoredChainRpc(143),
  private val route: String = "cashout",
  private val transport: suspend (String, JSONObject) -> JSONObject = { path, body ->
    JSONObject(NativeRpcTransport(path).post(body.toString()))
  },
) : CashoutGateway {
  init {
    check(route in setOf("cashout", "private-funding"))
  }

  private suspend fun post(path: String, body: JSONObject) =
    transport("$EARN_NATIVE_BACKEND/$route/$path", body)

  override suspend fun prepare(
    operationId: String,
    source: JSONObject,
    recipient: String,
    amount: String,
  ): JSONObject =
    post(
        "prepare",
        JSONObject()
          .put("operationId", operationId)
          .put("signedData", auth(source))
          .put("recipient", recipient)
          .put("amountAtoms", amount),
      )
      .also {
        check(it.toString().toByteArray().size <= 262144)
        if (route == "cashout") it.put("leg", "withdrawal")
      }

  override suspend fun submit(signed: String) =
    JSONObject(
      NativeRpcTransport(
          EARN_NATIVE_BACKEND.removeSuffix("/earn/native") + "/swap/aurora/submit-intent"
        )
        .post("{\"signedData\":" + signed + "}")
    )

  override suspend fun status(
    child: JSONObject,
    source: JSONObject,
    usedReceipts: Set<String>,
  ): JSONObject {
    val prepared = JSONObject(child.getString("preparedText"))
    val request =
      JSONObject()
        .put("signedData", auth(source))
        .put("recoveryEnvelope", prepared.getString("recoveryEnvelope"))
        .put("submittedIntent", JSONObject(child.getString("signedData")))
    if (child.has("intentHash")) request.put("intentHash", child.getString("intentHash"))
    var result = post("status", request)
    if (result.optString("status") == "awaitingReceipt") {
      val reference =
        JSONObject(prepared.toString())
          .put("minimumDestinationAtoms", result.getString("receivedAtoms"))
          .put("maximumDestinationAtoms", result.getString("receivedAtoms"))
      val scan =
        scanNativePayoutTransfersExcluding(
          rpc,
          reference,
          child.optString(
            "nextScanBlock",
            (prepared.getString("referenceBlock").toBigInteger() + java.math.BigInteger.ONE)
              .toString(),
          ),
          excludedTransactions = usedReceipts,
        )
      if (scan.transactionHash != null) {
        request.put("signedData", auth(source))
        request.put("destinationTransactionHash", scan.transactionHash)
        result = post("status", request)
      } else result.put("nextScanBlock", scan.nextBlock)
    }
    if (result.optString("status") == "paid") {
      check(result.getBoolean("authenticated") && result.getBoolean("operationScoped"))
      val receipt = result.getJSONObject("receipt")
      check(
        receipt.getString("transactionHash") + ":" + receipt.getInt("logIndex") !in usedReceipts
      )
      confirmNativePayoutReceipt(
        rpc,
        prepared,
        receipt.getString("transactionHash"),
        result.getString("receivedAtoms"),
      )
    }
    return result
  }
}
