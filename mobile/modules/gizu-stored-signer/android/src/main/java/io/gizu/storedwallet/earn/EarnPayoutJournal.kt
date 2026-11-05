package io.gizu.storedwallet

import android.content.Context
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.NativeEarnPayoutJournalEvidence

// Includes the escaping added when the exact journal JSON is embedded in a recovery snapshot.
internal const val DISTRIBUTION_PAYOUT_STORAGE_BYTES = 1024 * 1024
private const val DISTRIBUTION_PAYOUT_GROWTH_BYTES = 128 * 1024

internal fun payoutRecoveryStorageBytes(row: JSONObject): Int =
  JSONObject.quote(row.toString()).toByteArray().size

internal fun requireDistributionPayoutStorage(row: JSONObject, unsigned: Boolean = false) {
  if (!row.getJSONObject("proposal").has("distribution")) return
  val reserve = if (unsigned) DISTRIBUTION_PAYOUT_GROWTH_BYTES else 0
  check(payoutRecoveryStorageBytes(row) + reserve <= DISTRIBUTION_PAYOUT_STORAGE_BYTES) {
    "Distribution payout exceeds its reserved encrypted recovery storage."
  }
}

internal fun requireDistributionPayoutResponseStorage(
  proposal: JSONObject,
  field: String,
  value: Any,
) {
  if (!proposal.has("distribution")) return
  val limit =
    when (field) {
      "submission",
      "receipt" -> 16 * 1024
      "settlement" -> 32 * 1024
      else -> error("Unexpected payout response field")
    }
  check(payoutRecoveryStorageBytes(JSONObject().put(field, value)) <= limit) {
    "Distribution payout response exceeds its reserved encrypted recovery storage."
  }
}

internal fun requireDistributionPayoutSigningStorage(
  row: JSONObject,
  payload: String,
  review: String,
  reviewHash: String,
) {
  if (!row.getJSONObject("proposal").has("distribution")) return
  check(payload.toByteArray().size <= 4096)
  // The native secp256k1 signature is fixed-width base58; 132 ASCII bytes is an upper bound.
  val signed =
    JSONObject()
      .put("standard", "erc191")
      .put("payload", payload)
      .put("signature", "s".repeat(132))
      .toString()
  val candidate =
    JSONObject(row.toString())
      .put("signedData", signed)
      .put("review", review)
      .put("reviewHash", reviewHash)
      .put("distributionStorageVersion", 1)
      .put("status", "submissionUnknown")
      .put("revision", Math.addExact(row.getInt("revision"), 1))
  // 16KiB submission +32KiB settlement +16KiB receipt, plus keys/status/cursor/revision overhead.
  check(payoutRecoveryStorageBytes(candidate) + 72 * 1024 <= DISTRIBUTION_PAYOUT_STORAGE_BYTES) {
    "Distribution payout has no space to durably save its signature and settlement."
  }
}

internal fun earnPayoutJournal(context: Context, record: WalletRecord): EarnPayoutJournal {
  requireSponsoredWallet(record, record.id)
  return EarnPayoutJournal(
    AndroidWalletFile(context, "gizu-earn-payout-${record.journalId}.enc", 4 * 1024 * 1024),
    { checkNotNull(AndroidWalletKeys().existing()) },
    record.id,
    record.journalId,
  )
}

/**
 * Permanent per-funding-role and per-C-nonce reservations, including after success. Signed bytes
 * are private; uncertain sends cannot release either reservation.
 */
