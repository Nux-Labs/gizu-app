package io.gizu.storedwallet.portfolio

import io.gizu.storedwallet.fundingCandidate
import io.gizu.storedwallet.fundingNetwork
import io.gizu.storedwallet.fundingSourceId
import java.math.BigInteger

internal data class FundingObservation(
  val sourceChainId: Int,
  val accountIndex: Int,
  val owner: String,
  val balanceAtoms: String?,
  val checkedAt: Long,
  val complete: Boolean,
  val stale: Boolean,
  val syncPending: Boolean,
  val reservedAtoms: String? = "0",
)

internal fun fundingIncludedAtoms(
  chain: Int,
  token: String,
  balances: Map<String, String>,
  owners: Set<String>,
): String {
  if (chain !in setOf(143, 8453, 42161) || !token.equals(fundingNetwork(chain).token, true))
    return "0"
  val normalized = owners.map(String::lowercase).toSet()
  return balances.entries
    .filter { it.key.lowercase() in normalized }
    .fold(BigInteger.ZERO) { sum, entry -> sum + entry.value.toBigInteger() }
    .toString()
}

/** Public funding observations only; private USDC is owned by its existing reader. */
internal fun fundingPortfolio(observations: List<FundingObservation>): Map<String, Any?> {
  val seen = mutableSetOf<String>()
  var observed = BigInteger.ZERO
  var available = BigInteger.ZERO
  val rows =
    observations.map { source ->
      val network = fundingNetwork(source.sourceChainId)
      require(fundingCandidate(source.accountIndex, source.sourceChainId))
      require(source.owner.matches(Regex("0x[0-9a-fA-F]{40}")))
      require(seen.add(fundingSourceId(source.sourceChainId, source.owner)))
      fun amount(value: String?) =
        value?.let {
          require(it.matches(Regex("0|[1-9][0-9]{0,77}")))
          it.toBigInteger().also { number -> require(number.bitLength() <= 256) }
        }
      val balance = amount(source.balanceAtoms)
      val reserved = amount(source.reservedAtoms)
      val fresh = balance != null && source.complete && !source.stale && !source.syncPending
      val spendable =
        if (fresh && reserved != null) (balance!! - reserved).max(BigInteger.ZERO) else null
      observed += balance ?: BigInteger.ZERO
      available += spendable ?: BigInteger.ZERO
      require(observed.bitLength() <= 256 && available.bitLength() <= 256)
      mapOf(
        "sourceId" to fundingSourceId(source.sourceChainId, source.owner),
        "sourceChainId" to source.sourceChainId,
        "token" to network.token,
        "decimals" to 6,
        "accountIndex" to source.accountIndex,
        "owner" to source.owner.lowercase(),
        "balanceAtoms" to balance?.toString()?.takeIf { fresh },
        "observedAtoms" to balance?.toString(),
        "reservedAtoms" to reserved?.toString(),
        "availableAtoms" to spendable?.toString(),
        "complete" to (fresh && reserved != null),
        "stale" to !fresh,
        "syncPending" to (source.syncPending || !fresh || reserved == null),
        "checkedAt" to source.checkedAt,
      )
    }
  val complete =
    listOf(143, 8453, 42161).all { chain ->
      observations.any { it.sourceChainId == chain && it.accountIndex == 1 }
    } && rows.all { it["complete"] == true }
  return mapOf(
    "fundingSources" to rows,
    "fundingCash" to
      mapOf(
        "observedAtoms" to observed.toString(),
        "availableAtoms" to available.toString().takeIf { complete },
        "complete" to complete,
        "stale" to rows.any { it["stale"] == true },
        "syncPending" to !complete,
      ),
  )
}
