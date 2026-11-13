package io.gizu.storedwallet

import org.json.JSONObject
import uniffi.gizu_stored_signer_core.EarnReadAuthentication

/** Fixed facts only: no wallet identity, amounts, envelopes, signatures or provider text. */
internal fun sponsoredSettlementReadFacts(op: JSONObject): String {
  val state = op.optJSONObject("stateBinding")
  val baseline = state?.optJSONObject("privateBaseline")
  val quote = state?.optJSONObject("routeProof")
  val minimum = quote?.optString("minimumCreditAtoms")?.takeIf { it.isNotEmpty() }
  val maximum = quote?.optString("maximumCreditAtoms")?.takeIf { it.isNotEmpty() }
  return "baselinePresent=${baseline != null} baselineZero=${baseline?.optString("available") == "0"} estimateEqualsMinimum=${minimum != null && minimum == maximum}"
}

/** Expectation is assembled from authenticated native quote + verified origin receipt only. */
internal fun sponsoredSettlementExpected(op: JSONObject): JSONObject {
  check(op.getString("status") == "finalized")
  val p = op.getJSONObject("proposal")
  check(p.getString("kind") in setOf("sourceFunding", "hoodTokenReturn", "returnUsdc", "returnEth"))
  val proof = op.getJSONObject("stateBinding").getJSONObject("routeProof")
  check(
    proof.getString("operationId") == op.getString("operationId") &&
      proof.getLong("revision") == p.getLong("revision")
  )
  check(
    proof.getString("amountAtoms") == p.getString("amountAtoms") &&
      proof.getString("recipient").equals(p.getString("recipient"), true) &&
      proof.getString("confidentialAccount").equals(p.getString("confidentialAccount"), true)
  )
  check(proof.getString("refundOwner").equals(p.getString("expectedFrom"), true))
  earnHash(op.getString("transactionHash"))
  earnHash(proof.getString("authenticatedBodyHash"))
  earnNumberWord(proof.getString("minimumCreditAtoms"))
  val expected =
    JSONObject()
      .put("operationId", op.getString("operationId"))
      .put("revision", op.getInt("revision"))
      .put("depositAddress", proof.getString("recipient"))
      .put("sourceOwner", p.getString("expectedFrom"))
      .put("confidentialAccount", proof.getString("confidentialAccount"))
      .put("originAsset", proof.getString("originAsset"))
      .put("amountAtoms", proof.getString("amountAtoms"))
      .put("minimumCreditAtoms", proof.getString("minimumCreditAtoms"))
      .put("transactionHash", op.getString("transactionHash"))
  op.getJSONObject("stateBinding").optJSONObject("privateBaseline")?.let {
    expected
      .put("baselineEnvelope", it.getString("baselineEnvelope"))
      .put("quoteEnvelope", proof.getString("recoveryEnvelope"))
      .put("maximumCreditAtoms", proof.getString("maximumCreditAtoms"))
  }
  op
    .optJSONObject("settlement")
    ?.optString("settlementEnvelope")
    ?.takeIf { it.isNotEmpty() }
    ?.let { expected.put("settlementEnvelope", it) }
  return expected
}

