package io.gizu.storedwallet

import org.json.JSONArray
import org.json.JSONObject

internal object DistributionDepositFixtures {
  fun record(weights: List<Int> = listOf(4000, 6000)): WalletRecord =
    WalletRecord(
      DepositFixtures.wallet,
      StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
      ByteArray(32),
      true,
      DepositFixtures.wallet,
      INITIAL_ROLE_REGISTRY,
      4663,
      false,
      0,
      JSONArray()
        .put(
          JSONObject()
            .put("cycleIndex", 0)
            .put("chainId", 4663)
            .put(
              "distribution",
              JSONObject().put("version", 1).put("weightsBps", JSONArray(weights)),
            )
        )
        .toString(),
    )

  fun review(record: WalletRecord, credits: List<String> = listOf("990000")): JSONObject {
    // Build source policy from the legacy fixture, replacing every destination-specific term.
    val base = DepositFixtures.record().use { DepositFixtures.review(it) }
    val distribution = checkNotNull(savedCycleDistribution(record))
    val addresses = cycleAddresses(record)
    val amounts = MutableList(addresses.size) { java.math.BigInteger.ZERO }
    val sources = JSONArray()
    val rows = JSONArray()
    val reservationLegs = JSONArray()
    var offset = java.math.BigInteger.ZERO
    var budget = java.math.BigInteger.ZERO
    for ((index, credit) in credits.withIndex()) {
      val source = JSONObject(base.getJSONArray("sources").getJSONObject(0).toString())
      source.remove("hold")
      source.remove("invest")
      val sourceBudget = credit.toBigInteger() + 20000.toBigInteger()
      val row = DepositFixtures.funding(record, index)
      row
        .getJSONObject("proposal")
        .put("amountAtoms", credit)
        .put("budgetAtoms", sourceBudget.toString())
        .put("fundingBatchSize", credits.size)
      rows.put(row)
      source
        .put("operationId", "source$index")
        .put("accountIndex", index)
        .put("address", publicAccountAddress(record, index))
        .put("amountAtoms", credit)
        .put("minimumCreditAtoms", credit)
        .put("budgetAtoms", sourceBudget.toString())
      val allocation = distributionAmounts(distribution, credit.toBigInteger(), offset)
      source.put(
        "allocations",
        JSONArray(
          allocation.mapIndexed { slot, amount ->
            amounts[slot] += amount
            JSONObject()
              .put("recipient", addresses[slot])
              .put("inputAtoms", amount.toString())
              .put("estimatedOutputAtoms", amount.toString())
              .put("minimumOutputAtoms", amount.toString())
              .put("providerFeeBps", 4)
          }
        ),
      )
      sources.put(source)
      reservationLegs.put(
        JSONObject()
          .put("sourceIndex", index)
          .put("address", publicAccountAddress(record, index))
          .put("budgetAtoms", sourceBudget.toString())
          .put("operationId", "source$index")
      )
      offset += credit.toBigInteger()
      budget += sourceBudget
    }
    base
      .put("distribution", distribution)
      .put("destinations", JSONArray(addresses))
      .put("sources", sources)
      .put("fundingRows", rows)
      .put("sourceBudgetAtoms", budget.toString())
    base.getJSONObject("reservation").put("legs", reservationLegs)
    val deposits =
      amounts.mapIndexed { slot, amount ->
        JSONObject()
          .put("slot", slot)
          .put("recipient", addresses[slot])
          .put("estimatedAssetsAtoms", (amount - 21000.toBigInteger()).toString())
          .put("minimumAssetsAtoms", (amount - 21000.toBigInteger()).toString())
          .put("minimumSharesAtoms", (amount - 22000.toBigInteger()).toString())
          .put("shareDecimals", 18)
          .put("maximumFeeAtoms", "10000")
          .put("withdrawalReserveAtoms", "11000")
      }
    base.put("deposits", JSONArray(deposits))
    val aggregate = JSONObject().put("shareDecimals", 18)
    for (field in
      listOf(
        "estimatedAssetsAtoms",
        "minimumAssetsAtoms",
        "minimumSharesAtoms",
        "maximumFeeAtoms",
        "withdrawalReserveAtoms",
      )) aggregate.put(
      field,
      deposits
        .fold(java.math.BigInteger.ZERO) { n, d -> n + d.getString(field).toBigInteger() }
        .toString(),
    )
    return base.put("deposit", aggregate)
  }

  fun payout(record: WalletRecord, slot: Int): JSONObject {
    val bound =
      review(record)
        .getJSONArray("sources")
        .getJSONObject(0)
        .getJSONArray("allocations")
        .getJSONObject(slot)
    val row = DepositFixtures.record().use { DepositFixtures.payout(it) }
    row.put("operationId", "payout-source0-invest_$slot")
    row
      .getJSONObject("proposal")
      .put("distribution", savedCycleDistribution(record))
      .put("leg", "invest:$slot")
      .put("expectedRecipient", bound.getString("recipient"))
      .put("amountAtoms", bound.getString("inputAtoms"))
      .put("minimumDestinationAtoms", bound.getString("minimumOutputAtoms"))
    return row
  }

  fun deposit(record: WalletRecord, slot: Int): JSONObject {
    val bound = review(record).getJSONArray("deposits").getJSONObject(slot)
    val row = DepositFixtures.record().use { DepositFixtures.deposit(it) }
    row.put("operationId", "deposit$slot")
    row
      .getJSONObject("proposal")
      .put("operationId", "deposit$slot")
      .put("investmentSlot", slot)
      .put("expectedFrom", bound.getString("recipient"))
      .put("amountAtoms", bound.getString("estimatedAssetsAtoms"))
      .put(
        "budgetAtoms",
        (bound.getString("estimatedAssetsAtoms").toBigInteger() + 21000.toBigInteger()).toString(),
      )
    return row
  }
}
