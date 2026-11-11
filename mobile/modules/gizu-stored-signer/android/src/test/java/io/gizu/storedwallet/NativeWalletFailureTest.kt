package io.gizu.storedwallet

import org.junit.Assert.*
import org.junit.Test

class NativeWalletFailureTest {
  @Test
  fun insufficientFundsExplainsTheBalanceInsteadOfAskingForAnotherRefresh() {
    val message = nativeWalletFailureMessage(RpcFailure(RpcFailureCode.INSUFFICIENT_FUNDS))
    assertTrue(message, message.contains("balance", ignoreCase = true))
    assertTrue(message, message.contains("cover"))
    assertFalse(message, message.contains("refresh", ignoreCase = true))
  }

  @Test
  fun reviewExpiryAndWorkTimeoutGiveDifferentRecoveryInstructions() {
    assertTrue(nativeWalletFailureMessage(NativeCeremonyTimeout(true)).contains("fresh review"))
    assertTrue(nativeWalletFailureMessage(NativeCeremonyTimeout(false)).contains("saved progress"))
    assertTrue(
      nativeWalletFailureMessage(uniffi.gizu_stored_signer_core.SignerException.Expired())
        .contains("signing terms")
    )
  }

  @Test
  fun rpcFailuresExplainTheAffectedStepWithoutProviderPayloads() {
    for ((method, subject) in
      listOf(
        "eth_getUserOperationByHash" to "transaction status",
        "eth_getUserOperationReceipt" to "transaction status",
        "pm_getPaymasterData" to "network fees",
        "eth_sendUserOperation" to "submission",
        "eth_call" to "network state",
      )) {
      val message =
        nativeWalletFailureMessage(EarnRpcRejection(method, -32000, "SECRET_PROVIDER_DATA"))
      assertTrue(message, message.contains(subject))
      assertFalse(message.contains("SECRET"))
      assertFalse(message.contains("RPC"))
      assertFalse(message.contains(method))
    }
  }

  @Test
  fun existingErrorsKeepTheirExplanationAndBlankErrorsGetANonemptyFallback() {
    assertEquals(
      "Review expired",
      nativeWalletFailureMessage(IllegalStateException("Review expired")),
    )
    assertTrue(nativeWalletFailureMessage(IllegalStateException("  ")).isNotBlank())
  }
}
