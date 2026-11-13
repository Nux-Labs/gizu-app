package io.gizu.storedwallet

import android.content.Context
import io.gizu.storedwallet.portfolio.NativeOwnedConfidentialPortfolio
import java.math.BigInteger
import java.security.SecureRandom
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.*

internal data class PrivateDepositSelection(
  val sources: List<JSONObject>,
  val publicBudget: String,
)

// A full basis-point unit guarantees a positive allocation for every saved nonzero weight,
// regardless of the cumulative offset. Smaller private dust stays in its existing account.
internal val PRIVATE_DEPOSIT_MINIMUM = BigInteger.valueOf(10000)

/**
 * Aurora rejects a Monad USDC to Robinhood USDG quote below its live bridge minimum. The observed
 * floor on 13 Nov 2026 was 162078 atoms. This leaves room for that floor, and for the funding quote
 * to credit less than the public budget.
 */
internal val PAYOUT_BRIDGE_MINIMUM = BigInteger.valueOf(200_000)

/** Quotes below this are rejected by the live bridge. Do not send them. */
internal val PAYOUT_QUOTE_FLOOR = BigInteger.valueOf(170_000)

internal class DepositBelowRouteMinimum(
  explanation: String = "This deposit is below a route minimum. Review the amount and fees again."
) : IllegalStateException(explanation)

internal fun routeUsdc(amount: BigInteger): String =
  java.math.BigDecimal(amount, 6).stripTrailingZeros().toPlainString()

/** Report authenticated aggregate amounts, without exposing the native account catalogue. */
internal fun requireRoutablePublicRemainder(
  selection: PrivateDepositSelection,
  distribution: JSONObject?,
) {
  val remainder = depositAtoms(selection.publicBudget)
  val minimum = minimumRoutablePublicBudget(distribution)
  if (remainder == BigInteger.ZERO || remainder >= minimum) return
  if (distribution == null)
    throw DepositBelowRouteMinimum(
      "This saved deposit needs at least ${routeUsdc(minimum)} USDC of public funding, but its " +
        "public-funded amount is ${routeUsdc(remainder)} USDC. Lowering the amount will not fix this route minimum."
    )
  val privateAmount =
    selection.sources.fold(BigInteger.ZERO) { sum, source ->
      sum + depositAtoms(source.getString("amountAtoms"), true)
    }
  val explanation =
    if (privateAmount > BigInteger.ZERO)
      "You can deposit ${routeUsdc(privateAmount)} USDC from routable private balances before fees. " +
        "The remaining ${routeUsdc(remainder)} USDC needs public funding, which requires at least " +
        "${routeUsdc(minimum)} USDC. Change the amount to ${routeUsdc(privateAmount)} USDC and review the fees."
    else
      "No private balance can fund this deposit. Each private source needs at least " +
        "${routeUsdc(minimumRoutableSource(distribution))} USDC for this distribution. " +
        "Public funding needs at least ${routeUsdc(minimum)} USDC; this deposit has " +
        "${routeUsdc(remainder)} USDC left to fund. Lowering the amount will not make these balances routable."
  throw DepositBelowRouteMinimum(explanation)
}

/** Public budget that keeps every saved slot at or above [PAYOUT_BRIDGE_MINIMUM]. */
internal fun minimumRoutablePublicBudget(distribution: JSONObject?): BigInteger {
  if (distribution == null) return PAYOUT_BRIDGE_MINIMUM * BigInteger.TEN
  val weight = distributionWeights(distribution).min().toBigInteger()
  val scale = BigInteger.valueOf(10000)
  return (PAYOUT_BRIDGE_MINIMUM * scale + weight - BigInteger.ONE) / weight
}

/** A tiny public top-up must still pay its real quoted overhead; the total budget never changes. */
internal fun rebalancePrivateDepositSources(
  selection: PrivateDepositSelection,
  minimumPublic: String,
): PrivateDepositSelection {
  var public = depositAtoms(selection.publicBudget)
  val minimum = depositAtoms(minimumPublic, true)
  val rows = selection.sources.map { JSONObject(it.toString()) }.toMutableList()
  for (index in rows.indices.reversed()) {
    if (public >= minimum) break
    val amount = depositAtoms(rows[index].getString("amountAtoms"), true)
    val release = minOf(amount, minimum - public)
    val retained = amount - release
    if (retained < PRIVATE_DEPOSIT_MINIMUM) {
      rows.removeAt(index)
      public += amount
    } else {
      rows[index].put("amountAtoms", retained.toString())
      public += release
    }
  }
  if (public < minimum)
    throw DepositBelowRouteMinimum(
      "Public funding needs at least ${routeUsdc(minimum)} USDC, but only " +
        "${routeUsdc(public)} USDC can be allocated to it. Review a larger amount and its fees."
    )
  return PrivateDepositSelection(rows, public.toString())
}

/** A source must fund every saved slot above the live bridge minimum. */
internal fun minimumRoutableSource(distribution: JSONObject?): BigInteger {
  if (distribution == null) return PAYOUT_QUOTE_FLOOR
  val weight = distributionWeights(distribution).min().toBigInteger()
  val scale = BigInteger.valueOf(10000)
  return (PAYOUT_QUOTE_FLOOR * scale + weight - BigInteger.ONE) / weight
}

