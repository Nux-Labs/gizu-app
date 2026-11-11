package io.gizu.storedwallet

import java.math.BigInteger
import java.security.SecureRandom
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.PrivateEarnPayoutOperation

internal interface PrivateEarnSigner : AutoCloseable {
  fun prepare(prepared: String, balance: String, evidence: String): String

  fun reviewHash(): String

  fun approve(hash: String)

  fun sign(evidence: String): String
}

private class RustPrivateEarnSigner(proposal: String, entropy: ByteArray) : PrivateEarnSigner {
  private val operation = PrivateEarnPayoutOperation(proposal, entropy)

  override fun prepare(prepared: String, balance: String, evidence: String) =
    operation.prepare(prepared, balance, evidence)

  override fun reviewHash() = operation.reviewHash()

  override fun approve(hash: String) = operation.approve(hash)

  override fun sign(evidence: String) = operation.sign(evidence)

  override fun close() {
    operation.invalidate()
    operation.close()
  }
}

/** Existing private funds have their own proof type; they never masquerade as public credit. */
internal class EarnPrivatePayoutEngine(
  private val store: WalletStore,
  private val journal: EarnPayoutJournal,
  private val gateway: CashoutGateway,
  private val read: suspend (JSONObject) -> Map<String, Any>,
  private val authority: () -> Unit,
  private val invalidate: (WalletRecord, Set<String>) -> Unit,
  private val signerFactory: (String, ByteArray) -> PrivateEarnSigner = ::RustPrivateEarnSigner,
) {
  private fun identity(record: WalletRecord) {
    check(
      record.verified && record.id == journal.walletId && record.journalId == journal.generation
    )
  }

  private fun evidence(row: JSONObject): String =
    JSONObject()
      .put("nonce", row.getString("nonce"))
      .put("payloadHash", row.getString("payloadHash"))
      .put("reservationId", row.getString("reservationId"))
      .put("reservedAtoms", row.getJSONObject("proposal").getString("amountAtoms"))
      .put("unresolved", false)
      .toString()

  suspend fun create(review: JSONObject, sourceId: String, leg: String): JSONObject {
    authority()
    val original =
      review.getJSONArray("fundingRows").objects().single {
        it.getString("operationId") == sourceId
      }
    check(isPrivateDepositSource(original))
    val source = original.getJSONObject("proposal").getJSONObject("source")
    val boundSource =
      review.getJSONArray("sources").objects().single { it.getString("operationId") == sourceId }
    val distribution = review.getJSONObject("distribution")
    val slot = distributionSlot(leg, distribution)
    val bound = depositReviewBound(boundSource, leg, review)
    val offset =
      review
        .getJSONArray("sources")
        .objects()
        .filter { it.getInt("accountIndex") < boundSource.getInt("accountIndex") }
        .fold(BigInteger.ZERO) { sum, row -> sum + depositAtoms(row.getString("amountAtoms")) }
        .toString()
    val prepared =
      gateway.prepare(
        sourceId + "_" + slot,
        source,
        bound.getString("recipient"),
        bound.getString("inputAtoms"),
      )
    check(
      depositAtoms(prepared.getString("minimumDestinationAtoms"), true) >=
        depositAtoms(bound.getString("minimumOutputAtoms"), true)
    )
    val p =
      JSONObject()
        .put("kind", "privateEarnPayout")
        .put("operationId", sourceId)
        .put("revision", 1)
        .put("profileChainId", 4663)
        .put("cycleIndex", review.getInt("cycleIndex"))
        .put("distribution", distribution)
        .put("leg", leg)
        .put("source", source)
        .put("splitOffsetAtoms", offset)
        .put("creditedAtoms", source.getString("amountAtoms"))
        .put("amountAtoms", bound.getString("inputAtoms"))
        .put("expectedSigner", source.getString("address"))
        .put("expectedRecipient", bound.getString("recipient"))
        .put("minimumDestinationAtoms", prepared.getString("minimumDestinationAtoms"))
        .put("deadlineMs", prepared.getLong("expiresAtMs"))
    val payload = prepared.getJSONObject("intent").getString("payload")
    return journal.create(
      p,
      prepared.toString(),
      JSONObject(payload).getString("nonce"),
      utf8EarnHash(payload),
      "0x" +
        ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) },
    )
  }

  private suspend fun refreshUnsigned(initial: JSONObject, review: JSONObject): JSONObject {
    var row = initial
    check(!row.has("signedData"))
    if (row.optBoolean("signingAuthorizationPending")) {
      // This engine cannot submit until saveSigned's equivalent atomic update has returned.
      // A marker without saved bytes therefore never reached gateway.submit. The native host
      // excludes concurrent executions; a fresh bounded grant may safely resume this local work.
      row =
        journal.update(row.getString("operationId"), row.getString("leg"), row.getInt("revision")) {
          it.remove("signingAuthorizationPending")
        }
    }
    val p = row.getJSONObject("proposal")
    val sourceBound =
      review.getJSONArray("sources").objects().single {
        it.getString("operationId") == p.getString("operationId")
      }
    val reviewedMinimum =
      depositReviewBound(sourceBound, p.getString("leg"), review).getString("minimumOutputAtoms")
    if (
      p.getLong("deadlineMs") > System.currentTimeMillis() + 15000 &&
        row.getString("status") == "planned" &&
        depositAtoms(p.getString("minimumDestinationAtoms")) >= depositAtoms(reviewedMinimum)
    )
      return row
    authority()
    val slot = distributionSlot(p.getString("leg"), p.getJSONObject("distribution"))
    val prepared =
      gateway.prepare(
        p.getString("operationId") + "_" + slot,
        p.getJSONObject("source"),
        p.getString("expectedRecipient"),
        p.getString("amountAtoms"),
      )
    // A refreshed quote may improve the minimum but cannot reduce the already reviewed floor.
    check(
      depositAtoms(prepared.getString("minimumDestinationAtoms"), true) >=
        depositAtoms(reviewedMinimum, true)
    )
    val proposal =
      JSONObject(p.toString())
        .put("deadlineMs", prepared.getLong("expiresAtMs"))
        .put("minimumDestinationAtoms", prepared.getString("minimumDestinationAtoms"))
    val payload = prepared.getJSONObject("intent").getString("payload")
    row =
      journal.refreshUnsigned(
        row.getString("operationId"),
        row.getInt("revision"),
        proposal,
        prepared.toString(),
        JSONObject(payload).getString("nonce"),
        utf8EarnHash(payload),
      )
    return row
  }

  suspend fun execute(
    id: String,
    grant: EarnDepositApproval,
    preparedAuthority: (JSONObject, JSONObject) -> Unit,
  ) {
    authority()
    var row = journal.get(id)
    if (!row.has("signedData")) {
      row = refreshUnsigned(row, grant.review)
      val p = row.getJSONObject("proposal")
      val balance = JSONObject(read(p.getJSONObject("source")))
      // All remaining unsigned siblings share this account; reserve their entire outstanding input.
      val signed =
        journal
          .all()
          .filter {
            it.getJSONObject("proposal").getString("operationId") == p.getString("operationId") &&
              it.has("signedData")
          }
          .fold(BigInteger.ZERO) { sum, child ->
            sum + depositAtoms(child.getJSONObject("proposal").getString("amountAtoms"), true)
          }
      val remaining = depositAtoms(p.getString("creditedAtoms"), true) - signed
      requireAvailableFunds(depositAtoms(balance.getString("available")), remaining)
      val proof = evidence(row)
      val record = store.load()
      record.use { r ->
        identity(r)
        grant.assertRead(r, System.currentTimeMillis())
        val signer = signerFactory(p.toString(), r.entropy)
        try {
          val text = signer.prepare(row.getString("preparedText"), balance.toString(), proof)
          val hash = signer.reviewHash()
          requireDistributionPayoutSigningStorage(
            row,
            JSONObject(row.getString("preparedText")).getJSONObject("intent").getString("payload"),
            text,
            hash,
          )
          val witness =
            JSONObject()
              .put("hash", hash)
              .put("text", text)
              .put(
                "providerFeeBps",
                privateFundingFeeBps(JSONObject(row.getString("preparedText"))),
              )
          authority()
          preparedAuthority(row, witness)
          row =
            journal.update(id, p.getString("leg"), row.getInt("revision")) {
              it.put("signingAuthorizationPending", true)
            }
          // This marker is durable before the signing call. An interrupted signature cannot reroll.
          signer.approve(hash)
          val signed = signer.sign(proof)
          row =
            journal.update(id, p.getString("leg"), row.getInt("revision")) {
              it
                .put("signedData", signed)
                .put("review", text)
                .put("reviewHash", hash)
                .put("status", "submissionUnknown")
                .remove("signingAuthorizationPending")
            }
          grant.recordDurableSignature("payouts", id, depositDigest(signed))
          invalidate(r, setOf(p.getString("expectedSigner")))
        } finally {
          signer.close()
        }
      }
    } else {
      // Never replace a saved signature with a freshly quoted payload.
      authority()
      val witness =
        JSONObject()
          .put("hash", row.getString("reviewHash"))
          .put("text", row.getString("review"))
          .put("providerFeeBps", privateFundingFeeBps(JSONObject(row.getString("preparedText"))))
      preparedAuthority(row, witness)
    }
    currentCoroutineContext().ensureActive()
    authority()
    try {
      val submitted = gateway.submit(row.getString("signedData"))
      requireDistributionPayoutResponseStorage(
        row.getJSONObject("proposal"),
        "submission",
        submitted,
      )
      journal.update(id, row.getString("leg"), row.getInt("revision")) {
        it.put("submission", submitted).put("status", "submitted")
        if (submitted.has("intentHash")) it.put("intentHash", submitted.getString("intentHash"))
      }
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: Exception) {
      /* The saved signature remains reserved for reconciliation. */
    }
  }

  suspend fun reconcile(id: String): JSONObject {
    var row = journal.get(id)
    if (!row.has("signedData") || row.getString("status") == "paid") return row
    if (row.getJSONObject("proposal").has("distribution")) return row
    authority()
    val used =
      journal
        .all()
        .filter { it.getString("status") == "paid" && it.has("destinationTransactionHash") }
        .map { it.getString("destinationTransactionHash") }
        .toSet()
    val result = gateway.status(row, row.getJSONObject("proposal").getJSONObject("source"), used)
    requireDistributionPayoutResponseStorage(row.getJSONObject("proposal"), "settlement", result)
    row =
      journal.update(id, row.getString("leg"), row.getInt("revision")) {
        it.put("settlement", result)
        if (result.has("nextScanBlock")) it.put("nextScanBlock", result.getString("nextScanBlock"))
        if (result.has("intentHash")) it.put("intentHash", result.getString("intentHash"))
        if (result.optString("status") == "paid") {
          val receipt = result.getJSONObject("receipt")
          requireDistributionPayoutResponseStorage(it.getJSONObject("proposal"), "receipt", receipt)
          it
            .put("status", "paid")
            .put("receivedAtoms", result.getString("receivedAtoms"))
            .put("receipt", receipt)
            .put("destinationTransactionHash", receipt.getString("transactionHash"))
        } else if (it.getString("status") != "submissionUnknown") it.put("status", "submitted")
      }
    store.load().use {
      identity(it)
      invalidate(it, setOf(row.getJSONObject("proposal").getString("expectedSigner")))
    }
    if (row.getString("status") == "paid") {
      try {
        read(row.getJSONObject("proposal").getJSONObject("source"))
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: Exception) {
        /* Receipt stays verified if a display observation is unavailable. */
      }
    }
    return row
  }
}

/** Legacy saved zero-fee quotes remain readable; new service fees require a qualified proof. */
internal fun privateFundingFeeBps(prepared: JSONObject): Int {
  val total = prepared.optInt("providerFeeBps", 0)
  if (prepared.has("feePolicy")) nativeEarnFeePolicy(prepared, "providerFeeBps", "payoutRobinhood")
  else check(total == 0)
  return total
}
