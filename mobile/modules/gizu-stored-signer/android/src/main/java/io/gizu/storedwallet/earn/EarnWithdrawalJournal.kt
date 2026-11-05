package io.gizu.storedwallet

import android.content.Context
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.NativeEarnPayoutJournalEvidence

internal fun earnWithdrawalJournal(context: Context, record: WalletRecord): EarnWithdrawalJournal {
  requireSponsoredWallet(record, record.id)
  val payouts = earnPayoutJournal(context, record)
  return EarnWithdrawalJournal(
    AndroidWalletFile(context, "gizu-earn-withdrawal-${record.journalId}.enc", 4 * 1024 * 1024),
    { checkNotNull(AndroidWalletKeys().existing()) },
    record.id,
    record.journalId,
  ) { account, nonce ->
    payouts.all().any { op ->
      op.getJSONObject("proposal").getString("expectedSigner").equals(account, true) &&
        (op.optJSONArray("nonceHistory")?.let { history ->
          (0 until history.length()).any { history.getString(it) == nonce }
        } ?: (op.getString("nonce") == nonce))
    }
  }
}

/**
 * Permanent per-return-child and per-C-nonce reservations, including after success. Signed bytes
 * are private; uncertain sends cannot release either reservation.
 */
internal class EarnWithdrawalJournal(
  private val file: WalletFile,
  private val key: () -> SecretKey,
  val walletId: String,
  val generation: String,
  private val externalNonceSeen: (String, String) -> Boolean = { _, _ -> false },
) {
  companion object {
    private val locks = ConcurrentHashMap<String, Any>()
  }

  private val lock = locks.computeIfAbsent("$walletId:$generation") { Any() }
  private val aad = "gizu-earn-withdrawal:v1:$walletId:$generation".toByteArray()

  private fun read(): JSONArray {
    if (!file.exists()) return JSONArray()
    val clear = CryptoEnvelope.decrypt(key(), file.read(), aad)
    try {
      val root = JSONObject(String(clear, Charsets.UTF_8))
      check(root.getInt("version") == 1 && root.getString("walletId") == walletId)
      return root.getJSONArray("operations").also { check(it.length() <= 256) }
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
      check(clear.size <= 3 * 1024 * 1024)
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
      val leg = "withdrawal"
      check(proposal.getString("kind") == "confidentialWithdrawal")
      val funding = proposal.getString("returnOperationId")
      val C = proposal.getString("expectedSigner")
      val tx = proposal.getString("returnTransactionHash")
      check(!externalNonceSeen(C, nonce)) { "Previously reserved confidential payout nonce" }
      check(
        old.size < 256 &&
          old.none { op ->
            val p = op.getJSONObject("proposal")
            (op.getString("leg") == leg &&
              (p.getString("returnOperationId") == funding ||
                p.getString("returnTransactionHash").equals(tx, true) &&
                  p.getString("expectedSigner").equals(C, true))) ||
              p.getString("expectedSigner").equals(C, true) && nonceHistory(op).contains(nonce)
          }
      ) {
        "Return child or nonce is already reserved; reconcile the original child"
      }
      val op =
        JSONObject()
          .put("operationId", "withdrawal_" + UUID.randomUUID().toString().replace("-", ""))
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
            (p.getString("returnOperationId") == old.getString("returnOperationId") ||
              p.getString("returnTransactionHash")
                .equals(old.getString("returnTransactionHash"), true) &&
                p.getString("expectedSigner").equals(old.getString("expectedSigner"), true))
        }
      check(sameRole.size == 1 && sameRole.single().getString("operationId") == id) {
        "Return child reservation is not unique"
      }
      for (field in
        listOf(
          "kind",
          "operationId",
          "revision",
          "profileChainId",
          "cycleIndex",
          "investmentSlot",
          "recipientIndex",
          "returnOperationId",
          "returnTransactionHash",
          "returnQuoteId",
          "returnHistoryId",
          "expectedSigner",
          "expectedRecipient",
          "creditedAtoms",
          "amountAtoms",
        )) check(old.opt(field) == proposal.opt(field)) {
        "Immutable withdrawal return or recipient changed"
      }
      check(!externalNonceSeen(old.getString("expectedSigner"), nonce)) {
        "Previously reserved confidential payout nonce"
      }
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
          "Previously seen withdrawal nonce"
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
      check(!externalNonceSeen(p.getString("expectedSigner"), op.getString("nonce"))) {
        "Previously reserved confidential payout nonce"
      }
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
      check(op.getInt("revision") == revision) { "Stale withdrawal operation" }
      action(op)
      op.put("revision", Math.addExact(revision, 1))
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
      check(!it.has("signedData") && it.getString("status") == "planned")
      it
        .put("signingAuthorizationPending", false)
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
      put("kind", "confidentialWithdrawal")

      put("leg", op.getString("leg"))
      put("chainId", 143L)
      put("profileChainId", p.getLong("profileChainId"))
      put("cycleIndex", p.optInt("cycleIndex", 0))
      if (p.has("investmentSlot")) put("investmentSlot", p.getInt("investmentSlot"))
      put("returnOperationId", p.getString("returnOperationId"))
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
