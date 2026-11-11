package io.gizu.storedwallet

import org.json.JSONArray
import org.json.JSONObject

internal interface CashoutGateway {
  val groupedReceipts: Boolean
    get() = false

  suspend fun groupStatus(row: JSONObject, group: JSONObject): JSONObject =
    error("Group receipts unavailable")

  suspend fun prepareGroup(
    group: JSONObject,
    index: Int,
    source: JSONObject,
    anchor: String?,
  ): JSONObject {
    val child = group.getJSONObject("plan").getJSONArray("children").getJSONObject(index)
    return prepare(
      group.getJSONObject("plan").getJSONObject("proposal").getString("operationId") + "_" + index,
      source,
      group.getJSONArray("recipients").getString(child.getInt("slot")),
      child.getString("amountAtoms"),
    )
  }

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
    JSONObject(
      NativeRpcTransport(
          path,
          requestHeaders =
            if (route == "cashout")
              mapOf(
                "x-gizu-payout-proof" to
                  if (path.endsWith("group-prepare") || path.endsWith("group-status"))
                    "destination-receipt-group-v1"
                  else "destination-receipt-v1"
              )
            else emptyMap(),
        )
        .post(body.toString())
    )
  },
  private val eventTopic: (String) -> String = ::earnEventTopic,
  private val authBatch: suspend (List<JSONObject>) -> List<JSONObject> = { sources ->
    sources.map { auth(it) }
  },
  private val now: () -> Long = System::currentTimeMillis,
) : CashoutGateway {
  init {
    check(route in setOf("cashout", "private-funding"))
  }

  override val groupedReceipts: Boolean
    get() = route == "cashout"

  override suspend fun prepareGroup(
    group: JSONObject,
    index: Int,
    source: JSONObject,
    anchor: String?,
  ): JSONObject {
    check(route == "cashout")
    val body =
      JSONObject().put("group", group).put("childIndex", index).put("signedData", auth(source))
    if (anchor != null) body.put("anchor", anchor)
    return post("group-prepare", body).also {
      check(it.toString().toByteArray().size <= 262144)
      it.put("leg", "withdrawal")
    }
  }

  override suspend fun groupStatus(row: JSONObject, group: JSONObject): JSONObject {
    check(route == "cashout")
    val children = row.getJSONArray("children").objects()
    val sources =
      group.getJSONObject("plan").getJSONObject("proposal").getJSONArray("sources").objects()
    val signed =
      JSONArray(
        children.map { c ->
          if (!c.has("signedData")) JSONObject.NULL
          else
            JSONObject()
              .put(
                "recoveryEnvelope",
                JSONObject(c.getString("preparedText")).getString("recoveryEnvelope"),
              )
              .put("submittedIntent", JSONObject(c.getString("signedData")))
              .also { if (c.has("intentHash")) it.put("intentHash", c.getString("intentHash")) }
        }
      )
    suspend fun request(hints: JSONArray): JSONObject {
      val owners = JSONArray(authBatch(sources))
      check(owners.length() == sources.size)
      return post(
          "group-status",
          JSONObject()
            .put("group", group)
            .put("owners", owners)
            .put("children", signed)
            .put("destinationTransactionHashes", hints),
        )
        .also { result ->
          val receivedAt = now()
          check(receivedAt - result.getLong("observedAtMs") in -5000L..60000L)
          result.put("nativeReceivedAtMs", receivedAt)
        }
    }
    val slots = group.getJSONArray("recipients").length()
    // Check all route states first. Incomplete groups must still allow the unsigned work to
    // proceed.
    var result = request(JSONArray((0 until slots).map { JSONArray() }))
    if (result.getString("status") != "awaitingReceipt") {
      check(result.getString("status") == "pending")
      return result
    }
    check(children.all { it.has("signedData") })
    val references =
      (0 until slots).map { slot ->
        children
          .filter { it.getInt("slot") == slot }
          .map { JSONObject(it.getString("preparedText")) }
          .minBy { it.getString("referenceBlock").toBigInteger() }
      }
    // A completed legacy slot owns only its saved receipt events. Later ordinary deposits
    // belong to the receiving wallet balance, not this immutable withdrawal allocation.
    val fixedReceipts =
      (0 until slots).map { slot ->
        val selected = children.filter { it.getInt("slot") == slot }
        if (selected.all { it.optString("status") == "paid" })
          selected.map { child ->
            JSONObject(child.getJSONObject("receipt").toString())
              .put("receivedAtoms", child.getString("receivedAtoms"))
          }
        else null
      }
    val scans = JSONArray()
    for (slot in 0 until slots) {
      val fixed = fixedReceipts[slot]
      scans.put(
        if (fixed != null) {
          check(
            fixed
              .map { earnHash(it.getString("transactionHash")) + ":" + it.getInt("logIndex") }
              .toSet()
              .size == fixed.size
          )
          JSONObject()
            .put(
              "transactionHashes",
              JSONArray(fixed.map { earnHash(it.getString("transactionHash")) }.distinct()),
            )
            .put(
              "nextScanBlock",
              (references[slot].getString("referenceBlock").toBigInteger() +
                  java.math.BigInteger.ONE)
                .toString(),
            )
            .put("complete", true)
        } else
          scanCashoutGroupReceipts(
            rpc,
            references[slot],
            row.optJSONArray("groupScan")?.optJSONObject(slot) ?: JSONObject(),
            eventTopic,
          )
      )
    }
    if (scans.objects().any { !it.getBoolean("complete") }) return result.put("groupScan", scans)
    val hints = JSONArray(scans.objects().map { it.getJSONArray("transactionHashes") })
    result = request(hints)
    if (result.getString("status") == "paid") {
      check(
        result.getBoolean("authenticated") &&
          result.getBoolean("operationScoped") &&
          result.getString("verification") == "destination-receipt-group-v1"
      )
      val proofs = result.getJSONArray("slots").objects()
      check(proofs.size == slots)
      val allEvents = mutableSetOf<String>()
      for ((slot, proof) in proofs.withIndex()) {
        check(
          proof.getInt("slot") == slot &&
            proof
              .getString("destinationRecipient")
              .equals(group.getJSONArray("recipients").getString(slot), true)
        )
        val minimum =
          children.filter { it.getInt("slot") == slot }.sumAtoms("minimumDestinationAtoms")
        check(proof.getString("minimumDestinationAtoms") == minimum)
        val confirmed = mutableListOf<JSONObject>()
        val hashes = hints.getJSONArray(slot)
        for (i in 0 until hashes.length()) confirmed.addAll(
          confirmCashoutGroupReceipts(rpc, references[slot], hashes.getString(i), eventTopic)
        )
        fixedReceipts[slot]?.let { fixed ->
          check(confirmed.size == fixed.size)
          for (saved in fixed) {
            val exact =
              confirmed.single {
                it.getString("transactionHash") == earnHash(saved.getString("transactionHash")) &&
                  it.getInt("logIndex") == saved.getInt("logIndex")
              }
            check(exact.getString("receivedAtoms") == saved.getString("receivedAtoms"))
          }
        }
        val reported = proof.getJSONArray("receipts").objects()
        check(confirmed.size == reported.size)
        for (receipt in reported) {
          val hash = earnHash(receipt.getString("transactionHash"))
          val index = receipt.getInt("logIndex")
          check(allEvents.add("$hash:$index"))
          val exact =
            confirmed.single {
              it.getString("transactionHash") == hash && it.getInt("logIndex") == index
            }
          check(
            exact.getString("receivedAtoms") == receipt.getString("receivedAtoms") &&
              exact.getString("blockNumber") == receipt.getString("blockNumber") &&
              exact.getString("blockHash") == earnHash(receipt.getString("blockHash"))
          )
        }
        val total = confirmed.sumAtoms("receivedAtoms")
        check(
          proof.getString("receivedAtoms") == total &&
            total.toBigInteger() >= minimum.toBigInteger()
        )
      }
    } else check(result.getString("status") in setOf("pending", "awaitingReceipt"))
    return result.put("groupScan", scans)
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
      val reference = JSONObject(prepared.toString())
      if (result.optString("verification") in setOf("destination-receipt-v1", "signed-route-receipt-v1")) {
        check(result.getString("verification") == if (route == "cashout") "destination-receipt-v1" else "signed-route-receipt-v1")
        check(result.getString("receivedAtoms") == "0")
        check(
          result.getString("minimumDestinationAtoms") ==
            prepared.getString("minimumDestinationAtoms")
        )
        reference.remove("maximumDestinationAtoms")
      } else {
        reference
          .put("minimumDestinationAtoms", result.getString("receivedAtoms"))
          .put("maximumDestinationAtoms", result.getString("receivedAtoms"))
      }
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
          topic = eventTopic,
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
        topic = eventTopic,
      )
    }
    return result
  }
}

/** One salt read followed by fresh local read-only signatures avoids sequential RPC expiry. */
internal suspend fun <Salt> cashoutReadAuthentications(
  sources: List<JSONObject>,
  salt: suspend () -> Salt,
  sign: suspend (JSONObject, Salt) -> JSONObject,
  now: () -> Long = System::currentTimeMillis,
): List<JSONObject> {
  check(sources.size in 1..32)
  val freshSalt = salt()
  val started = now()
  val proofs = sources.map { sign(it, freshSalt) }
  check(now() - started in 0L..45000L) { "Refresh the read-only cashout owner proofs" }
  return proofs
}
