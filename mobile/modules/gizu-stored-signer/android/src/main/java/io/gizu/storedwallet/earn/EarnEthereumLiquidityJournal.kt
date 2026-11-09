package io.gizu.storedwallet

import android.content.Context
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

internal val liquidityTerminal = setOf("finalized", "reverted", "expired", "nonceCancelled")

internal fun JSONObject.liquidityRawConsumed() =
  getString("status") in setOf("finalized", "reverted", "nonceCancelled")

internal fun JSONObject.liquidityBlocked() =
  if (has("raw")) !liquidityRawConsumed()
  else
    getString("status") !in liquidityTerminal &&
      (!optBoolean("cancelled") || has("permit") || has("signedOrder"))

internal fun JSONObject.liquidityCancellationAttempts(): List<JSONObject> =
  optJSONArray("cancellationAttempts")?.let { rows ->
    check(rows.length() <= 256)
    (0 until rows.length()).map(rows::getJSONObject)
  } ?: emptyList()

internal fun earnLiquidityJournal(context: Context, record: WalletRecord): EarnLiquidityJournal {
  requireEarnExecutionWallet(record, record.id)
  return EarnLiquidityJournal(
    AndroidWalletFile(context, "gizu-earn-liquidity-${record.journalId}.enc", 4 * 1024 * 1024),
    { checkNotNull(AndroidWalletKeys().existing()) },
    record.id,
    record.journalId,
    earnQuoteJournal(context, record),
  )
}

/** Exact permits, orders and raw transactions are durable private records, never Expo results. */
internal class EarnLiquidityJournal(
  private val file: WalletFile,
  private val key: () -> SecretKey,
  val walletId: String,
  val generation: String,
  val quotes: EarnQuoteJournal? = null,
) {
  private val aad = "gizu-earn-liquidity:v1:$walletId:$generation".toByteArray()

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
    val bytes =
      JSONObject()
        .put("version", 1)
        .put("walletId", walletId)
        .put("operations", rows)
        .toString()
        .toByteArray()
    try {
      check(bytes.size <= 3 * 1024 * 1024)
      file.write(CryptoEnvelope.encrypt(key(), bytes, aad))
    } finally {
      bytes.fill(0)
    }
  }

  fun all(): List<JSONObject> =
    read().let { rows -> (0 until rows.length()).map(rows::getJSONObject) }

  fun get(id: String) = all().single { it.getString("operationId") == id }

  fun create(p: JSONObject): JSONObject {
    val old = all()
    check(
      old.count(::journalEntryPending) < 256 &&
        old.none {
          it.liquidityBlocked() &&
            it
              .getJSONObject("proposal")
              .getString("expectedFrom")
              .equals(p.getString("expectedFrom"), true) ||
            it.getString("operationId") == p.getString("operationId") ||
            it.getJSONObject("proposal").getString("quoteId") == p.getString("quoteId")
        }
    )
    if (p.getString("kind") == "fusionEthOrder") {
      val nonce = liquidityOrderNonce(p.getJSONObject("unsignedOrder"))
      check(
        old.none {
          it
            .optJSONObject("signingProposal")
            ?.optJSONObject("unsignedOrder")
            ?.let(::liquidityOrderNonce) == nonce ||
            it
              .getJSONObject("proposal")
              .optJSONObject("unsignedOrder")
              ?.let(::liquidityOrderNonce) == nonce
        }
      )
    }
    val op =
      JSONObject()
        .put("operationId", p.getString("operationId"))
        .put("walletId", walletId)
        .put("revision", 1)
        .put("proposal", JSONObject(p.toString()))
        .put("status", "planned")
        .put("cancelled", false)
    write(JSONArray(old).put(op))
    return op
  }

  fun update(id: String, revision: Int, change: (JSONObject) -> Unit): JSONObject {
    val rows = read()
    val op =
      (0 until rows.length()).map(rows::getJSONObject).single { it.getString("operationId") == id }
    check(op.getInt("revision") == revision) { "Stale Ethereum liquidity operation" }
    change(op)
    op.put("revision", Math.addExact(revision, 1))
    write(rows)
    return op
  }

  fun cancel(id: String, revision: Int) = update(id, revision) { it.put("cancelled", true) }

  fun public(op: JSONObject): Map<String, Any> = buildMap {
    val p = op.getJSONObject("proposal")
    val status = op.getString("status")
    val minimum =
      if (status == "finalized") savedMinimumReturnReceipt(op, walletId, generation) else null
    put("operationId", op.getString("operationId"))
    put("walletId", walletId)
    put("revision", op.getInt("revision"))
    put("kind", p.getString("kind"))
    put("chainId", 1)
    put("from", p.getString("expectedFrom"))
    put("cycleIndex", p.optInt("cycleIndex", 0))
    if (p.has("investmentSlot")) put("investmentSlot", p.getInt("investmentSlot"))
    put("amountAtoms", p.optString("amountAtoms", p.optString("inputAtoms")))
    put("blocked", op.liquidityBlocked())
    put(
      "canCancelPending",
      op.has("raw") && !op.liquidityRawConsumed() && op.optBoolean("cancellationAllowed"),
    )
    put(
      "canResume",
      op.liquidityCancellationAttempts().isEmpty() &&
        status !in liquidityTerminal &&
        !op.optBoolean("conflict") &&
        !op.optBoolean("cancelled") &&
        (!op.has("raw") && !op.has("signedOrder") || status == "signed"),
    )
    put(
      "status",
      if (status == "finalized")
        when (p.getString("kind")) {
          "fusionEthOrder" -> "fusionFilled"
          "fusionUsdcApproval" -> "approvalFinalized"
          "returnUsdc",
          "returnEth" ->
            if (minimum != null) "minimumReceived"
            else if (op.optJSONObject("settlement")?.optString("status") == "credited") "credited"
            else "awaitingSettlement"
          else -> error("Unsupported liquidity kind")
        }
      else if (status in setOf("cancellationPending", "nonceCancelled")) status
      else if (op.optBoolean("cancelled")) "cancelled" else status,
    )
    for (field in
      listOf(
        "transactionHash",
        "orderHash",
        "actualFeeWei",
        "receivedEthWei",
        "residualShares",
        "residualUsdcAtoms",
        "residualEthWei",
      )) if (op.has(field)) put(field, op.getString(field))
    val cancellations = op.liquidityCancellationAttempts()
    if (cancellations.isNotEmpty()) {
      put(
        "cancellationTransactionHash",
        if (status == "nonceCancelled") op.getString("cancellationWinningTransactionHash")
        else cancellations.last().getString("transactionHash"),
      )
      put("cancellationTransactionHashes", cancellations.map { it.getString("transactionHash") })
    }
    if (minimum != null) {
      put("minimumReturnReceipt", minimumReturnPublic(minimum))
      put("verifiedMinimumAtoms", minimum.getString("verifiedMinimumAtoms"))
    }
    if (status == "finalized" && op.has("settlement"))
      put("settlement", sponsoredSettlementPublic(op.getJSONObject("settlement")))
  }
}

internal fun liquidityOrderNonce(order: JSONObject) =
  order
    .getString("makerTraits")
    .toBigInteger()
    .shiftRight(120)
    .and(java.math.BigInteger.ONE.shiftLeft(40) - java.math.BigInteger.ONE)