internal fun validateSponsoredSettlement(
  text: String,
  expected: JSONObject,
  now: Long = System.currentTimeMillis(),
): JSONObject {
  val row = JSONObject(text)
  check(
    row.optString("verification") != "minimum-return-v1" &&
      !row.has("verifiedMinimumAtoms") &&
      !row.has("minimumReturnEnvelope")
  )
  check(row.getBoolean("authenticated") && row.getBoolean("operationScoped"))
  check(
    row.getString("operationId") == expected.getString("operationId") &&
      row.getInt("revision") == expected.getInt("revision")
  )
  check(
    row.getString("confidentialAddress").equals(expected.getString("confidentialAccount"), true) &&
      row.getString("assetId") == EARN_MONAD_ASSET
  )
  check(
    row.getString("depositAddress").equals(expected.getString("depositAddress"), true) &&
      row.getString("transactionHash").equals(expected.getString("transactionHash"), true)
  )
  check(now - row.getLong("timestampMs") in -5000L..60000L)
  if (expected.has("baselineEnvelope")) {
    check(row.getString("verification") in setOf("balance-delta-v1", "operation-history-v1"))
    if (row.getString("status") == "credited")
      check(row.getString("settlementEnvelope").isNotEmpty())
  }
  val credited = row.getString("creditedAtoms")
  earnNumberWord(credited)
  val historyVerified =
    expected.has("baselineEnvelope") && row.optString("verification") == "operation-history-v1"
  if (expected.has("maximumCreditAtoms") && !historyVerified)
    check(credited.toBigInteger() <= expected.getString("maximumCreditAtoms").toBigInteger())
  when (row.getString("status")) {
    "credited" ->
      check(credited.toBigInteger() >= expected.getString("minimumCreditAtoms").toBigInteger())
    "awaitingSettlement" -> check(credited == "0")
    else -> error("Unsupported settlement status")
  }
  return row
}

internal fun sponsoredSettlementPublic(row: JSONObject): Map<String, Any> = buildMap {
  for (field in
    listOf(
      "operationId",
      "confidentialAddress",
      "assetId",
      "depositAddress",
      "transactionHash",
      "creditedAtoms",
      "status",
    )) put(field, row.getString(field))
  put("revision", row.getInt("revision"))
  put("timestampMs", row.getLong("timestampMs"))
  put("authenticated", true)
  put("operationScoped", true)
}

internal fun sponsoredSettlementRequestHeaders(operation: JSONObject?): Map<String, String> =
  buildMap {
    val capability = sponsoredSettlementCapability(operation)
    put("x-gizu-settlement-proof", capability)
  }

internal suspend fun readNativeSponsoredSettlement(
  auth: EarnReadAuthentication,
  expected: JSONObject,
  operation: JSONObject? = null,
): JSONObject {
  val capability = sponsoredSettlementCapability(operation)
  val request =
    JSONObject()
      .put(
        "signedData",
        JSONObject()
          .put("standard", "erc191")
          .put("payload", auth.payload)
          .put("signature", auth.signature),
      )
      .put("expected", expected)
  val response =
    NativeRpcTransport(
        "$EARN_NATIVE_BACKEND/settlement",
        requestHeaders = sponsoredSettlementRequestHeaders(operation),
      )
      .post(request.toString())
  return if (capability == "minimum-return-v1")
    validateMinimumReturnObservation(
      response,
      expected,
      operation!!.getJSONObject("proposal").getString("kind"),
    )
  else validateSponsoredSettlement(response, expected)
}

/** Read-only authentication uses the same existing native authority, never another passkey. */
internal suspend fun nativeCycleReadAuth(
  store: WalletStore,
  authority: () -> Unit,
  address: String? = null,
): EarnReadAuthentication {
  authority()
  val salt = ConfidentialBalance().salt()
  val random = ByteArray(7).also { java.security.SecureRandom().nextBytes(it) }
  val started = System.currentTimeMillis()
  authority()
  return store.load().use { record ->
    requireSponsoredWallet(record, record.id)
    cycleReadAuth(
      record,
      salt,
      random,
      started.toULong(),
      System.currentTimeMillis().toULong(),
      address ?: cycleConfidential(record),
    )
  }
}

internal suspend fun readNativeSponsoredBaseline(
  auth: EarnReadAuthentication,
  address: String,
): JSONObject {
  val signed =
    JSONObject()
      .put("standard", "erc191")
      .put("payload", auth.payload)
      .put("signature", auth.signature)
  val text =
    NativeRpcTransport("$EARN_NATIVE_BACKEND/settlement-baseline")
      .post(JSONObject().put("signedData", signed).toString())
  ConfidentialBalance.publicBalance(text, address, System.currentTimeMillis())
  return JSONObject(text).also { check(it.getString("baselineEnvelope").isNotEmpty()) }
}
