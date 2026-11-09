package io.gizu.storedwallet

import java.math.BigInteger
import org.json.JSONArray
import org.json.JSONObject

internal data class NativePayoutScan(val transactionHash: String?, val nextBlock: String)

private suspend fun payoutReference(rpc: TransferRpc, quote: JSONObject): BigInteger {
  check(quantity(rpc.text("eth_chainId")) == quote.getLong("destinationChainId").toBigInteger())
  val number = quote.getString("referenceBlock").toBigInteger()
  check(number.signum() >= 0)
  val reference =
    rpc.call("eth_getBlockByNumber", JSONArray().put("0x" + number.toString(16)).put(false))
      as JSONObject
  check(
    quantity(reference.getString("number")) == number &&
      earnHash(reference.getString("hash")) == earnHash(quote.getString("referenceHash"))
  )
  val destination = quote.getInt("destinationChainId")
  val token =
    if (quote.optString("leg") == "withdrawal") {
      check(destination == 143)
      io.gizu.storedwallet.swap.MainnetPortfolio.USDC
    } else if (destination == 1) ETH_EARN_USDC
    else {
      check(destination == 4663)
      HOOD_EARN_USDG
    }
  check(quote.getString("destinationToken").equals(token, true))
  return number
}

/** Like Swap, Robinhood payouts settle from canonical receipts; L1 finality trails ~17 minutes. */
private fun payoutAwaitsFinality(quote: JSONObject) = quote.getInt("destinationChainId") != 4663

private fun payoutTransfer(log: JSONObject, quote: JSONObject, event: String): BigInteger? {
  if (
    !log.getString("address").equals(quote.getString("destinationToken"), true) ||
      log.optBoolean("removed", false)
  )
    return null
  val topics = log.getJSONArray("topics")
  if (
    topics.length() != 3 ||
      !topics.getString(0).equals(event, true) ||
      !topics
        .getString(2)
        .equals("0x" + earnAddressWord(quote.getString("destinationRecipient")), true)
  )
    return null
  check(topics.getString(1).matches(Regex("0x[0-9a-fA-F]{64}")))
  val data = log.getString("data")
  check(data.matches(Regex("0x[0-9a-fA-F]{64}")))
  return data.substring(2).toBigInteger(16)
}

/** Finds a public receipt hint only. An aggregate token balance cannot establish delivery. */
internal suspend fun scanNativePayoutTransfers(
  rpc: TransferRpc,
  quote: JSONObject,
  start: String,
  topic: (String) -> String = ::earnEventTopic,
): NativePayoutScan = scanNativePayoutTransfersExcluding(rpc, quote, start, emptySet(), topic)

internal suspend fun scanNativePayoutTransfersExcluding(
  rpc: TransferRpc,
  quote: JSONObject,
  start: String,
  excludedTransactions: Set<String>,
  topic: (String) -> String = ::earnEventTopic,
): NativePayoutScan {
  val reference = payoutReference(rpc, quote)
  val from = start.toBigInteger()
  check(from > reference)
  val head =
    rpc.call(
      "eth_getBlockByNumber",
      JSONArray().put(if (payoutAwaitsFinality(quote)) "finalized" else "latest").put(false),
    ) as JSONObject
  val last = quantity(head.getString("number"))
  if (last < from) return NativePayoutScan(null, from.toString())
  val end = minOf(last, from + BigInteger.valueOf(4095))
  val event = topic("Transfer(address,address,uint256)")
  val filter =
    JSONObject()
      .put("address", quote.getString("destinationToken"))
      .put("fromBlock", "0x" + from.toString(16))
      .put("toBlock", "0x" + end.toString(16))
      .put(
        "topics",
        JSONArray()
          .put(event)
          .put(JSONObject.NULL)
          .put("0x" + earnAddressWord(quote.getString("destinationRecipient"))),
      )
  val logs = rpc.call("eth_getLogs", JSONArray().put(filter)) as JSONArray
  check(logs.length() <= 4096)
  val candidates =
    (0 until logs.length())
      .map(logs::getJSONObject)
      .filter { log ->
        val block = quantity(log.getString("blockNumber"))
        check(block in from..end)
        val amount = payoutTransfer(log, quote, event)
        val eventIdentity =
          earnHash(log.getString("transactionHash")) +
            ":" +
            (if (log.has("logIndex")) quantity(log.getString("logIndex")).toString() else "unknown")
        eventIdentity !in excludedTransactions &&
          amount != null &&
          amount >= quote.getString("minimumDestinationAtoms").toBigInteger() &&
          (!quote.has("maximumDestinationAtoms") ||
            amount <= quote.getString("maximumDestinationAtoms").toBigInteger())
      }
      .map { earnHash(it.getString("transactionHash")) }
      .filterNot { it in excludedTransactions }
      .distinct()
  check(candidates.size <= 1) { "Ambiguous payout receipts require authenticated reconciliation" }
  return NativePayoutScan(
    candidates.singleOrNull(),
    if (candidates.isEmpty()) (end + BigInteger.ONE).toString() else from.toString(),
  )
}

