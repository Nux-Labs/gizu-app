package io.gizu.storedwallet

import org.junit.Assert.*
import org.junit.Test

class EarnGatewayFailureTest {
  @Test
  fun feePreviewFailurePreservesSavedProgressWithoutClaimingNoFundsMoved() {
    val failure =
      safeEarnGatewayFailure(
        "{\"code\":\"EARN_DEPOSIT_PREVIEW_UNAVAILABLE\",\"message\":\"secret provider text\"}"
      )
    assertNotNull(failure)
    assertEquals("EARN_DEPOSIT_PREVIEW_UNAVAILABLE", failure!!.code)
    assertFalse(failure.message!!.contains("secret"))
    assertTrue(failure.message!!.contains("Saved progress"))
  }

  @Test
  fun groupedProofConflictAndUnavailableRemainDistinctNativeErrors() {
    for (code in
      listOf("EARN_COORDINATION_CONFLICT", "EARN_COORDINATION_UNAVAILABLE")) assertEquals(
      code,
      safeEarnGatewayFailure("{\"code\":\"$code\"}")?.code,
    )
  }

  @Test
  fun knownGatewayFailureIsSpecificAndDoesNotExposeProviderText() {
    val failure =
      safeEarnGatewayFailure(
        "{\"code\":\"EARN_AURORA_FEE_UNQUALIFIED\",\"message\":\"secret-key-and-provider-url\"}"
      )
    assertNotNull(failure)
    assertEquals("EARN_AURORA_FEE_UNQUALIFIED", failure!!.code)
    assertFalse(failure.message!!.contains("secret"))
  }

  @Test
  fun ambiguousMinimumObservationKeepsTheSavedReturnRetryableWithoutProviderText() {
    val failure =
      safeEarnGatewayFailure(
        "{\"code\":\"EARN_MINIMUM_RETURN_CONFLICT\",\"message\":\"private-provider-error\"}"
      )
    assertNotNull(failure)
    assertTrue(failure!!.message!!.contains("saved return"))
    assertTrue(failure.message!!.contains("do not withdraw"))
    assertFalse(failure.message!!.contains("private-provider-error"))
    assertNotNull(safeEarnGatewayFailure("{\"code\":\"EARN_MINIMUM_RETURN_UNAVAILABLE\"}"))
  }

  @Test
  fun unavailableReturnHistoryIsNotLostAsAnHttpErrorOrClaimedUnfinished() {
    val failure =
      safeEarnGatewayFailure(
        """{"code":"EARN_MINIMUM_RETURN_HISTORY_UNAVAILABLE","message":"secret-provider-sentinel"}"""
      )
    assertNotNull(failure)
    assertEquals("EARN_MINIMUM_RETURN_HISTORY_UNAVAILABLE", failure!!.code)
    assertTrue(failure.message!!.contains("could not be verified"))
    assertFalse(failure.message!!.contains("secret-provider-sentinel"))
    assertFalse(failure.message!!.contains("not finished"))
  }

  @Test
  fun unknownMalformedAndOversizedErrorsAreNotForwarded() {
    for (body in listOf("{\"code\":\"ATTACKER\"}", "not-json", "x".repeat(4097))) assertNull(
      safeEarnGatewayFailure(body)
    )
  }
}
