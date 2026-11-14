package io.gizu.storedwallet

import org.json.JSONArray
import org.json.JSONObject

internal suspend fun readReturnVaultEmpty(expected: JSONObject, rpc: TransferRpc): Boolean =
  earnAbiWord(
      rpc.call(
        "eth_call",
        JSONArray()
          .put(
            JSONObject()
              .put("to", HOOD_EARN_VAULT)
              .put("data", "0x70a08231${earnAddressWord(expected.getString("sourceOwner"))}")
          )
          .put("latest"),
      ) as String
    )
    .signum() == 0

/**
 * Lifecycle metadata only. Never use an owner's report as authenticated credit or spending
 * authority.
 */
internal fun returnCompletionBinding(
  op: JSONObject,
  walletId: String,
  generation: String,
): JSONObject {
  check(op.getString("walletId") == walletId && generation.isNotEmpty())
  check(op.getString("status") == "finalized" && op.sponsoredSpendSaved())
  val proposal = op.getJSONObject("proposal")
  check(proposal.getString("kind") == "hoodTokenReturn" && proposal.getInt("chainId") == 4663)
  earnHash(op.getString("transactionHash"))
  return JSONObject()
    .put("walletId", walletId)
    .put("generation", generation)
    .put("operationId", op.getString("operationId"))
    .put("proposal", JSONObject(proposal.toString()))
    .put("stateBinding", JSONObject(op.getJSONObject("stateBinding").toString()))
    .put("transactionHash", op.getString("transactionHash"))
}

internal fun ownerReportedReturnCompleted(
  op: JSONObject,
  walletId: String,
  generation: String,
): Boolean {
  val saved = op.optJSONObject("returnFlowCompletion") ?: return false
  check(saved.getInt("version") == 1 && saved.getString("source") == "owner-confirmed")
  check(saved.getString("providerRouteStatus") == "SUCCESS")
  check(saved.get("vaultEmpty") is Boolean)
  check(saved.get("spendingAuthorized") == false && saved.getLong("recordedAtMs") > 0)
  check(
    nativeJsonEqual(
      saved.getJSONObject("nativeBinding"),
      returnCompletionBinding(op, walletId, generation),
    )
  )
  return true
}

internal fun ownerReceivedReturnRecord(
  op: JSONObject,
  walletId: String,
  generation: String,
  now: Long,
  providerRouteStatus: String,
  vaultEmpty: Boolean,
): JSONObject {
  check(now > 0 && providerRouteStatus == "SUCCESS")
  return JSONObject()
    .put("version", 1)
    .put("source", "owner-confirmed")
    .put("recordedAtMs", now)
    .put("spendingAuthorized", false)
    .put("providerRouteStatus", providerRouteStatus)
    .put("vaultEmpty", vaultEmpty)
    .put("nativeBinding", returnCompletionBinding(op, walletId, generation))
}

/**
 * Display/reconciliation lifecycle only; signing still requires its existing authenticated credit
 * checks.
 */
internal fun completedReturnLifecycle(
  op: JSONObject,
  walletId: String,
  generation: String,
): Boolean =
  op.optString("status") == "finalized" &&
    (op.optJSONObject("settlement")?.optString("status") == "credited" ||
      savedMinimumReturnReceipt(op, walletId, generation) != null ||
      ownerReportedReturnCompleted(op, walletId, generation))
