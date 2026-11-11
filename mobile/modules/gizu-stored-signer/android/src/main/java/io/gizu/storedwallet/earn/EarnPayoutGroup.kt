package io.gizu.storedwallet

import java.math.BigInteger
import org.json.JSONArray
import org.json.JSONObject

internal class EarnGroupRecoveryRequired :
  IllegalStateException("Saved payout receipt proof requires recovery reconciliation")

internal fun earnGroupCandidateSnapshot(proof: JSONObject): JSONObject =
  JSONObject()
    .put("groupScan", JSONArray(proof.getJSONArray("groupScan").toString()))
    .put(
      "candidateBlocks",
      JSONArray((proof.optJSONArray("candidateBlocks") ?: JSONArray()).toString()),
    )

/** Legacy standalone distributions retain their own engine; guided journeys own group delivery. */
internal fun isGuidedEarnPayout(row: JSONObject, journeys: List<JSONObject>): Boolean {
  if (row.has("groupId")) return true
  val p = row.getJSONObject("proposal")
  if (p.optInt("profileChainId") != 4663 || !p.has("distribution")) return false
  return journeys.any { journey ->
    val review = journey.optJSONObject("review") ?: return@any false
    review.optInt("cycleIndex", -1) == p.optInt("cycleIndex", 0) &&
      review.has("distribution") &&
      review.getJSONArray("sources").objects().any {
        it.getString("operationId") == p.getString("operationId")
      }
  }
}

/** Immutable journey membership only: quote refreshes and journal revisions are not identity. */
internal fun earnPayoutGroup(review: JSONObject): JSONObject {
  val distribution = review.getJSONObject("distribution")
  val deposits = depositReviewDeposits(review)
  check(deposits.size in 1..5)
  val recipients = deposits.map { it.getString("recipient").lowercase() }
  check(recipients.distinct().size == recipients.size)
  val sources = review.getJSONArray("sources").objects().sortedBy { it.getInt("accountIndex") }
  check(sources.isNotEmpty() && sources.size * recipients.size <= 256)
  val members =
    sources.flatMap { source ->
      recipients.mapIndexed { slot, recipient ->
        JSONObject()
          .put("operationId", source.getString("operationId"))
          .put("leg", "invest:$slot")
          .put("kind", if (source.optString("kind") == "private") "private" else "funded")
          .put("recipient", recipient)
      }
    }
  check(
    members.map { it.getString("operationId") + ":" + it.getString("leg") }.distinct().size ==
      members.size
  )
  return JSONObject()
    .put("version", 1)
    .put("journeyId", review.getString("journeyId"))
    .put("cycleIndex", review.getInt("cycleIndex"))
    .put("distribution", JSONObject(distribution.toString()))
    .put("recipients", JSONArray(recipients))
    .put("members", JSONArray(members))
}

internal fun earnPayoutGroupChildren(group: JSONObject, rows: List<JSONObject>): List<JSONObject?> =
  group.getJSONArray("members").objects().map { member ->
    rows
      .singleOrNull { row ->
        val p = row.getJSONObject("proposal")
        p.getString("operationId") == member.getString("operationId") &&
          p.getString("leg") == member.getString("leg") &&
          p.optInt("cycleIndex", 0) == group.getInt("cycleIndex")
      }
      ?.also { row ->
        val p = row.getJSONObject("proposal")
        check(
          p.getInt("profileChainId") == 4663 &&
            p.getString("expectedRecipient").equals(member.getString("recipient"), true)
        )
        check(nativeJsonEqual(p.getJSONObject("distribution"), group.getJSONObject("distribution")))
        check(
          (p.getString("kind") == "privateEarnPayout") == (member.getString("kind") == "private")
        )
      }
  }

