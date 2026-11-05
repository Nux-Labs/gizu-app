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

/** Conservative device-wide private execution exclusion, including saved unknown signatures. */
internal fun assertNoPendingPrivateWork(operations: List<JSONObject>, deposits: List<JSONObject>) {
  check(
    operations.none { row ->
      val status = row.optString("status")
      status !in setOf("paid", "finalized", "reverted", "nonceCancelled") &&
        (!(row.optBoolean("cancelled") || status == "cancelled") ||
          row.has("signedData") ||
          row.sponsoredSpendSaved() ||
          row.optBoolean("signingPending") ||
          row.optBoolean("signingAuthorizationPending"))
    }
  ) {
    "Reconcile unfinished private spending before withdrawing from Gizu"
  }
  check(deposits.none { it.optString("phase") !in setOf("draft", "invested", "cancelled") }) {
    "Finish or cancel the saved deposit before withdrawing from Gizu"
  }
}

internal fun assertCashoutInactive(context: Context, record: WalletRecord) {
  check(confidentialWithdrawalJournal(context, record).active() == null) {
    "Resume or cancel Withdraw from Gizu before starting another investment operation"
  }
}

internal fun assertPrivateExecutionAvailable(context: Context, record: WalletRecord) =
  assertCashoutInactive(context, record)
