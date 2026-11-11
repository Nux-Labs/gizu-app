package io.gizu.storedwallet

import java.math.BigInteger

/** A shortfall is distinct from failed reads, expired terms and unavailable fee estimates. */
internal fun requireAvailableFunds(available: BigInteger, required: BigInteger) {
  if (available < required) throw RpcFailure(RpcFailureCode.INSUFFICIENT_FUNDS)
}

/** Restore refuses to replace a readable wallet; JS offers unlocking instead. */
internal class WalletExists :
  IllegalStateException("A readable wallet already exists on this device.")

internal fun nativeWalletFailureMessage(error: Exception): String =
  when (error) {
    is RpcFailure ->
      if (error.code == RpcFailureCode.INSUFFICIENT_FUNDS)
        "Your available balance no longer covers this amount and its fees."
      else
        error.message
          ?: "Could not verify the current network state. Your saved progress is preserved."
    is NativeCeremonyTimeout ->
      if (error.reviewExpired)
        "This review expired after five minutes. Open a fresh review to continue."
      else "This step timed out. Check saved progress before retrying."
    is kotlinx.coroutines.CancellationException ->
      "Wallet operation cancelled. Check saved progress before retrying."
    is uniffi.gizu_stored_signer_core.SignerException.Expired ->
      "These signing terms have expired. Open a fresh review before approving."
    is EarnRpcRejection ->
      when (error.method) {
        "eth_getUserOperationByHash",
        "eth_getUserOperationReceipt" ->
          "Could not check the transaction status. Your saved transaction is kept. Please try again shortly."
        "pm_getPaymasterData" ->
          "Could not confirm current network fees. Please refresh the review."
        "eth_sendUserOperation" ->
          "The network did not confirm submission. Check saved progress before retrying."
        else -> "Could not read the current network state. Please try again shortly."
      }
    else ->
      error.message?.takeIf { it.isNotBlank() }
        ?: "Wallet operation could not be verified. Refresh saved progress and try again."
  }
