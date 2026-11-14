package io.gizu.storedwallet

import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject

/** Provider outcome is lifecycle evidence, never proof of private credit or spending approval. */
internal fun refundedSponsoredReturn(
  op: JSONObject,
  walletId: String,
  generation: String,
): Boolean {
  val progress = op.optJSONObject("returnRouteProgress") ?: return false
  if (progress.optString("providerRouteStatus") != "REFUNDED") return false
  check(progress.getInt("version") == 1 && progress.getLong("observedAtMs") > 0)
  check(progress.get("spendingAuthorized") == false)
  check(
    nativeJsonEqual(
      progress.getJSONObject("nativeBinding"),
      returnCompletionBinding(op, walletId, generation),
    )
  )
  check(!completedReturnLifecycle(op, walletId, generation))
  return true
}

/** A refund ends continuation authority, including legacy rows without an explicit source ID. */
internal fun withdrawalContinuationNeedsFreshApproval(
  rows: List<JSONObject>,
  redeemId: String,
  walletId: String,
  generation: String,
): Boolean {
  val at = rows.indexOfFirst { it.getString("operationId") == redeemId }
  check(at >= 0)
  val p = rows[at].getJSONObject("proposal")
  for (row in rows.drop(at + 1)) {
    val q = row.getJSONObject("proposal")
    if (
      q.optString("kind") !in setOf("hoodTokenReturn", "hoodDeposit", "hoodRedeemAll") ||
        q.getInt("chainId") != p.getInt("chainId") ||
        !q.getString("expectedFrom").equals(p.getString("expectedFrom"), true) ||
        !nativeJsonEqual(q.opt("cycleIndex") ?: 0, p.opt("cycleIndex") ?: 0) ||
        !nativeJsonEqual(q.opt("investmentSlot"), p.opt("investmentSlot"))
    )
      continue
    // A later confirmed spending primary supersedes the old grant. Cancelled/unsigned drafts
    // do not end legacy source association and cannot hide a refunded return below them.
    if (q.getString("kind") != "hoodTokenReturn") {
      if (row.optString("status") == "finalized" && row.sponsoredSpendSaved()) return true
      continue
    }
    if (
      (!q.has("withdrawalOperationId") || q.getString("withdrawalOperationId") == redeemId) &&
        refundedSponsoredReturn(row, walletId, generation)
    )
      return true
  }
  return false
}

/** Read only the latest unresolved return in this portion; completed history is never reopened. */
internal suspend fun refreshSponsoredReturnProgress(
  journal: EarnSponsoredJournal,
  operationIds: Set<String>,
  rpc: TransferRpc,
  readStatus: suspend (String) -> JSONObject,
  now: Long = System.currentTimeMillis(),
) {
  val op =
    journal.all().lastOrNull {
      it.getString("operationId") in operationIds &&
        it.getJSONObject("proposal").optString("kind") == "hoodTokenReturn"
    } ?: return
  if (
    op.optString("status") != "finalized" ||
      completedReturnLifecycle(op, journal.walletId, journal.generation)
  )
    return
  val previous = op.optJSONObject("returnRouteProgress")
  if (previous != null && now - previous.getLong("observedAtMs") in 0..4999) return
  try {
    val p = op.getJSONObject("proposal")
    val status =
      if (refundedSponsoredReturn(op, journal.walletId, journal.generation)) "REFUNDED"
      else readStatus(p.getString("recipient")).getString("status")
    check(
      status in
        setOf(
          "PENDING_DEPOSIT",
          "KNOWN_DEPOSIT_TX",
          "INCOMPLETE_DEPOSIT",
          "PROCESSING",
          "SUCCESS",
          "REFUNDED",
          "FAILED",
        )
    )
    val cash =
      earnAbiWord(
        rpc.call(
          "eth_call",
          JSONArray()
            .put(
              JSONObject()
                .put("to", HOOD_EARN_USDG)
                .put("data", "0x70a08231${earnAddressWord(p.getString("expectedFrom"))}")
            )
            .put("latest"),
        ) as String
      )
    val progress =
      JSONObject()
        .put("version", 1)
        .put("providerRouteStatus", status)
        .put("observedAtMs", now)
        .put("publicUsdgAtoms", cash.toString())
        .put("spendingAuthorized", false)
        .put("nativeBinding", returnCompletionBinding(op, journal.walletId, journal.generation))
    journal.update(op.getString("operationId"), op.getInt("revision")) {
      it.put("returnRouteProgress", progress)
      it.remove("returnRouteReadUnavailable")
    }
  } catch (cancelled: CancellationException) {
    throw cancelled
  } catch (_: Exception) {
    // Keep the last observation; an unavailable read cannot complete/retry funds.
    runCatching {
      journal.update(op.getString("operationId"), op.getInt("revision")) {
        it.put("returnRouteReadUnavailable", true)
      }
    }
  }
}
