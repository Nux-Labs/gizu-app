package io.gizu.storedwallet

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnWithdrawalPortionTest {
  private fun source() =
    JSONObject()
      .put("walletId", "wallet")
      .put("operationId", "redeem_1")
      .put("status", "finalized")
      .put("signedUserOperation", "saved")
      .put("transactionHash", "0x" + "a".repeat(64))
      .put("redeemedUsdgAtoms", "500")
      .put("residualShares", "700")
      .put("stateBinding", JSONObject().put("shares", "1000"))
      .put(
        "proposal",
        JSONObject()
          .put("kind", "hoodRedeemAll")
          .put("chainId", 4663)
          .put("nonce", "0x3")
          .put("cycleIndex", 1)
          .put("investmentSlot", 2)
          .put("expectedFrom", "0x" + "b".repeat(40))
          .put("amountAtoms", "300")
          .put("requestedWithdrawalAtoms", "500")
          .put("withdrawalRequestId", "request_1")
          .put("maximumTokenFeeAtoms", "100"),
      )

  private fun returned() =
    JSONObject()
      .put("walletId", "wallet")
      .put("operationId", "return_1")
      .put("status", "planned")
      .put(
        "proposal",
        JSONObject()
          .put("kind", "hoodTokenReturn")
          .put("confidentialAccount", "0x" + "c".repeat(40))
          .put("chainId", 4663)
          .put("nonce", "0x3")
          .put("cycleIndex", 1)
          .put("investmentSlot", 2)
          .put("expectedFrom", "0x" + "b".repeat(40))
          .put("amountAtoms", "400")
          .put("maximumTokenFeeAtoms", "100")
          .put("withdrawalOperationId", "redeem_1")
          .put("returnBudgetAtoms", "500")
          .put("withdrawalReserveAtoms", "260"),
      )

  @Test
  fun aPortionReturnUsesItsCanonicalProceedsWithoutEmptyingTheVault() {
    val source = source()
    val returned = returned()
    requireWithdrawalReturnSource(listOf(source, returned), returned, "wallet", "700")
    requireWithdrawalReturnSource(listOf(source, returned), returned, "wallet", "900")
    returned.getJSONObject("proposal").put("cycleIndex", 1.0).put("investmentSlot", 2.0)
    requireWithdrawalReturnSource(listOf(source, returned), returned, "wallet", "700")
    assertTrue(withdrawnRequestedPortion(source))
    val approval = OpenWithdrawalApproval("wallet", "generation", "redeem_1", 1000)
    assertWithdrawalReturnAuthorized(
      approval,
      "wallet",
      "generation",
      source,
      returned.getJSONObject("proposal"),
      1001,
    )
    for (field in
      listOf(
        "expectedFrom",
        "cycleIndex",
        "investmentSlot",
        "withdrawalOperationId",
        "returnBudgetAtoms",
        "amountAtoms",
      )) {
      val altered = JSONObject(returned.toString())
      val proposal = altered.getJSONObject("proposal")
      when (field) {
        "expectedFrom" -> proposal.put(field, "0x" + "c".repeat(40))
        "cycleIndex",
        "investmentSlot" -> proposal.put(field, 9)
        "withdrawalOperationId" -> proposal.put(field, "other")
        else -> proposal.put(field, "501")
      }
      assertThrows(Exception::class.java) {
        requireWithdrawalReturnSource(listOf(source, altered), altered, "wallet", "700")
      }
    }
    assertThrows(Exception::class.java) {
      requireWithdrawalReturnSource(listOf(source, returned), returned, "other", "700")
    }
    assertThrows(Exception::class.java) {
      requireWithdrawalReturnSource(
        listOf(JSONObject(source.toString()).put("status", "pending"), returned),
        returned,
        "wallet",
        "700",
      )
    }
    val unfundedReserve = JSONObject(returned.toString())
    unfundedReserve.getJSONObject("proposal").put("withdrawalReserveAtoms", "259")
    assertThrows(Exception::class.java) {
      requireWithdrawalReturnSource(
        listOf(source, unfundedReserve),
        unfundedReserve,
        "wallet",
        "700",
      )
    }
    assertTrue(
      withdrawnRequestedPortion(JSONObject(source.toString()).put("residualShares", "701"))
    )
  }

  @Test
  fun aSignedPrivateReturnConsumesThisSourceAndCannotBeDuplicated() {
    val source = source()
    val first = returned().put("signedUserOperation", "saved").put("status", "finalized")
    val second = returned().put("operationId", "return_2")
    assertThrows(Exception::class.java) {
      requireWithdrawalReturnSource(listOf(source, first, second), second, "wallet", "700")
    }
    first.put("status", "signed").getJSONObject("proposal").put("deadline", 1)
    assertThrows(Exception::class.java) {
      requireWithdrawalReturnSource(listOf(source, first, second), second, "wallet", "700")
    }
    first.put(
      "status",
      "expired",
    ) // Only the native absence/nonce-checked retirement can write this.
    requireWithdrawalReturnSource(listOf(source, first, second), second, "wallet", "700")
    second.getJSONObject("proposal").put("nonce", "0x4")
    assertThrows(Exception::class.java) {
      requireWithdrawalReturnSource(listOf(source, first, second), second, "wallet", "700")
    }
    first.put("status", "reverted")
    requireWithdrawalReturnSource(listOf(source, first, second), second, "wallet", "700")
  }

  @Test
  fun anExpiredReturnReplacementSharesItsNonceAndCannotReleaseUnrelatedPrivateWork() {
    val old = returned().put("status", "expired").put("signedUserOperation", "saved")
    val replacement = returned().put("operationId", "replacement")
    requireSequentialSourceCredit(listOf(old), replacement, "wallet", "generation")
    assertThrows(Exception::class.java) { requireSequentialSourceCredit(listOf(old), replacement) }
    for (field in
      listOf("nonce", "withdrawalOperationId", "expectedFrom", "cycleIndex", "investmentSlot")) {
      val changed = JSONObject(replacement.toString())
      changed.getJSONObject("proposal").put(field, if (field == "nonce") "0x4" else "different")
      assertThrows(Exception::class.java) {
        requireSequentialSourceCredit(listOf(old), changed, "wallet", "generation")
      }
    }
    val probe =
      JSONObject()
        .put("operationId", "balance-probe")
        .put(
          "proposal",
          JSONObject()
            .put(
              "confidentialAccount",
              old.getJSONObject("proposal").getString("confidentialAccount"),
            ),
        )
    assertThrows(Exception::class.java) {
      requireSequentialSourceCredit(listOf(old), probe, "wallet", "generation")
    }
  }

  @Test
  fun aCompletedRedemptionCannotRepeatAndItsUnfinishedReturnBlocksLaterPortions() {
    val redeemed = source()
    val next = source().put("operationId", "next").put("status", "planned")
    assertThrows(Exception::class.java) {
      requireRequestedWithdrawalAdmission(listOf(redeemed), next, "wallet", "generation")
    }
    next.getJSONObject("proposal").put("withdrawalRequestId", "request_2").put("nonce", "0x4")
    assertThrows(Exception::class.java) {
      requireRequestedWithdrawalAdmission(listOf(redeemed), next, "wallet", "generation")
    }
    val returned =
      returned()
        .put("status", "finalized")
        .put("settlement", JSONObject().put("status", "credited"))
    requireRequestedWithdrawalAdmission(listOf(redeemed, returned), next, "wallet", "generation")
    redeemed.put("status", "expired")
    assertThrows(Exception::class.java) {
      requireRequestedWithdrawalAdmission(listOf(redeemed), next, "wallet", "generation")
    }
    next.getJSONObject("proposal").put("nonce", "0x3")
    requireRequestedWithdrawalAdmission(listOf(redeemed), next, "wallet", "generation")
  }

  @Test
  fun nativeObservedRefundReleasesOnlyTheFailedIncomingCreditWithoutCompletingWithdrawal() {
    val old =
      returned()
        .put("status", "finalized")
        .put("signedUserOperation", "saved")
        .put("transactionHash", "0x" + "a".repeat(64))
        .put("stateBinding", JSONObject())
    old.put(
      "returnRouteProgress",
      JSONObject()
        .put("version", 1)
        .put("providerRouteStatus", "REFUNDED")
        .put("observedAtMs", 1000)
        .put("spendingAuthorized", false)
        .put("publicUsdgAtoms", "500")
        .put(
          "nativeBinding",
          ownerReceivedReturnRecord(old, "wallet", "generation", 1000, "SUCCESS", false)
            .getJSONObject("nativeBinding"),
        ),
    )
    val next = returned().put("operationId", "return_2")
    requireSequentialSourceCredit(listOf(old), next, "wallet", "generation")
    requireWithdrawalReturnSource(listOf(source(), old, next), next, "wallet", "700", "generation")
    assertThrows(Exception::class.java) {
      requireWithdrawalReturnSource(
        listOf(source(), old, next),
        next,
        "wallet",
        "700",
        "other-generation",
      )
    }
    val nextRedeem = source().put("operationId", "redeem_2").put("status", "planned")
    nextRedeem.getJSONObject("proposal").put("withdrawalRequestId", "request_2").put("nonce", "0x4")
    assertThrows(Exception::class.java) {
      requireRequestedWithdrawalAdmission(listOf(source(), old), nextRedeem, "wallet", "generation")
    }
    val successfulRetry =
      JSONObject(next.toString())
        .put("status", "finalized")
        .put("settlement", JSONObject().put("status", "credited"))
    requireRequestedWithdrawalAdmission(
      listOf(source(), old, successfulRetry),
      nextRedeem,
      "wallet",
      "generation",
    )
    assertFalse(completedReturnLifecycle(old, "wallet", "generation"))
    assertThrows(Exception::class.java) {
      requireSequentialSourceCredit(listOf(old), next, "wallet", "other-generation")
    }
    for (status in listOf("PROCESSING", "SUCCESS", "FAILED")) {
      val processing = JSONObject(old.toString())
      processing.getJSONObject("returnRouteProgress").put("providerRouteStatus", status)
      assertThrows(Exception::class.java) {
        requireSequentialSourceCredit(listOf(processing), next, "wallet", "generation")
      }
    }
  }

  @Test
  fun firstDelegationPromptDescribesAndBoundsTheRequestedAmount() {
    val p = source().getJSONObject("proposal")
    val text = requestedWithdrawalReview(p, "500", "1000")
    assertTrue(text.contains("0.000500 USDG"))
    assertTrue(text.contains("Exact selected shares: 300"))
    assertTrue(text.contains("0.000100 USDG"))
    assertTrue(text.contains("0.10%"))
    assertThrows(Exception::class.java) { requestedWithdrawalReview(p, "502", "1000") }
    assertThrows(Exception::class.java) { requestedWithdrawalReview(p, "500", "299") }
    p.put("withdrawAllShares", true)
    assertThrows(Exception::class.java) { requestedWithdrawalReview(p, "500", "1000") }
  }
}
