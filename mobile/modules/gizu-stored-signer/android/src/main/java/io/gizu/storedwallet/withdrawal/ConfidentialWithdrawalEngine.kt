package io.gizu.storedwallet

import io.gizu.storedwallet.portfolio.NativeConfidentialTarget
import java.math.BigInteger
import java.security.SecureRandom
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.*

/** Sources, receivers and weights originate only in native storage and authenticated reads. */
internal class ConfidentialWithdrawalEngine(
  private val store: WalletStore,
  val journal: ConfidentialWithdrawalJournal,
  private val gateway: CashoutGateway,
  private val read: suspend (JSONObject) -> Map<String, Any>,
  private val authority: () -> Unit,
  private val catalogue: (WalletRecord) -> List<NativeConfidentialTarget>,
  private val assertCanStart: (WalletRecord) -> Unit,
  private val invalidatePrivate: (WalletRecord, Set<String>) -> Unit,
) {
  private fun identity(r: WalletRecord) {
    check(r.verified && r.id == journal.wallet && r.journalId == journal.generation)
  }

  private fun sources(r: JSONObject) =
    r.getJSONObject("plan").getJSONObject("proposal").getJSONArray("sources").objects()

  private fun child(r: JSONObject, i: Int) = r.getJSONArray("children").getJSONObject(i)

  private fun update(r: JSONObject, action: (JSONObject) -> Unit) =
    journal.update(r.getString("operationId"), r.getInt("revision"), action)

  private fun invalidate(r: JSONObject) {
    store.load().use { record ->
      identity(record)
      invalidatePrivate(record, sources(r).map { it.getString("address") }.toSet())
    }
  }

  suspend fun prepare(amount: String): Map<String, Any> {
    check(
      amount.matches(Regex("[1-9][0-9]{0,19}")) &&
        amount.toBigInteger() <= BigInteger("18446744073709551615")
    ) {
      "Enter a supported exact private USDC budget"
    }
    var row = journal.active()
    if (row != null) {
      check(
        row.getJSONObject("plan").getJSONObject("proposal").getString("amountAtoms") == amount
      ) {
        "Resume the saved withdrawal before changing the amount"
      }
      if (
        row.getJSONArray("children").objects().any {
          it.has("signedData") || it.optBoolean("signingPending")
        }
      )
        return journal.public(row)
    } else {
      var remaining = amount.toBigInteger()
      val selected = JSONArray()
      val targets =
        store.load().use { r ->
          identity(r)
          assertCanStart(r)
          catalogue(r)
        }
      for (target in targets) {
        if (remaining == BigInteger.ZERO) break
        authority()
        currentCoroutineContext().ensureActive()
        val s =
          JSONObject()
            .put("kind", target.kind)
            .put("profileChainId", target.profileChainId)
            .put("cycleIndex", target.cycleIndex)
            .put("address", target.address)
        val balance = read(s)
        val available = balance.getValue("available").toString().toBigInteger()
        if (available > BigInteger.ZERO) {
          check(selected.length() < 32) { "This exact amount needs too many confidential sources" }
          val debit = available.min(remaining)
          selected.put(s.put("amountAtoms", debit.toString()))
          remaining -= debit
        }
      }
      check(remaining == BigInteger.ZERO) {
        "Insufficient fresh authenticated private USDC; public balances are not sources"
      }
      val random = ByteArray(32).also { SecureRandom().nextBytes(it) }
      val choice =
        try {
          chooseBuyLegs(amount, random)
        } finally {
          random.fill(0)
        }
      val plan =
        store.load().use { r ->
          identity(r)
          assertCanStart(r)
          val allocation = allocateSwapRecipientsN(r.roleRegistry, choice.count)
          check(JSONObject(allocation.registry).getInt("nextRecipient") <= 8192) {
            "Receiving wallet registry capacity reached"
          }
          store.persistRegistry(r.id, allocation.registry)
          JSONObject(
            confidentialWithdrawalPlan(
              JSONObject()
                .put("operationId", "cashout_" + UUID.randomUUID().toString().replace("-", ""))
                .put("amountAtoms", amount)
                .put("sources", selected)
                .put("recipientIndices", JSONArray(allocation.indices.map { it.toInt() }))
                .put("weightsBps", JSONArray(choice.weights.map { it.toInt() }))
                .toString()
            )
          )
        }
      row = journal.create(plan)
    }
    return journal.public(refreshUnsigned(checkNotNull(row)))
  }

  private fun group(row: JSONObject): JSONObject =
    store.load().use { record ->
      identity(record)
      val indices =
        row.getJSONObject("plan").getJSONObject("proposal").getJSONArray("recipientIndices")
      JSONObject()
        .put("plan", JSONObject(row.getJSONObject("plan").toString()))
        .put(
          "recipients",
          JSONArray(
            (0 until indices.length()).map { slot ->
              deriveAccountAddressRange(record.entropy, indices.getInt(slot).toUInt(), 1u).single()
            }
          ),
        )
    }

  private suspend fun refreshUnsigned(initial: JSONObject): JSONObject {
    var row = initial
    val sourceRows = sources(row)
    val deliveryGroup = if (gateway.groupedReceipts) group(row) else null
    val balances = mutableMapOf<Int, Map<String, Any>>()
    for ((index, s) in sourceRows.withIndex()) {
      val unsigned =
        row.getJSONArray("children").objects().filter {
          it.getInt("source") == index && !it.has("signedData")
        }
      if (unsigned.isEmpty()) continue
      check(unsigned.none { it.optBoolean("signingPending") }) {
        "Interrupted signing retains its saved quote; reconcile before refreshing"
      }
      authority()
      val b = read(s)
      check(
        b.getValue("available").toString().toBigInteger() >=
          unsigned.sumAtoms("amountAtoms").toBigInteger()
      ) {
        "Private source balance changed; the saved amount/distribution was not changed"
      }
      balances[index] = b
    }
    for (i in 0 until row.getJSONArray("children").length()) {
      val c = child(row, i)
      if (c.has("signedData")) continue
      authority()
      currentCoroutineContext().ensureActive()
      val existing = c.optString("preparedText").takeIf { it.isNotBlank() }?.let(::JSONObject)
      if (
        existing != null &&
          c.optString("status") == "review" &&
          c.getString("minimumDestinationAtoms").toBigInteger() > BigInteger.ZERO &&
          existing.optLong("expiresAtMs") > System.currentTimeMillis() + 15000L
      ) {
        row =
          update(row) {
            child(it, i).put("balanceProof", JSONObject(balances.getValue(c.getInt("source"))))
          }
        continue
      }
      val receiver =
        store.load().use { r ->
          identity(r)
          deriveAccountAddressRange(
              r.entropy,
              row
                .getJSONObject("plan")
                .getJSONObject("proposal")
                .getJSONArray("recipientIndices")
                .getInt(c.getInt("slot"))
                .toUInt(),
              1u,
            )
            .single()
        }
      val prepared =
        if (deliveryGroup != null)
          gateway.prepareGroup(
            deliveryGroup,
            i,
            sourceRows[c.getInt("source")],
            row
              .getJSONArray("children")
              .objects()
              .firstOrNull { it.getInt("slot") == c.getInt("slot") && it.has("preparedText") }
              ?.let { JSONObject(it.getString("preparedText")).getString("recoveryEnvelope") },
          )
        else
          gateway.prepare(
            row.getString("operationId") + "_" + i,
            sourceRows[c.getInt("source")],
            receiver,
            c.getString("amountAtoms"),
          )
      val payload = prepared.getJSONObject("intent").getString("payload")
      val nonce = JSONObject(payload).getString("nonce")
      journal.assertFreshNonce(
        sourceRows[c.getInt("source")].getString("address"),
        nonce,
        row.getString("operationId"),
        i,
      )
      check(
        row
          .getJSONArray("children")
          .objects()
          .filterIndexed { index, _ -> index != i }
          .none { it.optString("nonce") == nonce && it.getInt("source") == c.getInt("source") }
      ) {
        "Provider reused a reserved nonce"
      }
      row =
        update(row) { r ->
          child(r, i)
            .put("preparedText", prepared.toString())
            .put("minimumDestinationAtoms", prepared.getString("minimumDestinationAtoms"))
            .put("balanceProof", JSONObject(balances.getValue(c.getInt("source"))))
            .put("nonce", nonce)
            .put("payloadHash", utf8EarnHash(payload))
            .put(
              "reservationId",
              "0x" +
                ByteArray(32)
                  .also { SecureRandom().nextBytes(it) }
                  .joinToString("") { "%02x".format(it) },
            )
            .put("status", "needsReview")
            .put("minimumDestinationAtoms", "0")
            .put(
              "nonceHistory",
              (child(r, i).optJSONArray("nonceHistory") ?: JSONArray()).put(nonce),
            )
        }
      val candidate = child(row, i)
      store.load().use { record ->
        identity(record)
        ConfidentialWithdrawalOperation(
            row.getJSONObject("plan").toString(),
            i.toUInt(),
            record.entropy,
            record.roleRegistry,
          )
          .use { core ->
            core.prepare(
              candidate.getString("preparedText"),
              candidate.getJSONObject("balanceProof").toString(),
              evidence(candidate),
            )
          }
      }
      row =
        update(row) {
          child(it, i)
            .put("status", "review")
            .put("minimumDestinationAtoms", prepared.getString("minimumDestinationAtoms"))
        }
    }
    return row
  }

  private fun usdc(atoms: Any?) =
    java.math.BigDecimal(atoms.toString().toBigInteger(), 6).toPlainString()

  private fun evidence(c: JSONObject) =
    JSONObject()
      .put("nonce", c.getString("nonce"))
      .put("payloadHash", c.getString("payloadHash"))
      .put("reservationId", c.getString("reservationId"))
      .put("reservedAtoms", c.getString("amountAtoms"))
      .put("unresolved", false)
      .toString()

  suspend fun execute(
    id: String,
    revision: Int,
    approve: suspend (String, String) -> Unit,
  ): Map<String, Any> {
    var row = journal.get(id)
    check(row.getInt("revision") == revision) { "Stale withdrawal revision" }
    check(!row.optBoolean("cancelled"))
    if (row.getJSONArray("children").objects().all { it.getString("status") == "paid" })
      return journal.public(row)
    // Submit is strictly after signedData's durable write. A local signing marker
    // without signedData proves that no request could have carried that signature.
    if (
      row.getJSONArray("children").objects().any {
        it.optBoolean("signingPending") && !it.has("signedData")
      }
    )
      row =
        update(row) { r ->
          r.getJSONArray("children")
            .objects()
            .filter { it.optBoolean("signingPending") && !it.has("signedData") }
            .forEach { it.put("signingPending", false).put("status", "needsReview") }
        }
    if (gateway.groupedReceipts) {
      if (row.getJSONArray("children").objects().any { it.has("signedData") })
        row = reconcileGroup(row)
    } else
      for (i in 0 until row.getJSONArray("children").length()) if (
        child(row, i).has("signedData") && child(row, i).getString("status") != "paid"
      )
        row = reconcile(row, i)
    if (row.getJSONArray("children").objects().all { it.getString("status") == "paid" })
      return journal.public(row)
    if (row.getJSONArray("children").objects().any { !it.has("signedData") })
      row = refreshUnsigned(row)
    val signers = mutableMapOf<Int, ConfidentialWithdrawalOperation>()
    val texts = mutableListOf<String>()
    val hashes = mutableListOf<String>()
    try {
      for (i in 0 until row.getJSONArray("children").length()) {
        val c = child(row, i)
        if (
          c.getString("status") == "paid" ||
            (gateway.groupedReceipts && c.optBoolean("routeSucceeded"))
        )
          continue
        if (c.has("signedData")) {
          texts.add(
            "Retry only the saved signed child ${i+1}: ${c.getString("amountAtoms")} input atoms. The original route was checked; rebroadcast is identical bytes."
          )
          hashes.add(c.getString("payloadHash"))
          continue
        }
        val signer =
          store.load().use { r ->
            identity(r)
            ConfidentialWithdrawalOperation(
              row.getJSONObject("plan").toString(),
              i.toUInt(),
              r.entropy,
              r.roleRegistry,
            )
          }
        signers[i] = signer
        texts.add(
          signer.prepare(
            c.getString("preparedText"),
            c.getJSONObject("balanceProof").toString(),
            evidence(c),
          )
        )
        hashes.add(signer.reviewHash())
      }
      if (texts.isEmpty()) return journal.public(row)
      val view = journal.public(row)
      val receiverSummary =
        (view["payouts"] as List<*>).joinToString("\n") { p ->
          val payout = p as Map<*, *>
          "Receiving wallet ${(payout["slot"] as Int)+1}: input ${usdc(payout["amountAtoms"])} USDC; at least ${usdc(payout["minimumDestinationAtoms"])} USDC net"
        }
      val deduction =
        (view["amountAtoms"].toString().toBigInteger() -
            view["minimumDestinationAtoms"].toString().toBigInteger())
          .toString()
      val review =
        "WITHDRAW FROM GIZU\nExact private input ${usdc(view["amountAtoms"])} USDC (${view["amountAtoms"]} atoms), including all route fees\nGuaranteed net output at least ${usdc(view["minimumDestinationAtoms"])} USDC (${view["minimumDestinationAtoms"]} atoms)\nMaximum fees/route deduction ${usdc(deduction)} USDC\n${view["walletCount"]} fresh receiving wallets; ${sources(row).size} private sources\n$receiverSummary\n" +
          texts.joinToString("\n\n")
      approve(review, utf8EarnHash(row.getJSONObject("plan").toString() + hashes.joinToString("|")))
      authority()
      currentCoroutineContext().ensureActive()
      for (i in 0 until row.getJSONArray("children").length()) {
        var c = child(row, i)
        if (
          c.getString("status") == "paid" ||
            (gateway.groupedReceipts && c.optBoolean("routeSucceeded"))
        )
          continue
        authority()
        store.load().use { identity(it) }
        currentCoroutineContext().ensureActive()
        if (!c.has("signedData")) {
          val signer = signers.getValue(i)
          signer.approve(signer.reviewHash())
          val remaining =
            row
              .getJSONArray("children")
              .objects()
              .filter { it.getInt("source") == c.getInt("source") && !it.has("signedData") }
              .sumAtoms("amountAtoms")
              .toBigInteger()
          val fresh = read(sources(row)[c.getInt("source")])
          check(fresh.getValue("available").toString().toBigInteger() >= remaining) {
            "Private funds changed during approval; no additional child was signed"
          }
          val j = evidence(c)
          invalidate(row)
          row = update(row) { child(it, i).put("signingPending", true) }
          val signed = signer.sign(j)
          // No suspension or cancellation check between signing and the durable write.
          row =
            update(row) {
              child(it, i)
                .put("signedData", signed)
                .put("signingPending", false)
                .put("status", "unknown")
            }
        }
        c = child(row, i)
        invalidate(row)
        authority()
        currentCoroutineContext().ensureActive()
        try {
          val response = gateway.submit(c.getString("signedData"))
          row =
            update(row) { r ->
              val u = child(r, i)
              if (response.has("intentHash")) u.put("intentHash", response.getString("intentHash"))
              u.put("status", "pending")
            }
        } catch (cancelled: CancellationException) {
          throw cancelled
        } catch (_: Exception) {
          return journal.public(row)
        }
        if (!gateway.groupedReceipts) {
          row = reconcile(row, i)
          if (child(row, i).getString("status") != "paid") return journal.public(row)
        }
      }
      if (gateway.groupedReceipts) row = reconcileGroup(row)
      return journal.public(row)
    } finally {
      signers.values.forEach {
        it.invalidate()
        it.close()
      }
    }
  }

  private suspend fun reconcileGroup(row: JSONObject): JSONObject {
    authority()
    invalidate(row)
    val deliveryGroup = group(row)
    val requestedAt = System.currentTimeMillis()
    val result = gateway.groupStatus(row, deliveryGroup)
    check(
      result.getBoolean("authenticated") &&
        result.getBoolean("operationScoped") &&
        result.getString("operationId") == row.getString("operationId") &&
        result.getString("verification") == "destination-receipt-group-v1" &&
        result.getString("groupId") == cashoutGroupIdentity(deliveryGroup)
    )
    // This timestamp is set by the native gateway immediately when the response arrives,
    // before potentially slow canonical receipt reads; it is never accepted from the server.
    val receivedAt = result.getLong("nativeReceivedAtMs")
    check(receivedAt in requestedAt..System.currentTimeMillis())
    check(receivedAt - result.getLong("observedAtMs") in -5000L..60000L)
    val children = row.getJSONArray("children").objects()
    val routes = result.getJSONArray("routes").objects()
    check(routes.map { it.getInt("index") }.toSet().size == routes.size)
    check(
      routes.map { it.getInt("index") }.toSet() ==
        children.indices.filter { children[it].has("signedData") }.toSet()
    )
    check(
      routes.all {
        it.getString("status") in
          setOf(
            "SUCCESS",
            "KNOWN_DEPOSIT_TX",
            "PENDING_DEPOSIT",
            "INCOMPLETE_DEPOSIT",
            "PROCESSING",
          )
      }
    )
    val allocations = mutableMapOf<Int, String>()
    if (result.getString("status") == "paid") {
      check(
        children.all { it.has("signedData") } && routes.all { it.getString("status") == "SUCCESS" }
      )
      val slots = result.getJSONArray("slots").objects()
      check(slots.size == deliveryGroup.getJSONArray("recipients").length())
      val events = mutableSetOf<String>()
      for ((slot, proof) in slots.withIndex()) {
        check(
          proof.getInt("slot") == slot &&
            proof
              .getString("destinationRecipient")
              .equals(deliveryGroup.getJSONArray("recipients").getString(slot), true)
        )
        val indices = children.indices.filter { children[it].getInt("slot") == slot }
        val selected = indices.map { children[it] }
        check(
          proof.getString("minimumDestinationAtoms") == selected.sumAtoms("minimumDestinationAtoms")
        )
        val receipts = proof.getJSONArray("receipts").objects()
        for (receipt in receipts) check(
          events.add(
            earnHash(receipt.getString("transactionHash")) + ":" + receipt.getInt("logIndex")
          )
        )
        val total = proof.getString("receivedAtoms").toBigInteger()
        check(total == receipts.sumAtoms("receivedAtoms").toBigInteger())
        val paid = selected.filter { it.getString("status") == "paid" }
        for (c in paid) c.optJSONObject("receipt")?.let { saved ->
          check(
            receipts.any {
              earnHash(it.getString("transactionHash")) ==
                earnHash(saved.getString("transactionHash")) &&
                it.getInt("logIndex") == saved.getInt("logIndex") &&
                it.getString("receivedAtoms") == c.getString("receivedAtoms")
            }
          )
        }
        val unpaid = indices.filter { children[it].getString("status") != "paid" }
        val fixed = paid.sumAtoms("receivedAtoms").toBigInteger()
        val minimum = unpaid.map { children[it] }.sumAtoms("minimumDestinationAtoms").toBigInteger()
        check(total >= fixed + minimum)
        if (unpaid.isEmpty()) check(total == fixed)
        for ((position, index) in unpaid.withIndex()) allocations[index] =
          (children[index].getString("minimumDestinationAtoms").toBigInteger() +
              if (position == unpaid.lastIndex) total - fixed - minimum else BigInteger.ZERO)
            .toString()
      }
    } else check(result.getString("status") in setOf("pending", "awaitingReceipt"))
    val updated =
      update(row) { r ->
        if (result.has("groupScan")) r.put("groupScan", result.getJSONArray("groupScan"))
        for (route in routes) {
          val c = child(r, route.getInt("index"))
          if (c.getString("status") != "paid") {
            c.put("routeSucceeded", route.getString("status") == "SUCCESS")
            if (route.getString("status") == "SUCCESS" || c.getString("status") != "unknown")
              c.put("status", "pending")
          }
        }
        if (result.getString("status") == "paid") {
          r.put("groupReceipt", result)
          for ((index, amount) in allocations) child(r, index)
            .put("status", "paid")
            .put("receivedAtoms", amount)
            .put("deliveryGroupId", result.getString("groupId"))
        }
      }
    invalidate(updated)
    return updated
  }

  private suspend fun reconcile(row: JSONObject, i: Int): JSONObject {
    val c = child(row, i)
    authority()
    invalidate(row)
    val used =
      row
        .getJSONArray("children")
        .objects()
        .filter { it.getString("status") == "paid" }
        .mapNotNull {
          it.optJSONObject("receipt")?.let { receipt ->
            receipt.getString("transactionHash") + ":" + receipt.getInt("logIndex")
          }
        }
        .toSet()
    val result = gateway.status(c, sources(row)[c.getInt("source")], used)
    val prepared = JSONObject(c.getString("preparedText"))
    check(
      result.getBoolean("authenticated") &&
        result.getBoolean("operationScoped") &&
        result.getString("operationId") == prepared.getString("operationId") &&
        result
          .getString("confidentialAccount")
          .equals(prepared.getString("confidentialAccount"), true) &&
        result
          .getString("destinationRecipient")
          .equals(prepared.getString("destinationRecipient"), true) &&
        result.getString("amountAtoms") == c.getString("amountAtoms") &&
        result.getString("minimumDestinationAtoms") == c.getString("minimumDestinationAtoms")
    )
    check(System.currentTimeMillis() - result.getLong("observedAtMs") in -5000L..60000L)
    val updated =
      update(row) { r ->
        val u = child(r, i)
        if (result.optString("status") == "paid") {
          check(
            result.getString("receivedAtoms").toBigInteger() >=
              c.getString("minimumDestinationAtoms").toBigInteger()
          )
          u.put("status", "paid")
            .put("receivedAtoms", result.getString("receivedAtoms"))
            .put("receipt", result.getJSONObject("receipt"))
        } else {
          check(result.optString("status") in setOf("pending", "awaitingReceipt"))
          u.put("status", if (c.getString("status") == "unknown") "unknown" else "pending")
          if (result.has("nextScanBlock")) u.put("nextScanBlock", result.getString("nextScanBlock"))
        }
      }
    invalidate(updated)
    return updated
  }
}
