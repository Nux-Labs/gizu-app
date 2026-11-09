package io.gizu.storedwallet

import org.json.JSONObject

internal val minimumReturnKinds = setOf("hoodTokenReturn", "returnUsdc", "returnEth")

internal fun sponsoredSettlementCapability(op: JSONObject?): String =
  if (
    op?.getJSONObject("proposal")?.optString("kind") in minimumReturnKinds &&
      op?.optJSONObject("settlement")?.optString("status") != "credited"
  )
    "minimum-return-v1"
  else "operation-history-v1"

/** Provider-backed minimum evidence is never an exact credit or a spending allowance. */
internal fun validateMinimumReturnObservation(
  text: String,
  expected: JSONObject,
  kind: String,
  now: Long = System.currentTimeMillis(),
): JSONObject {
  check(kind in minimumReturnKinds)
  check(expected.getString("baselineEnvelope").isNotEmpty())
  check(expected.getString("quoteEnvelope").isNotEmpty())
  val origin =
    when (kind) {
      "hoodTokenReturn" -> EARN_HOOD_ASSET
      "returnEth" -> ETH_NATIVE_ORIGIN_ASSET
      else -> ETH_USDC_ORIGIN_ASSET
    }
  check(expected.getString("originAsset") == origin)
  val row = JSONObject(text)
  check(row.get("authenticated") == true && row.get("operationScoped") == true)
  check(row.get("spendingAuthorized") == false && row.get("exactAmountKnown") == false)
  check(row.getString("verification") == "minimum-return-v1")
  check(row.getString("operationId") == expected.getString("operationId"))
  check(
    row.get("revision") is Number &&
      row.get("revision").toString() == expected.getInt("revision").toString()
  )
  check(row.getInt("revision") > 0)
  check(
    row.getString("confidentialAddress").equals(expected.getString("confidentialAccount"), true)
  )
  check(row.getString("depositAddress").equals(expected.getString("depositAddress"), true))
  check(row.getString("transactionHash").equals(expected.getString("transactionHash"), true))
  check(row.getString("assetId") == EARN_MONAD_ASSET)
  for (field in
    listOf("creditedAtoms", "settlementEnvelope", "sourceCreditEnvelope", "sourceCredit")) check(
    !row.has(field)
  )
  for (field in listOf("timestampMs", "observedAtMs")) {
    check(row.get(field) is Number && row.get(field).toString() == row.getLong(field).toString())
    check(row.getLong(field) > 0)
  }
  val timestamp = row.getLong("timestampMs")
  check(timestamp >= now - 60000L && timestamp <= now + 5000L)
  // A replay retains the original evidence time; only the response must be fresh.
  check(row.getLong("observedAtMs") <= timestamp + 5000L)
  val minimum = row.getString("verifiedMinimumAtoms")
  earnNumberWord(minimum)
  when (row.getString("status")) {
    "minimumReceived" -> {
      check(
        minimum == expected.getString("minimumCreditAtoms") && minimum.toBigInteger().signum() > 0
      )
      check(row.getString("minimumReturnEnvelope").isNotEmpty())
    }
    "awaitingSettlement" -> check(minimum == "0" && !row.has("minimumReturnEnvelope"))
    else -> error("Unsupported minimum return status")
  }
  return row
}

internal fun validateMinimumReturnReceipt(
  text: String,
  expected: JSONObject,
  kind: String,
  now: Long = System.currentTimeMillis(),
): JSONObject =
  validateMinimumReturnObservation(text, expected, kind, now).also {
    check(it.getString("status") == "minimumReceived")
  }

private fun minimumReturnBinding(op: JSONObject, walletId: String, generation: String): JSONObject {
  check(op.getString("walletId") == walletId && generation.isNotEmpty())
  return JSONObject()
    .put("walletId", walletId)
    .put("generation", generation)
    .put("proposal", JSONObject(op.getJSONObject("proposal").toString()))
    .put("stateBinding", JSONObject(op.getJSONObject("stateBinding").toString()))
    .put("transactionHash", op.getString("transactionHash"))
}

