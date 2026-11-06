package io.gizu.storedwallet

internal fun nativeWalletFailureMessage(error: Exception): String =
  when (error) {
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
