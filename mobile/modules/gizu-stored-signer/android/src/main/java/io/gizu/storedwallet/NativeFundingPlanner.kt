package io.gizu.storedwallet

import android.content.Context
import java.math.BigInteger
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
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
    allowedSourceChainIds: Set<Int>? = null,
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
    require(
      allowedSourceChainIds == null ||
        (allowedSourceChainIds.isNotEmpty() &&
          allowedSourceChainIds.all { it in setOf(143, 8453, 42161) })
    )
    val enabledChains =
      enabledFundingChains().filter { allowedSourceChainIds == null || it in allowedSourceChainIds }
    check(enabledChains.isNotEmpty()) { "The saved funding path has no enabled source network" }
    val ledger = fundingReservations(context, record)
    val snapshot =
      try {
        io.gizu.storedwallet.swap
          .MainnetPortfolio(context)
          .read(record, emptyList(), includeOwned = false)
      } catch (failure: Exception) {
        if (failure is CancellationException) throw failure
        null
      }
    val known =
      ((snapshot?.get("accounts") as? List<*>) ?: emptyList<Any>())
        .map { it as Map<*, *> }
        .filter {
          fundingCandidate((it["accountIndex"] as Number).toInt()) &&
            (it["balanceAtoms"] as String).toBigInteger() > BigInteger.ZERO
        }
    val indices =
      if (143 in enabledChains) publicAccountIndices(record).filter { fundingCandidate(it) }
      else emptyList()
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
    val sources = JSONArray()
    var available = BigInteger.ZERO
    val recipient =
      if (feature == "earn") cycleConfidential(record)
      else uniffi.gizu_stored_signer_core.deriveAccountAddressRange(record.entropy, 2u, 1u).single()
    var probed = 0
    var unavailable = false
    suspend fun observation(index: Int, sourceChainId: Int): JSONObject {
      val address = publicAccountAddress(record, index)
      val network = fundingNetwork(sourceChainId)
      val chain = EarnSponsoredChainRpc(sourceChainId)
      check(quantity(chain.text("eth_chainId")) == sourceChainId.toBigInteger())
      val block = chain.text("eth_blockNumber")
      val held =
        BigInteger(
          chain
            .text(
              "eth_call",
              JSONObject()
                .put("to", network.token)
                .put(
                  "data",
                  "0x70a08231" + address.removePrefix("0x").lowercase().padStart(64, '0'),
                ),
              block,
            )
            .removePrefix("0x"),
          16,
        )
      return JSONObject()
        .put("sourceIndex", index)
        .put("address", address)
        .put("sourceChainId", sourceChainId)
        .put("token", network.token)
        .put("decimals", 6)
        .put("balanceAtoms", held.toString())
        .put("reservedAtoms", ledger.reservedAtoms(address, sourceChainId))
    }
    suspend fun observe(index: Int, chain: Int): JSONObject? =
      try {
        observation(index, chain)
      } catch (failure: Exception) {
        if (failure is CancellationException) throw failure
        null
      }
    // Independent source reads are bounded to the three Account 1 network contexts.
    val observations = coroutineScope {
      enabledChains.map { chainId -> async { observe(1, chainId) } }.awaitAll()
    }
    unavailable = observations.any { it == null }
    val primary =
      observations
        .filterNotNull()
        .sortedWith(
          compareBy(
            {
              if (
                it.getString("balanceAtoms").toBigInteger() -
                  it.getString("reservedAtoms").toBigInteger() >= budget
              )
                0
              else 1
            },
            { it.getInt("sourceChainId") },
          )
        )
        .iterator()
    val legacy = ordered.filter { it != 1 && 143 in enabledChains }.iterator()
    while (primary.hasNext() || legacy.hasNext()) {
      if (probed++ >= 128) break
      val observed = if (primary.hasNext()) primary.next() else observe(legacy.next(), 143)
      if (observed == null) {
        unavailable = true
        continue
      }
      val index = observed.getInt("sourceIndex")
      val sourceChainId = observed.getInt("sourceChainId")
      val network = fundingNetwork(sourceChainId)
      val address = observed.getString("address")
      if (ledger.hasUnsettledSigned(address, sourceChainId)) continue
      val held = observed.getString("balanceAtoms").toBigInteger()
      val reserved = observed.getString("reservedAtoms").toBigInteger()
      val free = held - reserved
      if (free <= reserve.toBigInteger() + BigInteger.TEN) continue
      val request =
        JSONObject()
          .put("owner", address)
          .put("recipient", recipient)
          .put("amount", "1")
          .put("budget", free.toString())
      val raw =
        try {
          NativeRpcTransport(
              if (sourceChainId == 143)
                EARN_NATIVE_BACKEND.removeSuffix("/native") + "/monad/funding-plan"
              else EARN_NATIVE_BACKEND.removeSuffix("/earn/native") + "/funding/$sourceChainId/plan"
            )
            .post(request.toString())
        } catch (failure: Exception) {
          if (failure is CancellationException) throw failure
          unavailable = true
          null
        } ?: continue
      val fees = JSONObject(raw)
      check(
        fees.getInt("chainId") == sourceChainId &&
          fees.getString("owner").equals(address, true) &&
          fees.getString("token").equals(network.token, true)
      )
      val cap = fees.getString("feeCap")
      check(cap.matches(Regex("[0-9]+")))
      if (free <= cap.toBigInteger() + reserve.toBigInteger() + BigInteger.TEN) continue
      sources.put(
        JSONObject()
          .put("sourceIndex", index)
          .put("sourceChainId", sourceChainId)
          .put("token", network.token)
          .put("decimals", 6)
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
    if (available < budget && unavailable)
      error("A funding balance or fee service is unavailable. Retry before spending.")
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
          it.getInt("sourceIndex") == leg.getInt("sourceIndex") &&
            it.getInt("sourceChainId") == leg.getInt("sourceChainId")
        }
      leg.put("balanceAtoms", source.getString("balanceAtoms"))
      leg.put("sourceId", fundingSourceId(leg.getInt("sourceChainId"), leg.getString("address")))
    }
    ledger.reserveBatch(id, feature, if (feature == "earn") record.earnCycleIndex else 0, legs)
    result.put("version", 2).put("fundingBatchId", id).put("fundingBatchSize", legs.length())
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