/** Reads are authenticated by the native caller. A failed read is never an empty account. */
internal suspend fun selectPrivateDepositSources(
  budget: String,
  candidates: List<JSONObject>,
  minimumDebit: BigInteger = PAYOUT_QUOTE_FLOOR,
  readAvailable: suspend (JSONObject) -> String,
): PrivateDepositSelection {
  check(candidates.map { it.getString("address").lowercase() }.distinct().size == candidates.size)
  require(minimumDebit > BigInteger.ZERO)
  var remaining = depositAtoms(budget, true)
  data class Pick(val row: JSONObject, var amount: BigInteger)
  val selected = mutableListOf<Pick>()
  for (candidate in candidates) {
    if (remaining == BigInteger.ZERO) break
    val available = depositAtoms(readAvailable(candidate))
    if (available < minimumDebit) continue
    check(selected.size < 32) {
      "This deposit needs too many private sources; use a smaller amount"
    }
    var debit = minOf(remaining, available)
    if (debit < minimumDebit) {
      val need = minimumDebit - debit
      val donor = selected.indexOfLast { it.amount - need >= minimumDebit }
      if (donor < 0) continue
      selected[donor].amount -= need
      debit = minimumDebit
      remaining = BigInteger.ZERO
    } else remaining -= debit
    selected += Pick(JSONObject(candidate.toString()), debit)
  }
  return PrivateDepositSelection(
    selected.map { it.row.put("amountAtoms", it.amount.toString()) },
    remaining.toString(),
  )
}

internal fun privateDepositCandidates(context: Context, record: WalletRecord): List<JSONObject> =
  NativeOwnedConfidentialPortfolio(context)
    .ownedTargets(record)
    .also { check(it.size <= 128) { "Private account discovery is still syncing" } }
    .map {
      JSONObject()
        .put("kind", it.kind)
        .put("profileChainId", it.profileChainId)
        .put("cycleIndex", it.cycleIndex)
        .put("address", it.address)
    }

/** Descriptor identity is derived again for every read and again inside the Rust signer. */
internal fun privateDepositAddress(record: WalletRecord, source: JSONObject): String {
  val kind = source.getString("kind")
  val chain = source.getInt("profileChainId")
  val cycle = source.getInt("cycleIndex")
  check(cycle >= 0)
  val address =
    if (kind == "swap") {
      check(chain == 0 && cycle == 0)
      deriveAccountAddressRange(record.entropy, 2u, 1u).single()
    } else {
      check(kind == "earn" && chain in setOf(1, 4663))
      deriveEarnCycleConfidentialAddress(record.entropy, chain.toULong(), cycle.toUInt())
    }
  check(address.equals(source.getString("address"), true))
  return address
}

internal suspend fun privateDepositReadAuth(
  record: WalletRecord,
  source: JSONObject,
  authority: () -> Unit,
): EarnReadAuthentication {
  privateDepositAddress(record, source)
  authority()
  val salt = ConfidentialBalance().salt()
  val random = ByteArray(7).also { SecureRandom().nextBytes(it) }
  val started = System.currentTimeMillis()
  authority()
  return if (source.getString("kind") == "swap")
    authenticateSwapRead(
      record.entropy,
      salt,
      random,
      started.toULong(),
      System.currentTimeMillis().toULong(),
    )
  else
    authenticateEarnCycleRead(
      record.entropy,
      source.getLong("profileChainId").toULong(),
      source.getInt("cycleIndex").toUInt(),
      salt,
      random,
      started.toULong(),
      System.currentTimeMillis().toULong(),
    )
}

internal suspend fun readPrivateDepositBalance(
  context: Context,
  record: WalletRecord,
  source: JSONObject,
  authority: () -> Unit,
): Map<String, Any> = run {
  if (privateDepositAddress(record, source).equals(sharedConfidential(record), true))
    requireNoPendingSharedCredit(context, record)
  ConfidentialBalance()
    .read(privateDepositReadAuth(record, source, authority), privateDepositAddress(record, source))
    .also { NativeOwnedConfidentialPortfolio(context).recordSourceObservation(record, source, it) }
}

internal fun isPrivateDepositSource(row: JSONObject) =
  row.getJSONObject("proposal").optString("kind") == "privateEarnFunding"

internal fun privateDepositRows(context: Context, record: WalletRecord): List<JSONObject> =
  activeDepositDrafts(record, earnDepositJournal(context, record).all()).filter { row ->
    row.optString("phase") != "invested" &&
      row.optJSONObject("review")?.let { review ->
        review.optString("confidentialAccount").equals(sharedConfidential(record), true) ||
          review.getJSONArray("sources").objects().any { it.optString("kind") == "private" }
      } == true
  }

internal fun assertNoPrivateDeposit(
  context: Context,
  record: WalletRecord,
  except: String? = null,
) {
  check(privateDepositRows(context, record).none { it.getString("journeyId") != except }) {
    "Resume or discard the saved deposit before spending private USDC elsewhere"
  }
}
