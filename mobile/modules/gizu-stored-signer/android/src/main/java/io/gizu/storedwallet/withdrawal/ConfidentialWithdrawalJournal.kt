package io.gizu.storedwallet

import android.content.Context
import java.math.BigInteger
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

internal fun confidentialWithdrawalJournal(context: Context, record: WalletRecord) =
  ConfidentialWithdrawalJournal(
    AndroidWalletFile(
      context,
      "gizu-confidential-withdrawal-${record.journalId}.enc",
      8 * 1024 * 1024,
    ),
    { checkNotNull(AndroidWalletKeys().existing()) },
    record.id,
    record.journalId,
  )

/** Exact plan and signed bytes survive process death. Terminal children are never regenerated. */
internal class ConfidentialWithdrawalJournal(
  private val file: WalletFile,
  private val key: () -> SecretKey,
  val wallet: String,
  val generation: String,
) {
  companion object {
    private val lock = Any()
  }

  private val aad = "gizu-confidential-withdrawal:v1:$wallet:$generation".toByteArray()

  private fun read(): JSONObject {
    if (!file.exists())
      return JSONObject()
        .put("version", 1)
        .put("walletId", wallet)
        .put("generation", generation)
        .put("operations", JSONArray())
    val bytes = CryptoEnvelope.decrypt(key(), file.read(), aad)
    try {
      return JSONObject(String(bytes)).also {
        check(
          it.getInt("version") == 1 &&
            it.getString("walletId") == wallet &&
            it.getString("generation") == generation
        )
      }
    } finally {
      bytes.fill(0)
    }
  }

  private fun write(root: JSONObject) {
    val bytes = root.toString().toByteArray()
    check(bytes.size < 8 * 1024 * 1024 - 1024) {
      "Confidential withdrawal journal capacity reached; saved recovery state was retained"
    }
    try {
      file.write(CryptoEnvelope.encrypt(key(), bytes, aad))
    } finally {
      bytes.fill(0)
    }
  }

  private fun terminal(row: JSONObject) =
    row.getJSONArray("children").objects().all { it.getString("status") == "paid" } ||
      row.optBoolean("cancelled")

  fun active(): JSONObject? =
    synchronized(lock) { read().getJSONArray("operations").objects().lastOrNull { !terminal(it) } }

  fun assertFreshNonce(source: String, nonce: String, operationId: String, index: Int) =
    synchronized(lock) {
      for (row in read().getJSONArray("operations").objects()) for ((i, c) in
        row.getJSONArray("children").objects().withIndex()) {
        if (row.getString("operationId") == operationId && i == index) continue
        val address =
          row
            .getJSONObject("plan")
            .getJSONObject("proposal")
            .getJSONArray("sources")
            .getJSONObject(c.getInt("source"))
            .getString("address")
        if (address.equals(source, true))
          check(
            c.optString("nonce") != nonce &&
              c.optJSONArray("nonceHistory")?.let { h ->
                (0 until h.length()).none { h.getString(it) == nonce }
              } != false
          ) {
            "Confidential nonce is already reserved by another child"
          }
      }
    }

  fun get(id: String): JSONObject =
    synchronized(lock) {
      read().getJSONArray("operations").objects().single { it.getString("operationId") == id }
    }

  fun create(plan: JSONObject): JSONObject =
    synchronized(lock) {
      val root = read()
      check(root.getJSONArray("operations").objects().none { !terminal(it) }) {
        "Resume the saved withdrawal before creating another"
      }
      val p = plan.getJSONObject("proposal")
      val id = p.getString("operationId")
      check(root.getJSONArray("operations").objects().none { it.getString("operationId") == id })
      val row =
        JSONObject()
          .put("operationId", id)
          .put("walletId", wallet)
          .put("revision", 1)
          .put("plan", JSONObject(plan.toString()))
          .put(
            "children",
            JSONArray(
              plan.getJSONArray("children").objects().map {
                JSONObject(it.toString())
                  .put("status", "needsReview")
                  .put("minimumDestinationAtoms", "0")
                  .put("receivedAtoms", "0")
              }
            ),
          )
      root.getJSONArray("operations").put(row)
      write(root)
      row
    }

  fun update(id: String, revision: Int, action: (JSONObject) -> Unit): JSONObject =
    synchronized(lock) {
      val root = read()
      val row =
        root.getJSONArray("operations").objects().single { it.getString("operationId") == id }
      check(row.getInt("revision") == revision) { "Stale withdrawal revision" }
      val original = row.getJSONObject("plan").toString()
      val before = JSONObject(row.toString())
      action(row)
      check(row.getString("operationId") == id && row.getString("walletId") == wallet)
      val oldChildren = before.getJSONArray("children").objects()
      val newChildren = row.getJSONArray("children").objects()
      check(oldChildren.size == newChildren.size)
      oldChildren.forEachIndexed { index, old ->
        val fresh = newChildren[index]
        for (field in listOf("source", "slot", "amountAtoms")) check(
          old.get(field) == fresh.get(field)
        )
        if (old.has("signedData")) {
          for (field in
            listOf("signedData", "preparedText", "nonce", "payloadHash", "reservationId")) if (
            old.has(field)
          )
            check(old.get(field) == fresh.get(field)) { "Signed withdrawal bytes are immutable" }
        }
        if (old.optString("status") == "paid")
          check(old.toString() == fresh.toString()) { "Paid withdrawal children are immutable" }
      }
      check(row.getJSONObject("plan").toString() == original) {
        "Saved withdrawal distribution is immutable"
      }
      row.put("revision", Math.addExact(revision, 1))
      write(root)
      row
    }

  fun cancel(id: String) {
    val row = get(id)
    update(id, row.getInt("revision")) { r ->
      check(
        r.getJSONArray("children").objects().all {
          it.getString("status") in setOf("review", "needsReview", "cancelled") &&
            !it.has("signedData") &&
            !it.optBoolean("signingPending")
        }
      ) {
        "Signed or uncertain withdrawal cannot be cancelled"
      }
      r.put("cancelled", true)
      r.getJSONArray("children").objects().forEach { it.put("status", "cancelled") }
    }
  }

  private fun status(children: List<JSONObject>): String {
    val states = children.map { it.getString("status") }
    return when {
      states.all { it == "paid" } -> "paid"
      states.all { it == "cancelled" } -> "cancelled"
      "conflict" in states -> "conflict"
      "unknown" in states -> "unknown"
      "pending" in states -> "pending"
      "needsReview" in states -> "needsReview"
      else -> "review"
    }
  }

  fun public(row: JSONObject): Map<String, Any> {
    val p = row.getJSONObject("plan").getJSONObject("proposal")
    val children = row.getJSONArray("children").objects()
    val wallets = p.getJSONArray("weightsBps").length()
    val payouts =
      (0 until wallets).map { slot ->
        val selected = children.filter { it.getInt("slot") == slot }
        mapOf<String, Any>(
          "slot" to slot,
          "amountAtoms" to selected.sumAtoms("amountAtoms"),
          "minimumDestinationAtoms" to selected.sumAtoms("minimumDestinationAtoms"),
          "receivedAtoms" to selected.sumAtoms("receivedAtoms"),
          "status" to status(selected),
        )
      }
    val state = status(children)
    return mapOf(
      "walletId" to wallet,
      "operationId" to row.getString("operationId"),
      "revision" to row.getInt("revision"),
      "amountAtoms" to p.getString("amountAtoms"),
      "minimumDestinationAtoms" to children.sumAtoms("minimumDestinationAtoms"),
      "receivedAtoms" to children.sumAtoms("receivedAtoms"),
      "walletCount" to wallets,
      "weightsBps" to (0 until wallets).map { p.getJSONArray("weightsBps").getInt(it) },
      "status" to state,
      "canResume" to (state !in setOf("paid", "cancelled", "conflict")),
      "canCancel" to
        (state !in setOf("paid", "cancelled") &&
          children.all {
            it.getString("status") in setOf("review", "needsReview", "cancelled") &&
              !it.has("signedData") &&
              !it.optBoolean("signingPending")
          }),
      "payouts" to payouts,
    )
  }
}