internal class EarnPayoutJournal(
  private val file: WalletFile,
  private val key: () -> SecretKey,
  val walletId: String,
  val generation: String,
) {
  companion object {
    private val locks = ConcurrentHashMap<String, Any>()
  }

  private val lock = locks.computeIfAbsent("$walletId:$generation") { Any() }
  private val aad = "gizu-earn-payout:v1:$walletId:$generation".toByteArray()

  private fun read(): JSONArray {
    if (!file.exists()) return JSONArray()
    val clear = CryptoEnvelope.decrypt(key(), file.read(), aad)
    try {
      val root = JSONObject(String(clear, Charsets.UTF_8))
      check(root.getInt("version") == 1 && root.getString("walletId") == walletId)
      return root.getJSONArray("operations").also { check(it.length() <= 100_000) }
    } finally {
      clear.fill(0)
    }
  }

  private fun write(rows: JSONArray) {
    val clear =
      JSONObject()
        .put("version", 1)
        .put("walletId", walletId)
        .put("operations", rows)
        .toString()
        .toByteArray()
    try {
      check(clear.size <= 15 * 1024 * 1024)
      file.write(CryptoEnvelope.encrypt(key(), clear, aad))
    } finally {
      clear.fill(0)
    }
  }

  private fun entries(rows: JSONArray) = (0 until rows.length()).map(rows::getJSONObject)

  private fun matches(op: JSONObject, id: String, leg: String) =
    op.getString("leg") == leg &&
      (op.getString("operationId") == id ||
        op.getJSONObject("proposal").getString("operationId") == id)

  fun all(): List<JSONObject> = synchronized(lock) { entries(read()) }

  fun get(id: String): JSONObject =
    synchronized(lock) { entries(read()).single { it.getString("operationId") == id } }

  fun get(id: String, leg: String): JSONObject =
    synchronized(lock) { entries(read()).single { matches(it, id, leg) } }

  fun create(
    proposal: JSONObject,
    preparedText: String,
    nonce: String,
    payloadHash: String,
    reservationId: String,
    sourceRequest: String? = null,
  ): JSONObject =
    synchronized(lock) {
      val rows = read()
      val old = entries(rows)
      val leg = proposal.getString("leg")
      if (proposal.has("distribution"))
        distributionSlot(leg, proposal.getJSONObject("distribution"))
      else check(leg in setOf("hold", "invest"))
      val funding = proposal.getString("operationId")
      val C = proposal.getString("expectedSigner")
      val tx = proposal.getString("sourceTransactionHash")
      check(
        old.count(::journalEntryPending) < 256 &&
          old.none { op ->
            val p = op.getJSONObject("proposal")
            (op.getString("leg") == leg &&
              (p.getString("operationId") == funding ||
                p.getString("sourceTransactionHash").equals(tx, true) &&
                  p.getString("expectedSigner").equals(C, true) &&
                  p.optInt("sourceAccountIndex", 0) == proposal.optInt("sourceAccountIndex", 0))) ||
              p.getString("expectedSigner").equals(C, true) && nonceHistory(op).contains(nonce)
          }
      ) {
        "Payout role or nonce is already reserved; reconcile the original child"
      }
      val op =
        JSONObject()
          .put("operationId", "payout_" + UUID.randomUUID().toString().replace("-", ""))
          .put("walletId", walletId)
          .put("revision", 1)
          .put("leg", leg)
          .put("proposal", JSONObject(proposal.toString()))
          .put("preparedText", preparedText)
          .put("nonce", nonce)
          .put("payloadHash", payloadHash)
          .put("reservationId", reservationId)
          .put("nonceHistory", JSONArray().put(nonce))
          .put("status", "planned")
          .put("receivedAtoms", "0")
      if (sourceRequest != null) op.put("sourceRequest", sourceRequest)
      if (proposal.has("distribution")) op.put("distributionStorageVersion", 1)
      requireDistributionPayoutStorage(op, unsigned = true)
      write(rows.put(op))
      op
    }

  private fun nonceHistory(op: JSONObject): List<String> =
    op.optJSONArray("nonceHistory")?.let { rows -> (0 until rows.length()).map(rows::getString) }
      ?: listOf(op.getString("nonce"))

  fun refreshUnsigned(
    id: String,
    revision: Int,
    proposal: JSONObject,
    preparedText: String,
    nonce: String,
    payloadHash: String,
  ): JSONObject =
    synchronized(lock) {
      val rows = read()
      val entries = entries(rows)
      val op = entries.single { it.getString("operationId") == id }
      val old = op.getJSONObject("proposal")
      check(
        op.getInt("revision") == revision &&
          !op.has("signedData") &&
          !op.optBoolean("signingAuthorizationPending", false) &&
          op.getString("status") in setOf("planned", "cancelled")
      )
      val sameRole =
        entries.filter { row ->
          val p = row.getJSONObject("proposal")
          row.getString("leg") == op.getString("leg") &&
            (p.getString("operationId") == old.getString("operationId") ||
              p.getString("sourceTransactionHash")
                .equals(old.getString("sourceTransactionHash"), true) &&
                p.getString("expectedSigner").equals(old.getString("expectedSigner"), true) &&
                p.optInt("sourceAccountIndex", 0) == old.optInt("sourceAccountIndex", 0))
        }
      check(sameRole.size == 1 && sameRole.single().getString("operationId") == id) {
        "Payout role reservation is not unique"
      }
      for (field in
        listOf(
          "operationId",
          "revision",
          "profileChainId",
          "leg",
          "sourceTransactionHash",
          "sourceQuoteId",
          "sourceHistoryId",
          "expectedSigner",
          "expectedRecipient",
          "creditedAtoms",
          "amountAtoms",
          "sourceAccountIndex",
          "cycleIndex",
          "splitOffsetAtoms",
          "sourceOwner",
          "fundingBatchId",
          "fundingBatchSize",
        )) check(old.opt(field) == proposal.opt(field)) {
        "Immutable payout funding or role changed"
      }
      check(old.has("distribution") == proposal.has("distribution"))
      if (old.has("distribution"))
        check(
          distributionWeights(old.getJSONObject("distribution")) ==
            distributionWeights(proposal.getJSONObject("distribution"))
        )
      val history = nonceHistory(op)
      if (nonce != op.getString("nonce"))
        check(
          entries.none { row ->
            row
              .getJSONObject("proposal")
              .getString("expectedSigner")
              .equals(old.getString("expectedSigner"), true) && nonceHistory(row).contains(nonce)
          }
        ) {
          "Previously seen payout nonce"
        }
      val seen = if (history.contains(nonce)) history else history + nonce
      check(seen.size <= 128)
      op
        .put("proposal", JSONObject(proposal.toString()))
        .put("preparedText", preparedText)
        .put("nonce", nonce)
        .put("payloadHash", payloadHash)
        .put("nonceHistory", JSONArray(seen))
        .put("status", "planned")
        .put("revision", Math.addExact(revision, 1))
      if (proposal.has("distribution")) op.put("distributionStorageVersion", 1)
      requireDistributionPayoutStorage(op, unsigned = true)
      write(rows)
      op
    }

  fun evidence(id: String, leg: String, revision: Int, now: Long): NativeEarnPayoutJournalEvidence =
    synchronized(lock) {
      val op = get(id, leg)
      val p = op.getJSONObject("proposal")
      check(
        op.getInt("revision") == revision &&
          !op.has("signedData") &&
          !op.optBoolean("signingAuthorizationPending", false) &&
          op.getString("status") == "planned"
      )
      requireDistributionPayoutStorage(op, unsigned = true)
      NativeEarnPayoutJournalEvidence(
        p.getString("operationId"),
        p.getLong("revision").toULong(),
        p.getLong("profileChainId").toULong(),
        leg,
        op.getString("reservationId"),
        op.getString("nonce"),
        op.getString("payloadHash"),
        true,
        true,
        false,
        now.toULong(),
      )
    }

  fun update(id: String, leg: String, revision: Int, action: (JSONObject) -> Unit): JSONObject =
    synchronized(lock) {
      val rows = read()
      val op = entries(rows).single { matches(it, id, leg) }
      check(op.getInt("revision") == revision) { "Stale payout operation" }
      val historicalSigned = op.has("signedData") && !op.has("distributionStorageVersion")
      action(op)
      op.put("revision", Math.addExact(revision, 1))
      // Historical signed rows retain their exact reconciliation/retry path at every size.
      if (!historicalSigned) requireDistributionPayoutStorage(op)
      write(rows)
      op
    }

  fun saveSigned(
    id: String,
    leg: String,
    revision: Int,
    signedData: String,
    review: String,
    reviewHash: String,
  ): JSONObject =
    update(id, leg, revision) {
      check(
        !it.has("signedData") &&
          !it.optBoolean("signingAuthorizationPending", false) &&
          it.getString("status") == "planned"
      )
      if (it.getJSONObject("proposal").has("distribution")) it.put("distributionStorageVersion", 1)
      it
        .put("signedData", signedData)
        .put("review", review)
        .put("reviewHash", reviewHash)
        .put("status", "submissionUnknown")
    }

  fun cancelUnsigned(id: String, revision: Int): JSONObject {
    val op = get(id)
    return update(id, op.getString("leg"), revision) {
      check(!it.has("signedData") && !it.optBoolean("signingAuthorizationPending", false))
      it.put("status", "cancelled")
    }
  }

  fun public(op: JSONObject): Map<String, Any> {
    val p = op.getJSONObject("proposal")
    val status =
      when (op.getString("status")) {
        "submissionUnknown" -> "unknown"
        "submitted",
        "awaitingSettlement",
        "awaitingDestinationConfirmation" -> "pending"
        else -> op.getString("status")
      }
    return buildMap {
      put("operationId", op.getString("operationId"))
      put("walletId", walletId)
      put("revision", op.getInt("revision"))
      put("kind", "confidentialPayout")
      put("sourceOperationId", p.getString("operationId"))
      put("cycleIndex", p.optInt("cycleIndex", 0))
      if (p.has("distribution"))
        put(
          "distribution",
          mapOf(
            "version" to 1,
            "weightsBps" to distributionWeights(p.getJSONObject("distribution")),
          ),
        )
      put("leg", op.getString("leg"))
      put("chainId", p.getLong("profileChainId"))
      put("recipient", p.getString("expectedRecipient"))
      put("amountAtoms", p.getString("amountAtoms"))
      put("minimumDestinationAtoms", p.getString("minimumDestinationAtoms"))
      put("receivedAtoms", if (status == "paid") op.getString("receivedAtoms") else "0")
      put("status", status)
      put(
        "canRefreshUnsigned",
        status in setOf("planned", "cancelled") &&
          !op.has("signedData") &&
          !op.optBoolean("signingAuthorizationPending", false) &&
          op.has("sourceRequest"),
      )
      put("blocked", status !in setOf("paid", "cancelled"))
      put("canResume", status !in setOf("paid", "cancelled"))
      if (status == "paid" && op.has("destinationTransactionHash"))
        put("destinationTransactionHash", op.getString("destinationTransactionHash"))
    }
  }
}
