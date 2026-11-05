package io.gizu.storedwallet

import java.math.BigInteger
import java.security.SecureRandom
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.chooseBuyLegs

internal fun distributionWeights(plan: JSONObject): List<Int> {
  require(plan.keys().asSequence().toSet() == setOf("version", "weightsBps"))
  require(plan.get("version") is Number && plan.getDouble("version") == 1.0)
  val rows = plan.getJSONArray("weightsBps")
  require(rows.length() in 1..5)
  return (0 until rows.length())
    .map {
      val value = rows.get(it) as? Number ?: error("Invalid distribution weight")
      require(value.toDouble() == value.toInt().toDouble() && value.toInt() in 1..10000)
      value.toInt()
    }
    .also { require(it.sum() == 10000) }
}

internal fun chooseEarnDistribution(budgetAtoms: String): JSONObject {
  val random = ByteArray(32).also { SecureRandom().nextBytes(it) }
  return try {
    val choice = chooseBuyLegs(budgetAtoms, random)
    JSONObject()
      .put("version", 1)
      .put("weightsBps", JSONArray(choice.weights.map { it.toInt() }))
      .also { check(distributionWeights(it).size == choice.count.toInt()) }
  } finally {
    random.fill(0)
  }
}

internal fun savedEarnCycle(record: WalletRecord): JSONObject? =
  JSONArray(record.earnCycles).objects().singleOrNull {
    it.getInt("cycleIndex") == record.earnCycleIndex
  }

internal fun savedCycleDistribution(record: WalletRecord): JSONObject? =
  savedEarnCycle(record)?.optJSONObject("distribution")?.also { distributionWeights(it) }

internal fun selectedInvestmentSlot(record: WalletRecord): Int? =
  savedCycleDistribution(record)?.let { distribution ->
    val slot = savedEarnCycle(record)!!.optInt("investmentSlot", 0)
    require(slot in distributionWeights(distribution).indices)
    slot
  }

internal fun cyclePayoutLegs(record: WalletRecord): List<String> =
  savedCycleDistribution(record)?.let {
    distributionWeights(it).indices.map { slot -> "invest:$slot" }
  } ?: listOf("hold", "invest")

internal fun distributionSlot(leg: String, distribution: JSONObject): Int {
  require(leg.matches(Regex("invest:[0-4]")))
  return leg.substringAfter(':').toInt().also {
    require(it in distributionWeights(distribution).indices)
  }
}

/** Slot authority always comes from encrypted persisted cycle metadata. */
internal fun attachInvestmentSlot(record: WalletRecord, proposal: JSONObject): JSONObject {
  val slot = selectedInvestmentSlot(record)
  if (slot == null) check(!proposal.has("investmentSlot"))
  else {
    if (proposal.has("investmentSlot"))
      check(proposal.getDouble("investmentSlot") == slot.toDouble())
    proposal.put("investmentSlot", slot)
  }
  return proposal
}

internal fun requireSavedDistribution(record: WalletRecord, proposal: JSONObject) {
  val saved = savedCycleDistribution(record)
  if (saved == null) check(!proposal.has("distribution"))
  else {
    val actual = proposal.getJSONObject("distribution")
    check(distributionWeights(actual) == distributionWeights(saved))
    distributionSlot(proposal.getString("leg"), saved)
  }
}

internal fun distributionAmounts(
  distribution: JSONObject,
  credit: BigInteger,
  offset: BigInteger,
): List<BigInteger> {
  val weights = distributionWeights(distribution)
  require(credit.signum() > 0 && offset.signum() >= 0 && (credit + offset).bitLength() <= 256)
  fun allocate(total: BigInteger): List<BigInteger> {
    val initial = weights.dropLast(1).map { total * it.toBigInteger() / BigInteger.valueOf(10000) }
    return initial + (total - initial.fold(BigInteger.ZERO, BigInteger::add))
  }
  return allocate(offset + credit)
    .zip(allocate(offset)) { end, start -> end - start }
    .also {
      require(it.all { amount -> amount.signum() > 0 }) { "Distribution has an unfundable wallet" }
    }
}

internal fun requireDistributionBudget(record: WalletRecord, budgetAtoms: String) {
  check(savedEarnCycle(record)?.optBoolean("depositAbandoned") != true) {
    "Prepare a new deposit after discarding an unsigned draft"
  }
  savedEarnCycle(record)
    ?.takeIf { it.has("distributionBudgetAtoms") }
    ?.let {
      check(it.getString("distributionBudgetAtoms") == budgetAtoms) {
        "Use the saved deposit budget or prepare a fresh investment"
      }
    }
}

internal fun activeDepositDrafts(
  record: WalletRecord,
  journeys: List<JSONObject>,
): List<JSONObject> {
  val abandoned =
    JSONArray(record.earnCycles)
      .objects()
      .filter { it.optBoolean("depositAbandoned") }
      .map { it.getString("depositJourneyId") }
      .toSet()
  return journeys.filter {
    it.getString("phase") != "invested" && it.getString("journeyId") !in abandoned
  }
}