internal fun List<JSONObject>.sumAtoms(field: String) =
  fold(BigInteger.ZERO) { sum, row -> sum + row.getString(field).toBigInteger() }.toString()

/** Kind and status only. Never carries an address, amount, nonce or signature. */
internal class UnfinishedPrivateWork(val kind: String, val status: String) :
  IllegalStateException("Reconcile unfinished private spending before withdrawing from Gizu")

/** Phase only. A second saved deposit is open; this is not a fee-estimate failure. */
internal class DepositPhaseBlocked(val phase: String) :
  IllegalStateException("Finish or cancel the saved deposit before withdrawing from Gizu")

/**
 * Conservative device-wide private execution exclusion, including saved unknown signatures. An
 * expired exit keeps its signed bytes but can no longer be submitted. A saved operation whose
 * sender nonce is already behind a later included operation cannot execute either.
 */
internal fun assertNoPendingPrivateWork(operations: List<JSONObject>, deposits: List<JSONObject>) {
  val blocker = operations.firstOrNull { privateWorkPending(it, operations) }
  if (blocker != null) {
    val proposal = blocker.optJSONObject("proposal")
    throw UnfinishedPrivateWork(
      privateWorkToken(proposal?.optString("kind") ?: "operation"),
      privateWorkToken(blocker.optString("status").ifEmpty { "unknown" }),
    )
  }
  val deposit = deposits.firstOrNull(::depositBlocksPrivateWork)
  if (deposit != null)
    throw DepositPhaseBlocked(privateWorkToken(deposit.optString("phase").ifEmpty { "unknown" }))
}