/** Previously accepted source receipts stay exact; only pending allocation can take surplus. */
internal fun requireEarnGroupFixedReceipts(children: List<JSONObject>, proof: JSONObject) {
  for ((slot, evidence) in proof.getJSONArray("slots").objects().withIndex()) {
    val selected = children.filter { it.getString("leg") == "invest:$slot" }
    val paid = selected.filter { it.getString("status") == "paid" }
    val pending = selected.filter { it.getString("status") != "paid" }
    val fixedTotal =
      paid.fold(BigInteger.ZERO) { n, row ->
        n + depositAtoms(row.getString("receivedAtoms"), true)
      }
    val minimum =
      pending.fold(BigInteger.ZERO) { n, row ->
        n + depositAtoms(row.getJSONObject("proposal").getString("minimumDestinationAtoms"), true)
      }
    val total = depositAtoms(evidence.getString("receivedAtoms"), true)
    check(total >= fixedTotal + minimum)
    if (pending.isEmpty()) check(total == fixedTotal)
    val used = mutableSetOf<String>()
    for (row in paid) {
      check(!row.has("groupId")) { "Grouped paid children must reference their frozen group proof" }
      val old = row.getJSONObject("receipt")
      val tx = earnHash(old.getString("transactionHash"))
      val exact =
        evidence.getJSONArray("receipts").objects().single { event ->
          event.getString("transactionHash") == tx &&
            (!old.has("logIndex") || event.getInt("logIndex") == old.getInt("logIndex"))
        }
      check(used.add(tx + ":" + exact.getInt("logIndex")))
      check(exact.getString("receivedAtoms") == row.getString("receivedAtoms"))
      if (old.has("receivedAtoms"))
        check(old.getString("receivedAtoms") == exact.getString("receivedAtoms"))
      for (field in listOf("blockNumber", "blockHash")) if (old.has(field))
        check(old.getString(field) == exact.getString(field))
    }
  }
}

/**
 * Only saved sealed quotes and exact saved signed bytes are sent; no source attribution is made.
 */
