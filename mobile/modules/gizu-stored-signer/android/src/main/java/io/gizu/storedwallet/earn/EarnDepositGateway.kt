package io.gizu.storedwallet

import java.math.BigInteger
import org.json.JSONObject

/** Fixed native TLS and operation-local requests; never receives a user account directory. */
internal class EarnDepositGateway(
  private val post: suspend (String, String) -> String = { path, body ->
    NativeRpcTransport(EARN_NATIVE_BACKEND.removeSuffix("/native") + path).post(body)
  },
  private val now: () -> Long = System::currentTimeMillis,
  private val feeValidator: (JSONObject) -> Int = { policy ->
    val total = policy.getInt("totalBps")
    nativeEarnFeePolicy(
      JSONObject().put("providerFeeBps", total).put("feePolicy", policy),
      "providerFeeBps",
      "payoutRobinhood",
    )
    total
  },
) {
  private fun fresh(row: JSONObject) {
    val clock = now()
    val quoted = row.getLong("quotedAtMs")
    check(
      clock - quoted in -5000L..60000L &&
        row.getLong("expiresAtMs") > clock &&
        row.getLong("expiresAtMs") - quoted in 1..60000
    )
  }

  private fun preview(row: JSONObject, assumption: String) {
    check(
      row.getString("kind") == "preview" &&
        row.getBoolean("readOnly") &&
        !row.getBoolean("executionAvailable") &&
        row.getString("assumption") == assumption
    )
    check(
      listOf(
          "operation",
          "proposal",
          "userOperation",
          "calldata",
          "signedData",
          "intent",
          "recoveryEnvelope",
        )
        .none(row::has)
    )
    fresh(row)
  }

  suspend fun payoutPreview(
    record: WalletRecord,
    sourceId: String,
    revision: Int,
    leg: String,
    amount: String,
  ): JSONObject {
    check(record.earnChain == 4663 && leg in cyclePayoutLegs(record))
    val recipient =
      savedCycleDistribution(record)?.let {
        cycleInvestmentAddress(record, distributionSlot(leg, it))
      } ?: cycleAddresses(record)[if (leg == "hold") 0 else 1]
    val request =
      JSONObject()
        .put("profileChainId", 4663)
        .put("operationId", sourceId)
        .put("revision", revision)
        .put("confidentialAccount", cycleConfidential(record))
        .put("recipient", recipient)
        .put("leg", leg)
        .put("amountAtoms", depositAtoms(amount, true).toString())
    val row = JSONObject(post("/native/payout/preview", request.toString()))
    preview(row, "indicative-unfunded-confidential-route")
    check(
      row.getString("operationId") == sourceId &&
        row.getInt("revision") == revision &&
        row.getInt("profileChainId") == 4663
    )
    check(
      row.getString("leg") == leg &&
        row.getString("recipient").equals(recipient, true) &&
        row.getString("amountAtoms") == amount
    )
    earnHash(row.getString("referenceHash"))
    val minimum = depositAtoms(row.getString("minimumOutputAtoms"), true)
    check(minimum <= depositAtoms(row.getString("estimatedOutputAtoms"), true))
    val fees = feeValidator(row.getJSONObject("feePolicy"))
    check(fees in 0..100)
    return row.put("providerFeeBps", fees)
  }

  suspend fun depositPreview(
    record: WalletRecord,
    id: String,
    revision: Int,
    expected: String,
    starting: String = "0",
    slot: Int? = null,
  ): JSONObject {
    val owner = cycleInvestmentAddress(record, slot)
    val request =
      JSONObject()
        .put("owner", owner)
        .put("operationId", id)
        .put("revision", revision)
        .put("expectedUsdgAtoms", expected)
        .put("startingUsdgAtoms", starting)
    val row = JSONObject(post("/robinhood/deposit-preview", request.toString()))
    preview(row, "hypothetical-USDG-funding-isolated-fork")
    check(
      row.getString("operationId") == id &&
        row.getInt("revision") == revision &&
        row.getString("expectedUsdgAtoms") == expected
    )
    check(row.getString("profileId") == "robinhood-usdg" && row.getInt("chainId") == 4663)
    check(
      row.getString("owner").equals(owner, true) &&
        row.getString("token").equals(HOOD_EARN_USDG, true) &&
        row.getString("vault").equals(HOOD_EARN_VAULT, true)
    )
    check(row.optString("startingUsdgAtoms", "0") == starting)
    val assets = depositAtoms(row.getString("depositAmount"), true)
    val fee = depositAtoms(row.getString("depositFeeBudget"), true)
    val reserve = depositAtoms(row.getString("withdrawalReserve"), true)
    check(assets + fee + reserve <= depositAtoms(expected, true))
    check(row.getInt("shareDecimals") in 0..18)
    val shares = depositAtoms(row.getString("previewShares"), true)
    val price = depositAtoms(row.getString("maxSharePrice"), true)
    val minimumShares = assets * BigInteger.TEN.pow(27) / price
    check(minimumShares.signum() > 0 && minimumShares <= shares)
    return row.put("minimumSharesAtoms", minimumShares.toString())
  }

  suspend fun depositPlan(
    record: WalletRecord,
    id: String,
    attributed: String,
    slot: Int? = null,
  ): Pair<JSONObject, JSONObject> {
    val owner = cycleInvestmentAddress(record, slot)
    val row =
      JSONObject(
        post(
          "/robinhood/deposit-plan",
          JSONObject().put("owner", owner).put("operationId", id).put("revision", 1).toString(),
        )
      )
    fresh(row)
    check(
      row.getString("operationId") == id &&
        row.getInt("revision") == 1 &&
        row.getString("profileId") == "robinhood-usdg" &&
        row.getInt("chainId") == 4663
    )
    check(
      row.getBoolean("readOnly") &&
        !row.getBoolean("executionAvailable") &&
        row.getString("paymasterDataStatus") == "stub"
    )
    for ((field, address) in
      listOf(
        "owner" to owner,
        "token" to HOOD_EARN_USDG,
        "vault" to HOOD_EARN_VAULT,
        "router" to HOOD_EARN_ROUTER,
        "entryPoint" to EARN_ENTRY_POINT,
        "paymaster" to EARN_PAYMASTER,
      )) check(row.getString(field).equals(address, true))
    earnHash(row.getString("planHash"))
    earnHash(row.getString("referenceBlockHash"))
    val starting = row.getJSONObject("startingBalances")
    val budget = depositAtoms(starting.getString("usdg"), true)
    check(budget <= depositAtoms(attributed, true)) {
      "Unattributed USDG cannot enter this deposit budget"
    }
    check(
      starting.getString("shares") == "0" &&
        starting.getString("nativeEth") == "0" &&
        starting.getString("wrappedNative") == "0"
    )
    val fees = row.getJSONObject("fees")
    check(
      fees.getInt("priceHeadroomBps") == 1000 &&
        fees.getInt("operationBudgetHeadroomBps") == 500 &&
        fees.getInt("withdrawalReserveMultiplierBps") == 26000
    )
    val cap = depositAtoms(row.getString("depositQuoteCap"), true)
    val fee = depositAtoms(row.getString("depositFeeBudget"), true)
    val withdrawal = depositAtoms(row.getString("withdrawalQuoteCap"), true)
    val reserve = depositAtoms(row.getString("withdrawalReserve"), true)
    val amount = depositAtoms(row.getString("depositAmount"), true)
    check(fee == (cap * BigInteger.valueOf(105) + BigInteger.valueOf(99)) / BigInteger.valueOf(100))
    check(
      reserve ==
        (withdrawal * BigInteger.valueOf(260) + BigInteger.valueOf(99)) / BigInteger.valueOf(100)
    )
    check(amount + fee + reserve == budget)
    val raw = row.getJSONObject("operation")
    val unsigned = JSONObject()
    for (field in
      listOf(
        "sender",
        "nonce",
        "callData",
        "callGasLimit",
        "verificationGasLimit",
        "preVerificationGas",
        "paymasterVerificationGasLimit",
        "paymasterPostOpGasLimit",
        "maxFeePerGas",
        "maxPriorityFeePerGas",
        "paymaster",
        "paymasterData",
      )) unsigned.put(field, raw.getString(field))
    for (field in listOf("factory", "factoryData")) if (raw.has(field))
      unsigned.put(field, raw.getString(field))
    unsigned.put("signature", "0x")
    val deadline = depositAtoms(row.getString("deadline"), true).longValueExact()
    check(deadline > now() / 1000 && deadline <= now() / 1000 + 600)
    val proposal =
      JSONObject()
        .put("kind", "hoodDeposit")
        .put("operationId", id)
        .put("revision", 1)
        .put("profileChainId", 4663)
        .put("chainId", 4663)
        .put("cycleIndex", record.earnCycleIndex)
        .put("expectedFrom", owner)
        .put("token", HOOD_EARN_USDG)
        .put("vault", HOOD_EARN_VAULT)
        .put("router", HOOD_EARN_ROUTER)
        .put("amountAtoms", amount.toString())
        .put("budgetAtoms", budget.toString())
        .put("maximumTokenFeeAtoms", fee.toString())
        .put("withdrawalReserveAtoms", reserve.toString())
        .put("nonce", unsigned.getString("nonce"))
        .put("deadline", deadline)
        .put("slippageBps", 10)
    if (slot != null) proposal.put("investmentSlot", slot)
    return proposal to unsigned
  }
}

/** Display totals preserve each slot's independently reviewed fee, reserve and share floor. */
internal fun aggregateDepositBounds(deposits: List<JSONObject>): JSONObject {
  check(deposits.isNotEmpty())
  val decimals = deposits.first().getInt("shareDecimals")
  check(deposits.all { it.getInt("shareDecimals") == decimals })
  return JSONObject().put("shareDecimals", decimals).also { aggregate ->
    for (field in
      listOf(
        "estimatedAssetsAtoms",
        "minimumAssetsAtoms",
        "minimumSharesAtoms",
        "maximumFeeAtoms",
        "withdrawalReserveAtoms",
      )) {
      aggregate.put(
        field,
        deposits
          .fold(BigInteger.ZERO) { sum, deposit ->
            sum + depositAtoms(deposit.getString(field), true)
          }
          .toString(),
      )
    }
  }
}
