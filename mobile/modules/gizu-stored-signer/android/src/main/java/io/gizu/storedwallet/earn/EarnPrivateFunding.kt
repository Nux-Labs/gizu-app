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
  check(public >= minimum) { "Deposit amount is too small after public funding fees" }
  return PrivateDepositSelection(rows, public.toString())
}

/** Reads are authenticated by the native caller. A failed read is never an empty account. */
internal suspend fun selectPrivateDepositSources(
  budget: String,
  candidates: List<JSONObject>,
  readAvailable: suspend (JSONObject) -> String,
): PrivateDepositSelection {
  check(candidates.map { it.getString("address").lowercase() }.distinct().size == candidates.size)
  var remaining = depositAtoms(budget, true)
  val selected = mutableListOf<JSONObject>()
  for (candidate in candidates) {
    if (remaining == BigInteger.ZERO) break
    val available = depositAtoms(readAvailable(candidate))
    if (available < PRIVATE_DEPOSIT_MINIMUM) continue
    check(selected.size < 32) {
      "This deposit needs too many private sources; use a smaller amount"
    }
    val debit = minOf(remaining, available)
    if (debit < PRIVATE_DEPOSIT_MINIMUM) continue
    selected += JSONObject(candidate.toString()).put("amountAtoms", debit.toString())
    remaining -= debit
  }
  return PrivateDepositSelection(selected, remaining.toString())
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
): Map<String, Any> =
  ConfidentialBalance()
    .read(privateDepositReadAuth(record, source, authority), privateDepositAddress(record, source))
    .also { NativeOwnedConfidentialPortfolio(context).recordSourceObservation(record, source, it) }

internal fun isPrivateDepositSource(row: JSONObject) =
  row.getJSONObject("proposal").optString("kind") == "privateEarnFunding"

internal fun privateDepositRows(context: Context, record: WalletRecord): List<JSONObject> =
  earnDepositJournal(context, record).all().filter { row ->
    row.optString("phase") != "invested" &&
      row.optJSONObject("review")?.getJSONArray("sources")?.objects()?.any {
        it.optString("kind") == "private"
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
