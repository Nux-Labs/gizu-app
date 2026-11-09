package io.gizu.storedwallet

import java.math.BigInteger
import org.json.JSONArray
import org.json.JSONObject

/** Group confirmation observes public delivery only; it does not assign a transfer to a source. */
private suspend fun cashoutReference(rpc: TransferRpc, quote: JSONObject): BigInteger {
  check(quantity(rpc.text("eth_chainId")) == BigInteger.valueOf(143))
  check(
    quote.getInt("destinationChainId") == 143 &&
      quote
        .getString("destinationToken")
        .equals(io.gizu.storedwallet.swap.MainnetPortfolio.USDC, true)
  )
  val number = quote.getString("referenceBlock").toBigInteger()
  check(number.signum() >= 0)
  val block =
    rpc.call("eth_getBlockByNumber", JSONArray().put("0x" + number.toString(16)).put(false))
      as JSONObject
  check(
    quantity(block.getString("number")) == number &&
      earnHash(block.getString("hash")) == earnHash(quote.getString("referenceHash"))
  )
  return number
}

private fun cashoutTransfer(log: JSONObject, quote: JSONObject, topic: String): BigInteger? {
  if (
    !log.getString("address").equals(quote.getString("destinationToken"), true) ||
      log.optBoolean("removed")
  )
    return null
  val topics = log.getJSONArray("topics")
  if (
    topics.length() != 3 ||
      !topics.getString(0).equals(topic, true) ||
      !topics
        .getString(2)
        .equals("0x" + earnAddressWord(quote.getString("destinationRecipient")), true)
  )
    return null
  check(topics.getString(1).matches(Regex("0x[0-9a-fA-F]{64}")))
  val data = log.getString("data")
  check(data.matches(Regex("0x[0-9a-fA-F]{64}")))
  return data.removePrefix("0x").toBigInteger(16).takeIf { it.signum() > 0 }
}

internal suspend fun scanCashoutGroupReceipts(
  rpc: TransferRpc,
  quote: JSONObject,
  saved: JSONObject,
  topic: (String) -> String = ::earnEventTopic,
): JSONObject {
  val reference = cashoutReference(rpc, quote)
  val from =
    saved.optString("nextScanBlock", (reference + BigInteger.ONE).toString()).toBigInteger()
  check(from > reference)
  val head = rpc.call("eth_getBlockByNumber", JSONArray().put("finalized").put(false)) as JSONObject
  val last = quantity(head.getString("number"))
  val hashes = linkedSetOf<String>()
  saved.optJSONArray("transactionHashes")?.let { a ->
    for (i in 0 until a.length()) hashes.add(earnHash(a.getString(i)))
  }
  val end = minOf(last, from + BigInteger.valueOf(4095))
  if (from <= last) {
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
    for (log in logs.objects()) {
      check(quantity(log.getString("blockNumber")) in from..end)
      if (cashoutTransfer(log, quote, event) != null)
        hashes.add(earnHash(log.getString("transactionHash")))
    }
  }
  check(hashes.size <= 128) { "Too many public delivery receipts" }
  return JSONObject()
    .put("transactionHashes", JSONArray(hashes.toList()))
    .put("nextScanBlock", (if (from > last) from else end + BigInteger.ONE).toString())
    .put("complete", end == last || from > last)
}