/**
 * An unsigned paused or preparing draft has not signed spending. A deposit that has already
 * attached work, credited funds, or moved past review can still settle and keeps the lock.
 */
internal fun depositBlocksPrivateWork(row: JSONObject): Boolean {
  val phase = row.optString("phase")
  if (phase in setOf("draft", "invested", "cancelled")) return false
  val children = row.optJSONObject("children")
  if (children != null && children.length() > 0) return true
  val steps = row.optJSONArray("completedSteps")
  if (steps != null && steps.length() > 0) return true
  val credited = row.optString("creditedAtoms")
  if (credited.isNotEmpty() && credited != "0") return true
  if (
    row.optString("pauseReason") in
      setOf("submissionUnknown", "settlementPending", "recoveryRequired")
  )
    return true
  return phase !in setOf("paused", "preparing")
}

internal fun privateWorkPending(row: JSONObject, operations: List<JSONObject>): Boolean {
  val status = row.optString("status")
  if (status in setOf("paid", "finalized", "reverted", "nonceCancelled", "expired")) return false
  if (supersededByLaterInclusion(row, operations)) return false
  val unsignedCancellation =
    (row.optBoolean("cancelled") || status == "cancelled") &&
      !row.has("signedData") &&
      !row.sponsoredSpendSaved() &&
      !row.optBoolean("signingPending") &&
      !row.optBoolean("signingAuthorizationPending")
  return !unsignedCancellation
}

private fun privateWorkToken(value: String) =
  value.takeIf { Regex("[A-Za-z0-9]{1,40}").matches(it) } ?: "unknown"

private fun privateWorkNonce(value: String) =
  value.takeIf { Regex("0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})").matches(it) }?.let(::quantity)

/** Same sender and nonce key: a later included operation has consumed every lower nonce. */
internal fun supersededByLaterInclusion(row: JSONObject, operations: List<JSONObject>): Boolean {
  val proposal = row.optJSONObject("proposal") ?: return false
  val owner = proposal.optString("expectedFrom")
  val chainId = proposal.optLong("chainId", -1)
  val nonce = privateWorkNonce(proposal.optString("nonce")) ?: return false
  if (!Regex("0x[0-9a-fA-F]{40}").matches(owner) || chainId <= 0) return false
  val id = row.optString("operationId")
  return operations.any { other ->
    if (id.isNotEmpty() && other.optString("operationId") == id) return@any false
    val later = other.optJSONObject("proposal") ?: return@any false
    val laterNonce = privateWorkNonce(later.optString("nonce")) ?: return@any false
    other.optString("status") in setOf("finalized", "reverted") &&
      later.optLong("chainId", -1) == chainId &&
      later.optString("expectedFrom").equals(owner, true) &&
      laterNonce > nonce
  }
}

internal fun assertCashoutInactive(
  context: Context,
  record: WalletRecord,
  deposit: Boolean = false,
) {
  check(confidentialWithdrawalJournal(context, record).active() == null) {
    "Resume or cancel Withdraw from Gizu before starting another investment operation"
  }
  if (!deposit) assertNoPrivateDeposit(context, record)
}

internal fun assertPrivateExecutionAvailable(context: Context, record: WalletRecord) {
  assertCashoutInactive(context, record)
  assertNoPrivateDeposit(context, record)
  requireNoPendingSharedCredit(context, record)
  requireNoPendingSharedPayout(context, record)
}
