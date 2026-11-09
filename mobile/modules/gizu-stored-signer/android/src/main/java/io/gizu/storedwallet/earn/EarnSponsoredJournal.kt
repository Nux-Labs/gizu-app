package io.gizu.storedwallet

import android.content.Context
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

internal fun JSONObject.sponsoredSpendSaved() =
  has("signedUserOperation") || has("raw") || has("rawTransaction") || has("signedTransaction")

internal fun JSONObject.sponsoredBlocked(): Boolean =
  when {
    sponsoredSpendSaved() -> getString("status") !in terminalSteps
    optBoolean("signingPending") -> true
    else -> !optBoolean("cancelled") // Discarded preparation never submits its retained delegation.
  }

internal fun requireSponsoredWallet(record: WalletRecord, walletId: String) {
  check(
    record.id == walletId &&
      record.verified &&
      record.earnChain in setOf(1, 4663) &&
      !record.earnRecoveryRequired
  )
}

internal fun earnSponsoredJournal(context: Context, record: WalletRecord): EarnSponsoredJournal {
  requireSponsoredWallet(record, record.id)
  return EarnSponsoredJournal(
    AndroidWalletFile(context, "gizu-earn-sponsored-${record.journalId}.enc", 4 * 1024 * 1024),
    { checkNotNull(AndroidWalletKeys().existing()) },
    record.id,
    record.journalId,
    earnQuoteJournal(context, record),
  )
}

