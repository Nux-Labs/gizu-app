package io.gizu.storedwallet

import android.content.Context
import java.math.BigInteger
import org.json.JSONObject

/** Imports native saved signatures before new plans or resumed source authority. */
internal fun fundingReservations(context: Context, record: WalletRecord): FundingReservations {
  val ledger = FundingReservations(context, record)
  if (record.earnChain > 0) {
    for (row in earnSponsoredJournal(context, record).all()) {
      val p = row.getJSONObject("proposal")
      if (
        p.getString("kind") == "sourceFunding" &&
          row.sponsoredSpendSaved() &&
          row.getString("status") in setOf("finalized", "reverted") &&
          row.has("transactionHash")
      )
        ledger.complete(row.getString("operationId"))
      if (
        p.getString("kind") == "sourceFunding" &&
          row.sponsoredSpendSaved() &&
          row.getString("status") !in terminalSteps
      ) {
        val index = p.optInt("sourceAccountIndex", 0)
        val owner = publicAccountAddress(record, index)
        check(p.getString("expectedFrom").equals(owner, true))
        ledger.adoptSavedSource(
          row.getString("operationId"),
          owner,
          index,
          p.getString("budgetAtoms"),
          p.optInt("cycleIndex", 0),
        )
      }
    }
  }
  io.gizu.storedwallet.swap.SwapStore(context, record).load()?.let { root ->
    val history = root.optJSONArray("history")
    val roots =
      listOf(root) +
        (if (history == null) emptyList()
        else (0 until history.length()).map(history::getJSONObject))
    for (saved in roots) {
      val children = saved.optJSONObject("fundingBatch")?.getJSONArray("children")
      val states =
        if (children == null) listOf(saved.getString("state"))
        else (0 until children.length()).map { children.getJSONObject(it).getString("state") }
      for (raw in states) {
        val state = JSONObject(raw)
        val p = state.getJSONObject("plan")
        val data = state.getJSONObject("data")
        if (p.getString("kind") == "confidentialSwap" && !data.isNull("signedOperation")) {
          val operation =
            uniffi.gizu_stored_signer_core.SwapOperation.restore(
              raw,
              "https://api.gizu.io",
            )
          val complete =
            operation.use { JSONObject(it.publicStatus()).getString("phase") == "COMPLETE" }
          if (complete) ledger.complete(state.getString("id"))
          if (!complete) {
            val index = p.optInt("sourceIndex", 1)
            val owner = publicAccountAddress(record, index)
            check(state.getString("source").equals(owner, true))
            val amount = data.optString("budget", "1")
            val parsed =
              if (amount.startsWith("0x")) BigInteger(amount.removePrefix("0x"), 16)
              else amount.toBigInteger()
            ledger.adoptSavedSource(
              state.getString("id"),
              owner,
              index,
              parsed.max(BigInteger.ONE).toString(),
              0,
              "swap",
            )
          }
        }
      }
    }
  }
  return ledger
}