internal class EarnPayoutGroupGateway(
  private val rpc: TransferRpc,
  private val owners: suspend () -> JSONArray,
  private val post: suspend (JSONObject) -> JSONObject = { request ->
    val text =
      NativeRpcTransport("$EARN_NATIVE_BACKEND/payout/group-status").post(request.toString())
    check(text.toByteArray().size <= 1024 * 1024)
    JSONObject(text)
  },
  private val topic: (String) -> String = ::earnEventTopic,
  private val now: () -> Long = System::currentTimeMillis,
  private val persistCandidates: suspend (JSONObject) -> Unit = {},
  private val beforeCandidatePost: suspend () -> Unit = {},
) {
  suspend fun status(
    group: JSONObject,
    children: List<JSONObject?>,
    initialSaved: JSONObject,
  ): JSONObject {
    if (initialSaved.optBoolean("recoveryRequired")) throw EarnGroupRecoveryRequired()
    var saved = JSONObject(initialSaved.toString())
    fun carry(result: JSONObject): JSONObject {
      for (field in
        listOf("candidateHistory", "replacementOf", "forkEvidence", "candidateBlocks")) if (
        saved.has(field)
      )
        result.put(field, saved.get(field))
      return result
    }
    val members = group.getJSONArray("members").objects()
    val count = group.getJSONArray("recipients").length()
    check(children.size == members.size && members.size in 1..256 && count in 1..5)
    val id = depositDigest(depositCanonical(group))
    val signed =
      JSONArray(
        children.mapIndexed { index, row ->
          if (row == null || !row.has("signedData")) JSONObject.NULL
          else {
            val p = row.getJSONObject("proposal")
            val prepared = JSONObject(row.getString("preparedText"))
            val signedIntent = JSONObject(row.getString("signedData"))
            val member = members[index]
            check(
              p.getString("operationId") == member.getString("operationId") &&
                p.getString("leg") == member.getString("leg") &&
                p.getString("expectedRecipient").equals(member.getString("recipient"), true)
            )
            check(
              signedIntent.getString("standard") == "erc191" &&
                signedIntent.getString("signature").isNotBlank() &&
                signedIntent.getString("payload") ==
                  prepared.getJSONObject("intent").getString("payload")
            )
            JSONObject()
              .put("recoveryEnvelope", prepared.getString("recoveryEnvelope"))
              .put("submittedIntent", signedIntent)
              .put("revision", p.getInt("revision"))
              .also { if (row.has("intentHash")) it.put("intentHash", row.getString("intentHash")) }
          }
        }
      )
    suspend fun request(hints: JSONArray): JSONObject {
      val auth = owners()
      check(auth.length() <= 128)
      val result =
        post(
          JSONObject()
            .put("group", group)
            .put("children", signed)
            .put("owners", auth)
            .put("destinationTransactionHashes", hints)
        )
      check(now() - result.getLong("observedAtMs") in -5000L..60000L)
      check(
        result.getString("groupId") == id &&
          result.getString("verification") == "signed-route-receipt-group-v1" &&
          result.getBoolean("authenticated") &&
          result.getBoolean("operationScoped")
      )
      check(result.getString("status") in setOf("pending", "awaitingReceipt", "paid"))
      val routes = result.getJSONArray("routes").objects()
      val indices = routes.map { it.getInt("index") }
      check(
        indices.size <= members.size &&
          indices.distinct().size == indices.size &&
          indices.all { it in members.indices }
      )
      if (result.getString("status") != "pending")
        check(
          children.all { it?.has("signedData") == true } &&
            routes.size == members.size &&
            routes.withIndex().all { (i, route) ->
              route.getInt("index") == i && route.getString("status") == "SUCCESS"
            }
        )
      return result
    }
    var result = request(JSONArray((0 until count).map { JSONArray() }))
    if (result.getString("status") == "pending") {
      if (saved.optBoolean("candidateFrozen"))
        result.put("candidateFrozen", true).put("groupScan", saved.getJSONArray("groupScan"))
      return carry(result)
    }
    // Paid requires the independent native scan/confirmation below; a paid empty-hint response
    // cannot substitute backend assertions for native canonical evidence.
    val rows = children.map { checkNotNull(it) }
    val anchors = linkedMapOf<String, JSONObject>()
    val references =
      (0 until count).map { slot ->
        rows
          .filter { it.getString("leg") == "invest:$slot" }
          .map { row ->
            val prepared = JSONObject(row.getString("preparedText"))
            val q = prepared.optJSONObject("quote") ?: prepared
            val p = row.getJSONObject("proposal")
            check(
              q.getInt("destinationChainId") == 4663 &&
                q.getString("destinationToken").equals(HOOD_EARN_USDG, true) &&
                q.getString("destinationRecipient")
                  .equals(p.getString("expectedRecipient"), true) &&
                q.getString("minimumDestinationAtoms") == p.getString("minimumDestinationAtoms")
            )
            val anchor =
              q.getString("referenceBlock") + ":" + earnHash(q.getString("referenceHash"))
            if (anchors.putIfAbsent(anchor, q) == null)
              groupReceiptReference(rpc, q, GroupReceiptChainPolicy.ROBINHOOD_CANONICAL)
            q
          }
          .let { quotes ->
            JSONObject(
                quotes
                  .minWith(
                    compareBy<JSONObject> { it.getString("referenceBlock").toBigInteger() }
                      .thenBy { it.optLong("quoteCreatedAtMs", it.getLong("observedAtMs")) }
                  )
                  .toString()
              )
              .put(
                "receiptObservedAtMs",
                quotes.minOf { it.optLong("quoteCreatedAtMs", it.getLong("observedAtMs")) },
              )
          }
      }
    if (saved.optBoolean("candidateFrozen")) {
      val forks = JSONArray()
      for (block in (saved.optJSONArray("candidateBlocks") ?: JSONArray()).objects()) {
        val number = block.getString("blockNumber").toBigInteger()
        val canonical =
          rpc.call("eth_getBlockByNumber", JSONArray().put("0x" + number.toString(16)).put(false))
            as? JSONObject ?: throw RpcFailure(RpcFailureCode.NETWORK)
        check(quantity(canonical.getString("number")) == number)
        val current = earnHash(canonical.getString("hash"))
        if (current != earnHash(block.getString("blockHash")))
          forks.put(
            JSONObject()
              .put("blockNumber", number.toString())
              .put("previousBlockHash", block.getString("blockHash"))
              .put("canonicalBlockHash", current)
          )
      }
      if (forks.length() > 0) {
        val original = earnGroupCandidateSnapshot(saved)
        val history = JSONArray((saved.optJSONArray("candidateHistory") ?: JSONArray()).toString())
        if (history.length() >= 8) throw EarnGroupRecoveryRequired()
        history.put(original)
        saved =
          JSONObject(saved.toString())
            .put("candidateHistory", history)
            .put("replacementOf", depositDigest(depositCanonical(original)))
            .put("forkEvidence", forks)
        saved.remove("candidateFrozen")
        saved.remove("groupScan")
        saved.remove("candidateBlocks")
      }
    }
    val scans = JSONArray()
    for (slot in 0 until count) {
      val previous = saved.optJSONArray("groupScan")?.optJSONObject(slot) ?: JSONObject()
      val selected = rows.filter { it.getString("leg") == "invest:$slot" }
      scans.put(
        if (saved.optBoolean("candidateFrozen")) {
          check(previous.getJSONArray("transactionHashes").length() in 1..128)
          JSONObject(previous.toString())
        } else if (selected.all { it.getString("status") == "paid" }) {
          JSONObject()
            .put(
              "transactionHashes",
              JSONArray(
                selected
                  .map { earnHash(it.getJSONObject("receipt").getString("transactionHash")) }
                  .distinct()
              ),
            )
            .put(
              "nextScanBlock",
              (references[slot].getString("referenceBlock").toBigInteger() + BigInteger.ONE)
                .toString(),
            )
            .put("complete", true)
        } else
          scanCashoutGroupReceipts(
            rpc,
            references[slot],
            previous,
            topic,
            GroupReceiptChainPolicy.ROBINHOOD_CANONICAL,
          )
      )
    }
    // A saved route may be old: sufficient canonical delivery can occur in the first page.
    // Unscanned later blocks cannot invalidate its exact events, fixed allocations or minima.
    // Independent confirmation below still must cover every source before any proof is frozen.
    val hints = JSONArray(scans.objects().map { it.getJSONArray("transactionHashes") })
    // The backend durably freezes its first sufficient receipt set. Establish the stronger
    // native fixed-paid-plus-pending minimum before sending any candidate that it can accept.
    val nativeSlots = JSONArray()
    val nativeEvents = mutableSetOf<String>()
    var sufficient = true
    for (slot in 0 until count) {
      val selected = rows.filter { it.getString("leg") == "invest:$slot" }
      val hashes = hints.getJSONArray(slot)
      val confirmed =
        (0 until hashes.length()).flatMap {
          confirmCashoutGroupReceipts(
            rpc,
            references[slot],
            hashes.getString(it),
            topic,
            GroupReceiptChainPolicy.ROBINHOOD_CANONICAL,
          )
        }
      for (event in confirmed) check(
        nativeEvents.add(event.getString("transactionHash") + ":" + event.getInt("logIndex")) &&
          nativeEvents.size <= 640
      )
      val total = confirmed.sumAtoms("receivedAtoms")
      val minimum =
        selected.fold(BigInteger.ZERO) { n, row ->
          n + depositAtoms(row.getJSONObject("proposal").getString("minimumDestinationAtoms"), true)
        }
      val required =
        selected.fold(BigInteger.ZERO) { n, row ->
          n +
            depositAtoms(
              if (row.getString("status") == "paid") row.getString("receivedAtoms")
              else row.getJSONObject("proposal").getString("minimumDestinationAtoms"),
              true,
            )
        }
      if (total.toBigInteger() < maxOf(required, minimum)) sufficient = false
      nativeSlots.put(
        JSONObject()
          .put("slot", slot)
          .put("destinationRecipient", group.getJSONArray("recipients").getString(slot))
          .put("minimumDestinationAtoms", minimum.toString())
          .put("receivedAtoms", total)
          .put("receipts", JSONArray(confirmed))
      )
    }
    if (!sufficient) {
      check(!saved.optBoolean("candidateFrozen")) { "Frozen receipt candidate changed" }
      result.remove("slots")
      return carry(result.put("status", "awaitingReceipt").put("groupScan", scans))
    }
    requireEarnGroupFixedReceipts(rows, JSONObject().put("slots", nativeSlots))
    val blocks = linkedMapOf<String, JSONObject>()
    for (slot in nativeSlots.objects()) for (event in slot.getJSONArray("receipts").objects()) {
      val number = event.getString("blockNumber")
      val block =
        JSONObject().put("blockNumber", number).put("blockHash", event.getString("blockHash"))
      val prior = blocks.putIfAbsent(number, block)
      check(prior == null || prior.getString("blockHash") == block.getString("blockHash"))
    }
    val candidateBlocks = JSONArray(blocks.values.toList())
    val candidate =
      carry(JSONObject(result.toString()))
        .put("status", "awaitingReceipt")
        .put("groupScan", scans)
        .put("candidateFrozen", true)
        .put("candidateBlocks", candidateBlocks)
    candidate.remove("slots")
    // A write failure prevents the backend from seeing a candidate. A lost HTTP response leaves
    // the exact candidate available after restart, before later gifts can alter the receipt set.
    if (!saved.optBoolean("candidateFrozen")) persistCandidates(candidate)
    beforeCandidatePost()
    try {
      result = request(hints)
    } catch (failure: EarnGatewayFailure) {
      if (failure.code != "EARN_COORDINATION_CONFLICT") throw failure
      val history = candidate.optJSONArray("candidateHistory") ?: JSONArray()
      val original =
        if (history.length() > 0) history.getJSONObject(0)
        else earnGroupCandidateSnapshot(candidate)
      val recovery =
        JSONObject(candidate.toString())
          .put("groupScan", original.getJSONArray("groupScan"))
          .put("candidateBlocks", original.getJSONArray("candidateBlocks"))
          .put("recoveryRequired", true)
          .put("rejectedCandidate", earnGroupCandidateSnapshot(candidate))
      persistCandidates(recovery)
      throw EarnGroupRecoveryRequired()
    }
    result.put("candidateBlocks", candidateBlocks)
    if (result.getString("status") == "paid") {
      val proofs = result.getJSONArray("slots").objects()
      check(proofs.size == count)
      val seen = mutableSetOf<String>()
      for ((slot, proof) in proofs.withIndex()) {
        check(
          proof.getInt("slot") == slot &&
            proof
              .getString("destinationRecipient")
              .equals(group.getJSONArray("recipients").getString(slot), true)
        )
        val minimum =
          rows
            .filter { it.getString("leg") == "invest:$slot" }
            .fold(BigInteger.ZERO) { sum, row ->
              sum +
                depositAtoms(
                  row.getJSONObject("proposal").getString("minimumDestinationAtoms"),
                  true,
                )
            }
        check(proof.getString("minimumDestinationAtoms") == minimum.toString())
        val hashes = hints.getJSONArray(slot)
        val confirmed =
          (0 until hashes.length()).flatMap {
            confirmCashoutGroupReceipts(
              rpc,
              references[slot],
              hashes.getString(it),
              topic,
              GroupReceiptChainPolicy.ROBINHOOD_CANONICAL,
            )
          }
        val reported = proof.getJSONArray("receipts").objects()
        check(reported.size == confirmed.size)
        for (receipt in reported) {
          val hash = earnHash(receipt.getString("transactionHash"))
          val index = receipt.getInt("logIndex")
          check(seen.add("$hash:$index") && seen.size <= 640)
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
        check(proof.getString("receivedAtoms") == total && total.toBigInteger() >= minimum)
      }
    }
    if (result.getString("status") == "paid") {
      requireEarnGroupFixedReceipts(rows, result)
      // Later saved source anchors must remain canonical too, including during the backend POST.
      for (anchor in anchors.values) groupReceiptReference(
        rpc,
        anchor,
        GroupReceiptChainPolicy.ROBINHOOD_CANONICAL,
      )
    }
    return carry(result.put("groupScan", scans).put("candidateFrozen", true))
  }
}
