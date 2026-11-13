package io.gizu.storedwallet

import android.content.Context
import io.gizu.storedwallet.swap.SwapStore
import javax.crypto.SecretKey
import org.json.JSONObject

/** Shared Account 2 incoming credits must be sequenced across both destination networks. */
internal fun earnPrivateCreditRows(context: Context, record: WalletRecord): List<JSONObject> =
  earnPrivateCreditRows(
    record,
    { name ->
      AndroidWalletFile(context, "gizu-earn-$name-${record.journalId}.enc", 4 * 1024 * 1024)
    },
    { checkNotNull(AndroidWalletKeys().existing()) },
  )

internal fun earnPrivateCreditRows(
  record: WalletRecord,
  file: (String) -> WalletFile,
  key: () -> SecretKey,
): List<JSONObject> {
  return EarnSponsoredJournal(file("sponsored"), key, record.id, record.journalId).all() +
    EarnLiquidityJournal(file("liquidity"), key, record.id, record.journalId).all()
}

internal fun requireNoPendingSharedCredit(context: Context, record: WalletRecord) {
  val probe =
    JSONObject()
      .put("operationId", "shared-balance-check-${java.util.UUID.randomUUID()}")
      .put("proposal", JSONObject().put("confidentialAccount", sharedConfidential(record)))
  requireSequentialSourceCredit(
    earnPrivateCreditRows(context, record),
    probe,
    record.id,
    record.journalId,
  )
}

internal fun requireSettledSharedPayouts(rows: List<JSONObject>, shared: String) {
  check(
    rows.none { row ->
      row.optJSONObject("proposal")?.optString("expectedSigner")?.equals(shared, true) == true &&
        (row.has("signedData") || row.optBoolean("signingPending")) &&
        privateWorkPending(row, rows)
    }
  ) {
    "Reconcile the pending private payout before using Account 2 again"
  }
}

internal fun requireNoPendingSharedPayout(context: Context, record: WalletRecord) {
  val key = { checkNotNull(AndroidWalletKeys().existing()) }
  fun file(name: String) =
    AndroidWalletFile(context, "gizu-earn-$name-${record.journalId}.enc", 4 * 1024 * 1024)
  requireSettledSharedPayouts(
    EarnPayoutJournal(file("payout"), key, record.id, record.journalId).all() +
      EarnWithdrawalJournal(file("withdrawal"), key, record.id, record.journalId).all(),
    sharedConfidential(record),
  )
}

/** An unfinished Swap may still debit or credit Account 2 while an Earn baseline is observed. */
internal fun earnPrivateCreditRowsForSigning(
  context: Context,
  record: WalletRecord,
  address: String,
): List<JSONObject> {
  if (!address.equals(sharedConfidential(record), true))
    return earnPrivateCreditRows(context, record)
  requireNoPendingSharedPayout(context, record)
  SwapStore(context, record).load()?.let { root ->
    val entries = listOf(root) + (root.optJSONArray("history")?.objects() ?: emptyList())
    for (entry in entries) {
      val states =
        entry.optJSONObject("fundingBatch")?.getJSONArray("children")?.objects()?.map {
          it.getString("state")
        } ?: listOf(entry.getString("state"))
      states.forEach { assertSavedSwapPrivateWorkFinished(JSONObject(it)) }
    }
  }
  return earnPrivateCreditRows(context, record)
}