/**
 * Independently confirms the exact recipient/token/value in a canonical finalized receipt. The
 * engine also verifies the saved signed intent and successful route.
 */
internal suspend fun confirmNativePayoutReceipt(
  rpc: TransferRpc,
  quote: JSONObject,
  transactionHash: String,
  receivedAtoms: String,
  topic: (String) -> String = ::earnEventTopic,
): JSONObject {
  val reference = payoutReference(rpc, quote)
  val hash = earnHash(transactionHash)
  earnNumberWord(receivedAtoms)
  check(receivedAtoms.toBigInteger() >= quote.getString("minimumDestinationAtoms").toBigInteger())
  val receipt = rpc.call("eth_getTransactionReceipt", JSONArray().put(hash)) as JSONObject
  check(
    receipt.getString("status") == "0x1" && earnHash(receipt.getString("transactionHash")) == hash
  )
  val number = quantity(receipt.getString("blockNumber"))
  check(number > reference)
  val receiptHash = earnHash(receipt.getString("blockHash"))
  val blockNumber = "0x" + number.toString(16)
  val canonical =
    rpc.call("eth_getBlockByNumber", JSONArray().put(blockNumber).put(false)) as JSONObject
  check(
    quantity(canonical.getString("number")) == number &&
      earnHash(canonical.getString("hash")) == receiptHash
  )
  val timestamp = quantity(canonical.getString("timestamp")) * BigInteger.valueOf(1000)
  check(
    timestamp >=
      BigInteger.valueOf(quote.optLong("quoteCreatedAtMs", quote.getLong("observedAtMs")) - 1000)
  )
  if (payoutAwaitsFinality(quote)) {
    val final =
      rpc.call("eth_getBlockByNumber", JSONArray().put("finalized").put(false)) as JSONObject
    check(quantity(final.getString("number")) >= number)
  }
  val logs = receipt.getJSONArray("logs")
  check(logs.length() <= 4096)
  val event = topic("Transfer(address,address,uint256)")
  val transfers =
    (0 until logs.length()).map(logs::getJSONObject).mapNotNull { payoutTransfer(it, quote, event) }
  check(transfers.size == 1 && transfers.single() == receivedAtoms.toBigInteger())
  val checked =
    rpc.call("eth_getBlockByNumber", JSONArray().put(blockNumber).put(false)) as JSONObject
  check(
    quantity(checked.getString("number")) == number &&
      earnHash(checked.getString("hash")) == receiptHash
  )
  return JSONObject()
    .put("transactionHash", hash)
    .put("receivedAtoms", receivedAtoms)
    .put("blockNumber", number.toString())
    .put("blockHash", receiptHash)
}

/** Select all affected owned assets; minimum evidence never narrows the user's holdings. */
internal fun earnPrivateCreditInvalidationTargets(
  operation: JSONObject,
  proof: JSONObject,
): Pair<Long, Set<String>>? {
  if (proof.getString("status") !in setOf("credited", "minimumReceived")) return null
  if (proof.getString("status") == "minimumReceived")
    validateMinimumReturnReceipt(
      proof.toString(),
      sponsoredSettlementExpected(operation),
      operation.getJSONObject("proposal").getString("kind"),
      proof.getLong("timestampMs"),
    )
  check(proof.getBoolean("authenticated") && proof.getBoolean("operationScoped"))
  return when (operation.getJSONObject("proposal").getString("kind")) {
    "sourceFunding" -> 143L to setOf(io.gizu.storedwallet.swap.MainnetPortfolio.USDC, "native")
    "hoodTokenReturn" -> 4663L to setOf(HOOD_EARN_USDG, HOOD_EARN_VAULT, "native")
    "returnUsdc",
    "returnEth" -> 1L to setOf(ETH_EARN_USDC, ETH_EARN_VAULT, ETH_EARN_WETH, "native")
    else -> error("Unsupported authenticated private credit")
  }
}

/** Invalidate both sides before saving authenticated private evidence to avoid cache overlap. */
internal fun invalidateEarnPrivateCreditCaches(
  context: android.content.Context,
  record: WalletRecord,
  operation: JSONObject,
  proof: JSONObject,
) {
  val (chain, tokens) = earnPrivateCreditInvalidationTargets(operation, proof) ?: return
  if (chain == 143L) io.gizu.storedwallet.swap.MainnetPortfolio(context).invalidate(record)
  io.gizu.storedwallet.portfolio
    .NativeOwnedPortfolio(context)
    .invalidateTokens(record, chain, tokens)
  io.gizu.storedwallet.portfolio
    .NativeOwnedConfidentialPortfolio(context)
    .invalidateSources(
      record,
      setOf(operation.getJSONObject("proposal").getString("confidentialAccount")),
    )
}
