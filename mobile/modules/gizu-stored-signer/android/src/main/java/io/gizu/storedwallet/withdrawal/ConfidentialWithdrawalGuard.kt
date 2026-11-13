package io.gizu.storedwallet

import android.content.Context
import io.gizu.storedwallet.swap.SwapStore
import org.json.JSONObject

/** Reads authenticated local journals only; unknown/corrupt records fail closed. */
internal fun assertCashoutCanStart(
  context: Context,
  record: WalletRecord,
  ownDepositId: String? = null,
) {
  check(record.verified && !record.earnRecoveryRequired && !record.discoveryRecoveryRequired) {
    "Complete wallet recovery before withdrawing"
  }
  val key = { checkNotNull(AndroidWalletKeys().existing()) }
  requireNoPendingSharedCredit(context, record)
  fun file(name: String) =
    AndroidWalletFile(context, "gizu-earn-$name-${record.journalId}.enc", 4 * 1024 * 1024)
  assertNoPendingPrivateWork(
    EarnPayoutJournal(file("payout"), key, record.id, record.journalId).all() +
      EarnWithdrawalJournal(file("withdrawal"), key, record.id, record.journalId).all() +
      EarnSponsoredJournal(file("sponsored"), key, record.id, record.journalId).all(),
    EarnDepositJournal(file("deposit"), key, record.id, record.journalId).all().filter {
      it.getString("journeyId") != ownDepositId
    },
  )
  SwapStore(context, record).load()?.let { root ->
    val saved = listOf(root) + (root.optJSONArray("history")?.objects() ?: emptyList())
    for (entry in saved) {
      val states =
        entry.optJSONObject("fundingBatch")?.getJSONArray("children")?.objects()?.map {
          it.getString("state")
        } ?: listOf(entry.getString("state"))
      for (raw in states) {
        assertSavedSwapPrivateWorkFinished(JSONObject(raw))
      }
    }
  }
}

/** Cancellation stops future signatures but does not retract a previously signed private payout. */
internal fun assertSavedSwapPrivateWorkFinished(state: JSONObject) {
  if (state.getJSONObject("step").getString("step") == "done") return
  check(state.optBoolean("cancelled")) { "Reconcile the saved swap before withdrawing from Gizu" }
  val data = state.getJSONObject("data")
  check(data.isNull("signedOperation") || !data.isNull("creditBasis")) {
    "A cancelled swap has signed funding whose private credit must be reconciled"
  }
  val payouts = state.getJSONObject("data").getJSONArray("payouts").objects()
  check(payouts.none { !it.isNull("signed") || !it.isNull("intentHash") }) {
    "A cancelled swap retains a signed private payout; recover that payout before withdrawing from Gizu"
  }
}