internal suspend fun confirmCashoutGroupReceipts(
  rpc: TransferRpc,
  quote: JSONObject,
  transactionHash: String,
  topic: (String) -> String = ::earnEventTopic,
): List<JSONObject> {
  val reference = cashoutReference(rpc, quote)
  val hash = earnHash(transactionHash)
  val receipt = rpc.call("eth_getTransactionReceipt", JSONArray().put(hash)) as JSONObject
  check(
    receipt.getString("status") == "0x1" && earnHash(receipt.getString("transactionHash")) == hash
  )
  val number = quantity(receipt.getString("blockNumber"))
  check(number > reference)
  val blockHash = earnHash(receipt.getString("blockHash"))
  val blockTag = "0x" + number.toString(16)
  val block = rpc.call("eth_getBlockByNumber", JSONArray().put(blockTag).put(false)) as JSONObject
  check(
    quantity(block.getString("number")) == number && earnHash(block.getString("hash")) == blockHash
  )
  val timestamp = quantity(block.getString("timestamp")) * BigInteger.valueOf(1000)
  check(
    timestamp >=
      BigInteger.valueOf(
        quote.optLong("receiptObservedAtMs", quote.getLong("observedAtMs")) - 1000
      ) && timestamp <= BigInteger.valueOf(System.currentTimeMillis() + 5000)
  )
  val final =
    rpc.call("eth_getBlockByNumber", JSONArray().put("finalized").put(false)) as JSONObject
  check(quantity(final.getString("number")) >= number)
  val logs = receipt.getJSONArray("logs")
  check(logs.length() <= 4096)
  val event = topic("Transfer(address,address,uint256)")
  val seen = mutableSetOf<Int>()
  val result =
    logs.objects().mapNotNull { log ->
      val amount = cashoutTransfer(log, quote, event) ?: return@mapNotNull null
      check(
        earnHash(log.getString("transactionHash")) == hash &&
          quantity(log.getString("blockNumber")) == number &&
          earnHash(log.getString("blockHash")) == blockHash
      )
      val index = quantity(log.getString("logIndex")).intValueExact()
      check(index >= 0 && seen.add(index))
      JSONObject()
        .put("transactionHash", hash)
        .put("logIndex", index)
        .put("receivedAtoms", amount.toString())
        .put("blockNumber", number.toString())
        .put("blockHash", blockHash)
    }
  check(result.isNotEmpty())
  val checked = rpc.call("eth_getBlockByNumber", JSONArray().put(blockTag).put(false)) as JSONObject
  check(
    quantity(checked.getString("number")) == number &&
      earnHash(checked.getString("hash")) == blockHash
  )
  return result
}

/** Same schema-ordered, normalized commitment as backend cashout-group.ts. No native generation. */
internal fun cashoutGroupIdentity(group: JSONObject): String {
  fun str(value: String) = JSONObject.quote(value)
  fun obj(vararg fields: Pair<String, String>) =
    fields.joinToString(",", "{", "}") { str(it.first) + ":" + it.second }
  fun arr(values: List<String>) = values.joinToString(",", "[", "]")
  val plan = group.getJSONObject("plan")
  val p = plan.getJSONObject("proposal")
  val sources =
    arr(
      p.getJSONArray("sources").objects().map { source ->
        obj(
          "kind" to str(source.getString("kind")),
          "profileChainId" to source.getLong("profileChainId").toString(),
          "cycleIndex" to source.getLong("cycleIndex").toString(),
          "address" to str(source.getString("address").lowercase()),
          "amountAtoms" to str(source.getString("amountAtoms")),
        )
      }
    )
  fun ints(field: String): String {
    val a = p.getJSONArray(field)
    return arr((0 until a.length()).map { a.getLong(it).toString() })
  }
  val proposal =
    obj(
      "operationId" to str(p.getString("operationId")),
      "amountAtoms" to str(p.getString("amountAtoms")),
      "sources" to sources,
      "recipientIndices" to ints("recipientIndices"),
      "weightsBps" to ints("weightsBps"),
    )
  val children =
    arr(
      plan.getJSONArray("children").objects().map { child ->
        obj(
          "source" to child.getInt("source").toString(),
          "slot" to child.getInt("slot").toString(),
          "amountAtoms" to str(child.getString("amountAtoms")),
        )
      }
    )
  val recipients = group.getJSONArray("recipients")
  val canonical =
    obj(
      "plan" to obj("proposal" to proposal, "children" to children),
      "recipients" to
        arr((0 until recipients.length()).map { str(recipients.getString(it).lowercase()) }),
    )
  return java.security.MessageDigest.getInstance("SHA-256")
    .digest(("gizu-cashout-group:v1\u0000" + canonical).toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }
}