/** Auth and UserOp stay encrypted together. Uncertain sends never release a wallet/nonce lock. */
internal class EarnSponsoredJournal(
  private val file: WalletFile,
  private val key: () -> SecretKey,
  val walletId: String,
  val generation: String,
  val quotes: EarnQuoteJournal? = null,
) {
  private val aad = "gizu-earn-sponsored:v1:$walletId:$generation".toByteArray()

  companion object {
    private val signingLock = Any()
    private val spendSigning = mutableSetOf<String>()
  }

  private fun signingKey(id: String) = "$walletId:$generation:$id"

  private fun signingPending(op: JSONObject) =
    op.optBoolean("signingPending") ||
      synchronized(signingLock) { signingKey(op.getString("operationId")) in spendSigning }

  private fun canCancelPreparation(op: JSONObject) =
    !op.sponsoredSpendSaved() &&
      !signingPending(op) &&
      !op.optBoolean("cancelled") &&
      op.getString("status") !in terminalSteps

  /**
   * Covers synchronous native signing through durable commit across all journal instances. A killed
   * process loses these unsubmitted local bytes; signed bytes are never sent before commit.
   */
  fun <T> withSpendSigning(id: String, revision: Int, action: () -> T): T {
    val token = signingKey(id)
    synchronized(signingLock) {
      val op = get(id)
      check(op.getInt("revision") == revision && canCancelPreparation(op))
      check(spendSigning.add(token))
    }
    try {
      return action()
    } finally {
      synchronized(signingLock) { spendSigning.remove(token) }
    }
  }

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

  private fun write(entries: JSONArray) {
    val clear =
      JSONObject()
        .put("version", 1)
        .put("walletId", walletId)
        .put("operations", entries)
        .toString()
        .toByteArray()
    try {
      check(clear.size <= 15 * 1024 * 1024)
      file.write(CryptoEnvelope.encrypt(key(), clear, aad))
    } finally {
      clear.fill(0)
    }
  }

  fun all(): List<JSONObject> =
    read().let { rows -> (0 until rows.length()).map(rows::getJSONObject) }

  fun get(id: String): JSONObject = all().single { it.getString("operationId") == id }

  fun create(proposal: JSONObject, unsigned: JSONObject): JSONObject {
    val old = all()
    val id = proposal.getString("operationId")
    check(
      old.count(::journalEntryPending) < 256 &&
        old.none {
          ((it.sponsoredBlocked() || signingPending(it)) &&
            it
              .getJSONObject("proposal")
              .getString("expectedFrom")
              .equals(proposal.getString("expectedFrom"), true) &&
            it.getJSONObject("proposal").getLong("chainId") == proposal.getLong("chainId")) ||
            it.getString("operationId") == id ||
            proposal.has("quoteId") &&
              it.getJSONObject("proposal").optString("quoteId") == proposal.getString("quoteId")
        }
    )
    val op =
      JSONObject()
        .put("operationId", id)
        .put("walletId", walletId)
        .put("revision", 1)
        .put("proposal", JSONObject(proposal.toString()))
        .put("unsignedUserOperation", JSONObject(unsigned.toString()))
        .put("status", "planned")
        .put("cancelled", false)
    write(JSONArray(old).put(op))
    return op
  }

  fun update(id: String, revision: Int, action: (JSONObject) -> Unit): JSONObject {
    val entries = read()
    val op =
      (0 until entries.length()).map(entries::getJSONObject).single {
        it.getString("operationId") == id
      }
    check(op.getInt("revision") == revision) { "Stale sponsored operation" }
    action(op)
    op.put("revision", Math.addExact(revision, 1))
    write(entries)
    return op
  }

  fun refreshUnsignedSource(
    id: String,
    revision: Int,
    proposal: JSONObject,
    unsigned: JSONObject,
  ): JSONObject =
    synchronized(signingLock) {
      val old = get(id)
      val p = old.getJSONObject("proposal")
      check(
        old.getInt("revision") == revision &&
          !old.sponsoredSpendSaved() &&
          !signingPending(old) &&
          !old.optBoolean("cancelled")
      )
      for (field in
        listOf(
          "kind",
          "operationId",
          "chainId",
          "profileChainId",
          "cycleIndex",
          "investmentSlot",
          "sourceAccountIndex",
          "fundingBatchId",
          "fundingBatchSize",
          "expectedFrom",
          "token",
          "confidentialAccount",
          "refundOwner",
          "budgetAtoms",
          "withdrawalReserveAtoms",
          "slippageBps",
        )) check(nativeJsonEqual(p.opt(field), proposal.opt(field))) {
        "Funding allocation changed"
      }
      check(
        p.getString("kind") == "sourceFunding" &&
          proposal.getLong("revision") > p.getLong("revision")
      )
      update(id, revision) {
        it
          .put("proposal", JSONObject(proposal.toString()))
          .put("unsignedUserOperation", JSONObject(unsigned.toString()))
          .put("status", if (it.has("authorization")) "authorizationSaved" else "planned")
      }
    }

  fun refreshUnsignedDeposit(
    id: String,
    revision: Int,
    proposal: JSONObject,
    unsigned: JSONObject,
  ): JSONObject =
    synchronized(signingLock) {
      val old = get(id)
      val p = old.getJSONObject("proposal")
      check(
        old.getInt("revision") == revision &&
          !old.sponsoredSpendSaved() &&
          !signingPending(old) &&
          !old.optBoolean("cancelled") &&
          !old.optBoolean("conflict")
      )
      check(
        p.getString("kind") == "hoodDeposit" && proposal.getInt("revision") > p.getInt("revision")
      )
      for (field in
        listOf(
          "kind",
          "operationId",
          "chainId",
          "profileChainId",
          "cycleIndex",
          "investmentSlot",
          "expectedFrom",
          "token",
          "vault",
          "router",
          "slippageBps",
        )) check(nativeJsonEqual(p.opt(field), proposal.opt(field)))
      check(
        depositAtoms(proposal.getString("budgetAtoms"), true) <=
          depositAtoms(p.getString("budgetAtoms"), true)
      )
      check(
        unsigned.getString("sender").equals(p.getString("expectedFrom"), true) &&
          (!unsigned.has("signature") || unsigned.getString("signature") == "0x") &&
          !unsigned.has("eip7702Auth")
      )
      update(id, revision) {
        it
          .put("proposal", JSONObject(proposal.toString()))
          .put("unsignedUserOperation", JSONObject(unsigned.toString()))
          .put("status", if (it.has("authorization")) "authorizationSaved" else "planned")
      }
    }

  fun saveAuthorization(
    id: String,
    revision: Int,
    authorization: JSONObject,
    review: String,
    hash: String,
  ): JSONObject =
    update(id, revision) { op ->
      check(
        !op.optBoolean("cancelled") && !op.has("authorization") && !op.has("signedUserOperation")
      )
      op
        .put("authorization", JSONObject(authorization.toString()))
        .put("authorizationReview", review)
        .put("authorizationReviewHash", hash)
        .put("status", "authorizationSaved")
    }

  fun saveSigned(
    id: String,
    revision: Int,
    hash: String,
    payload: String,
    review: String,
    reviewHash: String,
    stateBinding: JSONObject,
  ): JSONObject =
    update(id, revision) { op ->
      check(!op.optBoolean("cancelled") && !op.has("signedUserOperation"))
      op
        .put("userOperationHash", hash)
        .put("signedUserOperation", payload)
        .put("review", review)
        .put("reviewHash", reviewHash)
        .put("stateBinding", JSONObject(stateBinding.toString()))
        .put("status", "unknown")
    }

  fun cancel(id: String, revision: Int) =
    synchronized(signingLock) {
      update(id, revision) {
        check(canCancelPreparation(it)) {
          "A signed spending operation or pending signing cannot be discarded"
        }
        it.put("cancelled", true)
      }
    }

  fun public(op: JSONObject): Map<String, Any> {
    val p = op.getJSONObject("proposal")
    val status = op.getString("status")
    val minimum =
      if (status == "finalized") savedMinimumReturnReceipt(op, walletId, generation) else null
    return buildMap {
      put("operationId", op.getString("operationId"))
      put("walletId", walletId)
      put("revision", op.getInt("revision"))
      put("kind", p.getString("kind"))
      put("cycleIndex", p.optInt("cycleIndex", 0))
      if (p.has("investmentSlot")) put("investmentSlot", p.getInt("investmentSlot"))
      if (p.has("sourceAccountIndex")) put("sourceAccountIndex", p.getInt("sourceAccountIndex"))
      if (p.has("fundingBatchId")) {
        put("fundingBatchId", p.getString("fundingBatchId"))
        put("fundingBatchSize", p.getInt("fundingBatchSize"))
      }
      put("chainId", p.getLong("chainId"))
      put("from", p.getString("expectedFrom"))
      put("amountAtoms", p.getString("amountAtoms"))
      put("nonce", p.getString("nonce"))
      put("canCancelPreparation", canCancelPreparation(op))
      if (op.has("authorization") && !op.sponsoredSpendSaved())
        put(
          "preparationCancellationDisclosure",
          "Discard this preparation and retain its encrypted delegation history. This does not revoke the saved 7702 delegation signature. No spending UserOperation was signed or will be submitted by the discarded preparation.",
        )
      put("blocked", op.sponsoredBlocked() || signingPending(op))
      put(
        "canResume",
        !signingPending(op) &&
          status !in terminalSteps &&
          !op.optBoolean("conflict") &&
          (status == "signed" || !op.has("signedUserOperation") && !op.optBoolean("cancelled")),
      )
      put(
        "status",
        if (status == "finalized")
          when (p.getString("kind")) {
            "hoodDeposit" -> "invested"
            "hoodRedeemAll" ->
              if (op.optString("residualShares", "0") == "0") "withdrawn" else "residualShares"
            "sourceFunding",
            "hoodTokenReturn" ->
              if (minimum != null) "minimumReceived"
              else if (op.optJSONObject("settlement")?.optString("status") == "credited") "credited"
              else "awaitingSettlement"
            else -> error("Unsupported sponsored action")
          }
        else if (op.optBoolean("cancelled") && !op.sponsoredSpendSaved() && !signingPending(op))
          "cancelled"
        else status,
      )
      if (minimum != null) {
        put("minimumReturnReceipt", minimumReturnPublic(minimum))
        put("verifiedMinimumAtoms", minimum.getString("verifiedMinimumAtoms"))
      }
      if (op.has("residualShares")) put("residualShares", op.getString("residualShares"))
      if (status == "finalized" && op.has("settlement")) {
        val settlement = op.getJSONObject("settlement")
        put("settlement", sponsoredSettlementPublic(settlement))
        if (settlement.getString("status") == "credited")
          put("creditedAtoms", settlement.getString("creditedAtoms"))
      }
      if (op.has("userOperationHash")) put("userOperationHash", op.getString("userOperationHash"))
      if (op.has("transactionHash")) put("transactionHash", op.getString("transactionHash"))
      if (status in terminalSteps && op.has("actualTokenFeeAtoms"))
        put("actualTokenFeeAtoms", op.getString("actualTokenFeeAtoms"))
    }
  }
}
