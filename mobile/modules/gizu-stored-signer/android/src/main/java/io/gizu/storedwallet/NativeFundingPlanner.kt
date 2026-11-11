package io.gizu.storedwallet

import android.content.Context
import java.math.BigInteger
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.planPublicSourceAllocation

internal class PublicFundingMinimum(val minimumAtoms: String) :
  IllegalStateException("Public funding must cover fees, reserve and a usable transfer")

/** Fresh native state and per-owner research sponsorship caps feed the shared integer planner. */
internal class NativeFundingPlanner(
  private val context: Context,
  private val record: WalletRecord,
) {
  suspend fun plan(
    budgetAtoms: String,
    feature: String = "earn",
    depositBudgetAtoms: String = budgetAtoms,
  ): Map<String, Any?> {
    require(feature in setOf("swap", "earn"))
    require(budgetAtoms.matches(Regex("[1-9][0-9]{0,19}")))
    check(record.verified && !record.earnRecoveryRequired)
    if (feature == "earn") {
      requireDistributionBudget(record, depositBudgetAtoms)
      requireSponsoredWallet(record, record.id)
      val funded =
        currentCycleRows(record, earnSponsoredJournal(context, record).all()).any {
          it.getJSONObject("proposal").getString("kind") == "sourceFunding" &&
            (it.sponsoredSpendSaved() || it.sponsoredBlocked())
        }
      check(!funded) { "Resume the saved funding plan or prepare a fresh investment" }
    }
    val reserve = if (feature == "swap") "0" else "10000"
    val budget = budgetAtoms.toBigInteger()
    val ledger = fundingReservations(context, record)
    val snapshot =
      io.gizu.storedwallet.swap
        .MainnetPortfolio(context)
        .read(record, emptyList(), includeOwned = false)
    val known =
      (snapshot["accounts"] as List<*>)
        .map { it as Map<*, *> }
        .filter { (it["balanceAtoms"] as String).toBigInteger() > BigInteger.ZERO }
    val indices = publicAccountIndices(record)
    // Cached candidates reduce discovery work. All selected balances are read freshly below.
    val ordered =
      (known
          .sortedWith(
            compareBy(
              {
                if (
                  (it["balanceAtoms"] as String).toBigInteger() -
                    ledger.reservedAtoms(it["address"] as String).toBigInteger() >= budget
                )
                  0
                else 1
              },
              { (it["accountIndex"] as Number).toInt() },
            )
          )
          .map { (it["accountIndex"] as Number).toInt() } + indices)
        .distinct()
    val chain = EarnSponsoredChainRpc(143)
    check(quantity(chain.text("eth_chainId")) == BigInteger.valueOf(143))
    val block = chain.text("eth_blockNumber")
    val sources = JSONArray()
    var available = BigInteger.ZERO
    val recipient =
      if (feature == "earn") cycleConfidential(record)
      else uniffi.gizu_stored_signer_core.deriveAccountAddressRange(record.entropy, 2u, 1u).single()
    var probed = 0
    for (index in ordered) {
      if (probed++ >= 128) break
      val address = publicAccountAddress(record, index)
      if (ledger.hasUnsettledSigned(address)) continue
      val held =
        BigInteger(
          chain
            .text(
              "eth_call",
              JSONObject()
                .put("to", io.gizu.storedwallet.swap.MainnetPortfolio.USDC)
                .put(
                  "data",
                  "0x70a08231" + address.removePrefix("0x").lowercase().padStart(64, '0'),
                ),
              block,
            )
            .removePrefix("0x"),
          16,
        )
      val reserved = ledger.reservedAtoms(address).toBigInteger()
      val free = held - reserved
      if (free <= reserve.toBigInteger() + BigInteger.TEN) continue
      val request =
        JSONObject()
          .put("owner", address)
          .put("recipient", recipient)
          .put("amount", "1")
          .put("budget", free.toString())
      val raw =
        NativeRpcTransport(EARN_NATIVE_BACKEND.removeSuffix("/native") + "/monad/funding-plan")
          .post(request.toString())
      val fees = JSONObject(raw)
      check(
        fees.getInt("chainId") == 143 &&
          fees.getString("owner").equals(address, true) &&
          fees.getString("token").equals(io.gizu.storedwallet.swap.MainnetPortfolio.USDC, true)
      )
      val cap = fees.getString("feeCap")
      check(cap.matches(Regex("[0-9]+")))
      if (free <= cap.toBigInteger() + reserve.toBigInteger() + BigInteger.TEN) continue
      sources.put(
        JSONObject()
          .put("sourceIndex", index)
          .put("address", address)
          .put("balanceAtoms", held.toString())
          .put("reservedAtoms", reserved.toString())
          .put("fundingFeeAtoms", cap)
          .put("executionReserveAtoms", reserve)
      )
      available += free
      if (free >= budget || available >= budget) break
    }
    if (available < budget && probed >= 128)
      error("Account discovery is still syncing. Retry funding shortly.")
    requireAvailableFunds(available, budget)
    if (feature == "earn") {
      val minimum =
        sources.objects().minOf { source ->
          depositAtoms(source.getString("fundingFeeAtoms")) +
            depositAtoms(source.getString("executionReserveAtoms")) +
            PRIVATE_DEPOSIT_MINIMUM
        }
      if (budget < minimum) throw PublicFundingMinimum(minimum.toString())
    }
    val result =
      JSONObject(planPublicSourceAllocation(record.roleRegistry, budgetAtoms, sources.toString()))
    val id = "funding_" + UUID.randomUUID().toString().replace("-", "")
    val legs = result.getJSONArray("legs")
    for (i in 0 until legs.length()) {
      val leg = legs.getJSONObject(i)
      val source =
        (0 until sources.length()).map(sources::getJSONObject).single {
          it.getInt("sourceIndex") == leg.getInt("sourceIndex")
        }
      leg.put("balanceAtoms", source.getString("balanceAtoms"))
    }
    ledger.reserveBatch(id, feature, if (feature == "earn") record.earnCycleIndex else 0, legs)
    result.put("fundingBatchId", id).put("fundingBatchSize", legs.length())
    return result.keys().asSequence().associateWith { field ->
      if (field == "legs")
        (0 until legs.length()).map { i ->
          val l = legs.getJSONObject(i)
          l.keys().asSequence().associateWith { l.get(it) }
        }
      else result.get(field)
    }
  }
}
