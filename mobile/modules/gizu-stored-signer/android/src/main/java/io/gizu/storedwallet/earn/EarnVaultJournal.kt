package io.gizu.storedwallet

import android.content.Context
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

internal fun JSONObject.earnBlocked(): Boolean =
  steps().any { it.has("raw") && it.getString("status") !in terminalSteps } ||
    (!optBoolean("cancelled") &&
      (steps().isEmpty() || steps().any { it.getString("status") == "planned" }))

internal fun earnVaultJournal(context: Context, record: WalletRecord): EarnVaultJournal {
  requireEarnExecutionWallet(record, record.id)
  return EarnVaultJournal(
    AndroidWalletFile(context, "gizu-earn-vault-${record.journalId}.enc", 4 * 1024 * 1024),
    { checkNotNull(AndroidWalletKeys().existing()) },
    record.id,
    record.journalId,
  )
}

internal fun requireEarnExecutionWallet(record: WalletRecord, walletId: String) {
  check(
    record.id == walletId &&
      record.verified &&
      record.earnChain == 1 &&
      !record.earnRecoveryRequired
  )
}

/**
 * Native-private, authenticated whole-file commit. Deposit and redemption share this nonce lock.
 */
internal class EarnVaultJournal(
  private val file: WalletFile,
  private val key: () -> SecretKey,
  val walletId: String,
  val generation: String,
) {
  private val aad = "gizu-earn-vault:v1:$walletId:$generation".toByteArray()

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

  private fun write(entries: JSONArray) {
    val clear =
      JSONObject()
        .put("version", 1)
        .put("walletId", walletId)
        .put("operations", entries)
        .toString()
        .toByteArray()
    try {
      check(clear.size <= 3 * 1024 * 1024)
      file.write(CryptoEnvelope.encrypt(key(), clear, aad))
    } finally {
      clear.fill(0)
    }
  }

  fun all(): List<JSONObject> =
    read().let { rows -> (0 until rows.length()).map(rows::getJSONObject) }

  fun get(id: String): JSONObject = all().single { it.getString("operationId") == id }

  fun create(proposal: JSONObject): JSONObject {
    val existing = all()
    check(
      existing.size < 256 &&
        existing.none {
          it.earnBlocked() &&
            it
              .getJSONObject("proposal")
              .getString("expectedFrom")
              .equals(proposal.getString("expectedFrom"), true)
        }
    ) {
      "Reconcile prior Earn operation"
    }
    val id = proposal.getString("operationId")
    check(existing.none { it.getString("operationId") == id }) { "Duplicate Earn operation" }
    check(proposal.getString("kind") in setOf("vaultDeposit", "vaultRedeemAll"))
    val op =
      JSONObject()
        .put("operationId", id)
        .put("walletId", walletId)
        .put("revision", 1)
        .put("proposal", JSONObject(proposal.toString()))
        .put("cancelled", false)
        .put("steps", JSONArray())
    write(JSONArray(existing).put(op))
    return op
  }

  fun update(id: String, revision: Int, action: (JSONObject) -> Unit): JSONObject {
    val entries = read()
    val op =
      (0 until entries.length()).map(entries::getJSONObject).single {
        it.getString("operationId") == id
      }
    check(op.getInt("revision") == revision) { "Stale Earn operation" }
    action(op)
    op.put("revision", Math.addExact(revision, 1))
    write(entries)
    return op
  }

  fun prepare(
    id: String,
    revision: Int,
    calls: JSONArray,
    hash: String,
    review: String,
  ): JSONObject =
    update(id, revision) { op ->
      check(
        !op.optBoolean("cancelled") &&
          op.steps().none { it.has("raw") && it.getString("status") !in terminalSteps }
      )
      val old = op.steps().filter { it.has("raw") }
      val steps = JSONArray(old)
      for (i in 0 until calls.length()) steps.put(
        JSONObject(calls.getJSONObject(i).toString())
          .put("index", old.size + i)
          .put("status", "planned")
      )
      op.put("steps", steps).put("reviewHash", hash).put("review", review)
    }

  fun persistSigned(
    id: String,
    revision: Int,
    index: Int,
    raw: String,
    hash: String,
    from: String,
    nonce: String,
    reviewHash: String,
  ): JSONObject =
    update(id, revision) { op ->
      val step = op.steps()[index]
      check(
        !op.optBoolean("cancelled") && step.getString("status") == "planned" && !step.has("raw")
      )
      check(op.getJSONObject("proposal").getString("expectedFrom").equals(from, true))
      check(step.getString("nonce") == nonce && op.getString("reviewHash") == reviewHash)
      check(op.steps().none { it.has("raw") && it.getString("status") !in terminalSteps })
      step.put("raw", raw).put("transactionHash", hash).put("status", "unknown")
    }

  fun public(op: JSONObject): Map<String, Any> {
    val proposal = op.getJSONObject("proposal")
    val steps = op.steps()
    val unresolved = steps.filter { it.has("raw") && it.getString("status") !in terminalSteps }
    val complete = steps.isNotEmpty() && steps.all { it.getString("status") == "finalized" }
    return mapOf(
      "operationId" to op.getString("operationId"),
      "walletId" to walletId,
      "revision" to op.getInt("revision"),
      "kind" to proposal.getString("kind"),
      "from" to proposal.getString("expectedFrom"),
      "cycleIndex" to proposal.optInt("cycleIndex", 0),
      "amountAtoms" to proposal.getString("amountAtoms"),
      "residualShares" to (steps.lastOrNull()?.optString("residualShares", "0") ?: "0"),
      "actualFeeWei" to
        steps
          .filter { it.getString("status") in terminalSteps }
          .fold(java.math.BigInteger.ZERO) { total, step ->
            total + step.optString("actualFeeWei", "0").toBigInteger()
          }
          .toString(),
      "blocked" to op.earnBlocked(),
      "canResume" to
        (unresolved.size == 1 &&
          unresolved.single().getString("status") == "signed" &&
          !unresolved.single().optBoolean("conflict") ||
          unresolved.isEmpty() && !complete && !op.optBoolean("cancelled")),
      "status" to
        when {
          complete ->
            if (proposal.getString("kind") == "vaultDeposit") "invested"
            else if (steps.last().optString("residualShares", "0") == "0") "withdrawn"
            else "residualShares"
          steps.any { it.getString("status") == "reverted" } -> "reverted"
          unresolved.isNotEmpty() -> "pending"
          op.optBoolean("cancelled") -> "cancelled"
          else -> "needsReview"
        },
      "steps" to
        steps.map { step ->
          buildMap<String, Any> {
            put("index", step.getInt("index"))
            put("to", step.getString("to"))
            put("nonce", step.getString("nonce"))
            put("status", step.getString("status"))
            put("nonceConflict", step.optBoolean("conflict"))
            if (step.getString("status") in terminalSteps && step.has("actualFeeWei"))
              put("actualFeeWei", step.getString("actualFeeWei"))
            if (step.has("transactionHash"))
              put("transactionHash", step.getString("transactionHash"))
          }
        },
    ) +
      (if (proposal.has("investmentSlot"))
        mapOf("investmentSlot" to proposal.getInt("investmentSlot"))
      else emptyMap())
  }
}