/** Kept only in the encrypted journal; public results omit the native binding and envelope. */
internal fun bindMinimumReturnReceipt(
  op: JSONObject,
  proof: JSONObject,
  walletId: String,
  generation: String,
): JSONObject {
  check(op.sponsoredSpendSaved() && op.getString("status") == "finalized")
  val proposal = op.getJSONObject("proposal")
  val kind = proposal.getString("kind")
  val chain = if (kind == "hoodTokenReturn") 4663 else 1
  check(proposal.getInt("chainId") == chain && proposal.optInt("profileChainId", chain) == chain)
  check(if (kind == "hoodTokenReturn") op.has("signedUserOperation") else op.has("raw"))
  validateMinimumReturnReceipt(
    proof.toString(),
    sponsoredSettlementExpected(op).put("revision", proof.getInt("revision")),
    kind,
    proof.getLong("timestampMs"),
  )
  check(proof.getInt("revision") <= op.getInt("revision"))
  check(op.optJSONObject("settlement")?.optString("status") != "credited")
  return JSONObject(proof.toString())
    .put("nativeBinding", minimumReturnBinding(op, walletId, generation))
}

/** Revalidate original immutable native facts before accepting a committed minimum receipt. */
internal fun savedMinimumReturnReceipt(
  op: JSONObject,
  walletId: String,
  generation: String,
): JSONObject? {
  val proof = op.optJSONObject("minimumReturnReceipt") ?: return null
  check(op.getString("status") == "finalized" && op.sponsoredSpendSaved())
  check(!op.has("settlement"))
  check(proof.getInt("revision") > 0 && proof.getInt("revision") < op.getInt("revision"))
  val binding = proof.getJSONObject("nativeBinding")
  val savedGeneration = binding.getString("generation")
  check(generation == savedGeneration)
  check(nativeJsonEqual(binding, minimumReturnBinding(op, walletId, savedGeneration)))
  validateMinimumReturnReceipt(
    proof.toString(),
    sponsoredSettlementExpected(op).put("revision", proof.getInt("revision")),
    op.getJSONObject("proposal").getString("kind"),
    proof.getLong("timestampMs"),
  )
  return proof
}

internal fun minimumReturnPublic(row: JSONObject): Map<String, Any> = buildMap {
  for (field in
    listOf(
      "operationId",
      "confidentialAddress",
      "assetId",
      "depositAddress",
      "transactionHash",
      "verifiedMinimumAtoms",
      "status",
      "verification",
    )) put(field, row.getString(field))
  put("revision", row.getInt("revision"))
  put("timestampMs", row.getLong("timestampMs"))
  put("observedAtMs", row.getLong("observedAtMs"))
  put("authenticated", true)
  put("operationScoped", true)
  put("spendingAuthorized", false)
  put("exactAmountKnown", false)
}

/** Called inside the journal's revision-checked atomic update. */
internal fun saveSponsoredSettlement(
  op: JSONObject,
  proof: JSONObject,
  walletId: String,
  generation: String,
) {
  if (proof.optString("verification") == "minimum-return-v1") {
    check(proof.getInt("revision") == op.getInt("revision"))
    if (proof.getString("status") == "minimumReceived") {
      op.put("minimumReturnReceipt", bindMinimumReturnReceipt(op, proof, walletId, generation))
      op.remove("minimumReturnObservation")
    } else {
      validateMinimumReturnObservation(
        proof.toString(),
        sponsoredSettlementExpected(op),
        op.getJSONObject("proposal").getString("kind"),
        proof.getLong("timestampMs"),
      )
      check(!op.has("minimumReturnReceipt"))
      op.put("minimumReturnObservation", JSONObject(proof.toString()))
    }
    check(op.optJSONObject("settlement")?.optString("status") != "credited")
    op.remove("settlement")
  } else {
    check(!op.has("minimumReturnReceipt"))
    op.put("settlement", proof)
  }
}
