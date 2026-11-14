package io.gizu.storedwallet

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnInvestmentPositionsTest {
  @Test
  fun requestedCompletionRemainsKnownAcrossALaterPartialWithdrawal() {
    record().use { r ->
      val redeemed =
        operation(r, 1, 0, "hoodRedeemAll", "finalized", "redeem_1")
          .put("residualShares", "700")
          .put("redeemedUsdgAtoms", "500")
          .put("stateBinding", JSONObject().put("shares", "1000"))
      redeemed
        .getJSONObject("proposal")
        .put("amountAtoms", "300")
        .put("requestedWithdrawalAtoms", "500")
        .put("withdrawalRequestId", "request_1")
      val returned =
        operation(r, 1, 0, "hoodTokenReturn", "finalized", "return_1")
          .put("settlement", JSONObject().put("status", "credited"))
      returned.getJSONObject("proposal").put("withdrawalOperationId", "redeem_1")
      val retired =
        operation(r, 1, 0, "hoodTokenReturn", "nonceCancelled", "expired_return")
          .put("signedUserOperation", "saved")
      retired.getJSONObject("proposal").put("withdrawalOperationId", "redeem_1")
      val first =
        earnInvestmentPositions(
            r,
            r.id,
            emptyList(),
            listOf(redeemed, retired, returned),
            emptyList(),
            emptyList(),
          )
          .single()
      assertEquals("invested", first["activity"])
      assertEquals(true, first["withdrawalComplete"])
      assertEquals(listOf("request_1"), first["completedWithdrawalRequestIds"])
      val later =
        operation(r, 1, 0, "hoodRedeemAll", "unknown", "redeem_2")
          .put("signedUserOperation", "saved")
      later
        .getJSONObject("proposal")
        .put("requestedWithdrawalAtoms", "200")
        .put("withdrawalRequestId", "request_2")
      val pending =
        earnInvestmentPositions(
            r,
            r.id,
            emptyList(),
            listOf(redeemed, returned, later),
            emptyList(),
            emptyList(),
          )
          .single()
      assertEquals("pending", pending["activity"])
      assertEquals("confirming", pending["withdrawalAttention"])
      assertEquals(listOf("request_1"), pending["completedWithdrawalRequestIds"])
    }
  }

  @Test
  fun ownerConfirmedHistoricalReturnClosesOnlyThatFlowWithoutCreatingCreditEvidence() {
    record().use { r ->
      val redeem = operation(r, 1, 0, "hoodRedeemAll")
      val returned =
        operation(r, 1, 0, "hoodTokenReturn")
          .put("signedUserOperation", "saved")
          .put("transactionHash", "0x" + "a".repeat(64))
          .put("stateBinding", JSONObject())
      returned.put(
        "returnFlowCompletion",
        JSONObject()
          .put("version", 1)
          .put("source", "owner-confirmed")
          .put("providerRouteStatus", "SUCCESS")
          .put("vaultEmpty", false)
          .put("recordedAtMs", 1)
          .put("spendingAuthorized", false)
          .put(
            "nativeBinding",
            JSONObject()
              .put("walletId", r.id)
              .put("generation", r.journalId)
              .put("operationId", returned.getString("operationId"))
              .put("proposal", JSONObject(returned.getJSONObject("proposal").toString()))
              .put("stateBinding", JSONObject())
              .put("transactionHash", returned.getString("transactionHash")),
          ),
      )
      fun row(rows: List<JSONObject>) =
        earnInvestmentPositions(r, r.id, emptyList(), rows, emptyList(), emptyList()).single()
      assertEquals("returned", row(listOf(redeem, returned))["activity"])
      assertNull(row(listOf(redeem, returned))["withdrawalAttention"])
      assertFalse(returned.has("minimumReturnReceipt"))
      assertFalse(returned.has("settlement"))
      redeem.put("residualShares", "1")
      assertEquals("invested", row(listOf(redeem, returned))["activity"])
      assertEquals(true, row(listOf(redeem, returned))["withdrawalComplete"])
      redeem.put("residualShares", "0")
      val later =
        operation(r, 1, 0, "hoodRedeemAll", "unknown", "later")
          .put("signedUserOperation", "saved-later")
      assertEquals("confirming", row(listOf(redeem, returned, later))["withdrawalAttention"])
    }
  }

  private fun record(recovery: Boolean = false) =
    WalletRecord(
      DepositFixtures.wallet,
      StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
      ByteArray(32),
      true,
      DepositFixtures.wallet,
      INITIAL_ROLE_REGISTRY,
      4663,
      recovery,
      1,
      JSONArray()
        .put(JSONObject().put("cycleIndex", 0).put("chainId", 1))
        .put(
          JSONObject()
            .put("cycleIndex", 1)
            .put("chainId", 4663)
            .put(
              "distribution",
              JSONObject().put("version", 1).put("weightsBps", JSONArray(listOf(4000, 6000))),
            )
            .put("investmentSlot", 1)
        )
        .toString(),
    )

  private fun operation(
    record: WalletRecord,
    cycle: Int,
    slot: Int?,
    kind: String,
    status: String = "finalized",
    id: String = kind,
  ): JSONObject {
    val row = JSONArray(record.earnCycles).getJSONObject(cycle)
    return recordForCycle(record, row).use { selected ->
      val p =
        JSONObject()
          .put("cycleIndex", cycle)
          .put("chainId", selected.earnChain)
          .put("profileChainId", selected.earnChain)
          .put("kind", kind)
          .put("expectedFrom", cycleInvestmentAddress(selected, slot))
          .put("expectedSigner", cycleConfidential(selected))
      if (slot != null) p.put("investmentSlot", slot)
      JSONObject()
        .put("walletId", record.id)
        .put("operationId", id)
        .put("proposal", p)
        .put("status", status)
        .put("residualShares", "0")
    }
  }

  @Test
  fun inventoryIncludesEverySavedCycleAndSlotWithoutChangingSelection() {
    record().use { r ->
      val before = r.earnCycles
      val eth =
        operation(r, 0, null, "vaultDeposit")
          .put("steps", JSONArray().put(JSONObject().put("status", "finalized")))
      val hood = (0..1).map { operation(r, 1, it, "hoodDeposit") }
      val rows = earnInvestmentPositions(r, r.id, listOf(eth), hood, emptyList(), emptyList())
      assertEquals(3, rows.size)
      assertEquals(
        listOf("ethereum-usdc", "robinhood-usdg", "robinhood-usdg"),
        rows.map { it["profileId"] },
      )
      assertEquals(listOf(null, 0, 1), rows.map { it["investmentSlot"] })
      assertEquals(setOf("invested"), rows.map { it["activity"] }.toSet())
      assertEquals(before, r.earnCycles)
      assertEquals(1, r.earnCycleIndex)
      assertFalse(rows.toString().contains("expectedFrom"))
      assertFalse(rows.toString().contains("0x"))
    }
  }

  @Test
  fun anUnfinishedVaultWithdrawalStaysVisibleWithoutChangingACompletedReturn() {
    record().use { r ->
      val deposit = operation(r, 1, 0, "hoodDeposit")
      val redeem = operation(r, 1, 0, "hoodRedeemAll")
      fun attention(rows: List<JSONObject>) =
        earnInvestmentPositions(r, r.id, emptyList(), rows, emptyList(), emptyList())
          .single()["withdrawalAttention"]
      assertEquals("unfinished", attention(listOf(deposit, redeem)))
      val returned =
        operation(r, 1, 0, "hoodTokenReturn", id = "return0")
          .put("settlement", JSONObject().put("status", "credited"))
      assertNull(attention(listOf(deposit, redeem, returned)))
      val pending =
        operation(r, 1, 0, "hoodRedeemAll", "unknown").put("signedUserOperation", "saved")
      assertEquals("confirming", attention(listOf(deposit, pending)))
      assertNull(attention(listOf(deposit, pending, returned)))
      assertEquals(
        "redeemed",
        earnInvestmentPositions(
            r,
            r.id,
            emptyList(),
            listOf(deposit, pending, returned),
            emptyList(),
            emptyList(),
          )
          .single()["activity"],
      )
      assertEquals("confirming", attention(listOf(deposit, returned, pending)))
      val returning =
        operation(r, 1, 0, "hoodTokenReturn", "unknown", "return0")
          .put("signedUserOperation", "saved")
      assertEquals("returning", attention(listOf(deposit, redeem, returning)))
    }
  }

  @Test
  fun finalizedReturnWithoutPrivateProofNeedsVerificationRatherThanAnotherWithdrawal() {
    record().use { r ->
      val redeem = operation(r, 1, 0, "hoodRedeemAll")
      val returned = operation(r, 1, 0, "hoodTokenReturn")
      fun attention() =
        earnInvestmentPositions(
            r,
            r.id,
            emptyList(),
            listOf(redeem, returned),
            emptyList(),
            emptyList(),
          )
          .single()["withdrawalAttention"]
      assertEquals("checking", attention())
      assertEquals(
        "hoodTokenReturn",
        earnInvestmentPositions(
            r,
            r.id,
            emptyList(),
            listOf(redeem, returned),
            emptyList(),
            emptyList(),
          )
          .single()["lastReturnOperationId"],
      )
      returned.put("settlement", JSONObject().put("status", "credited"))
      assertNull(attention())
    }
  }

  @Test
  fun aCompletedOlderReturnCannotCloseALaterRedeemOrReinvestment() {
    record().use { r ->
      val oldRedeem = operation(r, 1, 0, "hoodRedeemAll", id = "redeem1")
      val returned =
        operation(r, 1, 0, "hoodTokenReturn")
          .put("settlement", JSONObject().put("status", "credited"))
      val newRedeem = operation(r, 1, 0, "hoodRedeemAll", id = "redeem2")
      fun attention(last: JSONObject) =
        earnInvestmentPositions(
            r,
            r.id,
            emptyList(),
            listOf(oldRedeem, returned, last),
            emptyList(),
            emptyList(),
          )
          .single()["withdrawalAttention"]
      assertEquals("unfinished", attention(newRedeem))
      assertNull(attention(operation(r, 1, 0, "hoodDeposit", id = "deposit2")))
    }
  }

  @Test
  fun completedPrivateReturnsAreTerminalAndLaterWorkRemainsVisible() {
    record().use { r ->
      val deposit = operation(r, 1, 0, "hoodDeposit")
      val redeem = operation(r, 1, 0, "hoodRedeemAll")
      val returned =
        operation(r, 1, 0, "hoodTokenReturn", id = "return0")
          .put("settlement", JSONObject().put("status", "credited"))
      val paid = operation(r, 1, 0, "confidentialWithdrawal", "paid")
      paid.getJSONObject("proposal").put("returnOperationId", "return0")
      fun inventory(sponsored: List<JSONObject>, withdrawals: List<JSONObject> = emptyList()) =
        earnInvestmentPositions(r, r.id, emptyList(), sponsored, emptyList(), withdrawals)
          .single()["activity"]
      assertEquals("redeemed", inventory(listOf(deposit, redeem)))
      assertEquals("returned", inventory(listOf(deposit, redeem, returned), listOf(paid)))
      val unknown =
        operation(r, 1, 0, "hoodRedeemAll", "unknown")
          .put("signedUserOperation", "private signed payload")
      assertEquals("pending", inventory(listOf(deposit, redeem, returned, unknown), listOf(paid)))
      assertEquals("invested", inventory(listOf(deposit, redeem, returned, deposit), listOf(paid)))
      assertEquals("invested", inventory(listOf(deposit, redeem.put("residualShares", "1"))))
    }
  }

  @Test
  fun foreignOwnersSlotsAndProfilesNeverBecomeWithdrawalTargets() {
    record().use { r ->
      val foreignOwner = operation(r, 1, 0, "hoodDeposit")
      foreignOwner.getJSONObject("proposal").put("expectedFrom", "0x" + "f".repeat(40))
      val foreignProfile = operation(r, 1, 0, "hoodDeposit")
      foreignProfile.getJSONObject("proposal").put("chainId", 1)
      val missingSlot = operation(r, 1, 0, "hoodDeposit")
      missingSlot.getJSONObject("proposal").remove("investmentSlot")
      val cancelled = operation(r, 1, 1, "hoodDeposit", "planned").put("cancelled", true)
      assertTrue(
        earnInvestmentPositions(
            r,
            r.id,
            emptyList(),
            listOf(foreignOwner, foreignProfile, missingSlot, cancelled),
            emptyList(),
            emptyList(),
          )
          .isEmpty()
      )
      assertThrows(IllegalStateException::class.java) {
        earnInvestmentPositions(
          r,
          "foreign-wallet",
          emptyList(),
          emptyList(),
          emptyList(),
          emptyList(),
        )
      }
    }
  }

  @Test
  fun cancelledUnsignedWithdrawalDoesNotCreatePendingWork() {
    record().use { r ->
      val redeem = operation(r, 1, 0, "hoodRedeemAll")
      val returned =
        operation(r, 1, 0, "hoodTokenReturn", id = "return0")
          .put("settlement", JSONObject().put("status", "credited"))
      val paid = operation(r, 1, 0, "confidentialWithdrawal", "paid")
      paid.getJSONObject("proposal").put("returnOperationId", "return0")
      val cancelled = operation(r, 1, 0, "confidentialWithdrawal", "cancelled")
      val rows =
        earnInvestmentPositions(
          r,
          r.id,
          emptyList(),
          listOf(redeem, returned),
          emptyList(),
          listOf(paid, cancelled),
        )
      assertEquals("returned", rows.single()["activity"])
    }
  }

  @Test
  fun expiredSignedReturnAndUnknownEthereumRawRemainPending() {
    record().use { r ->
      val eth =
        operation(r, 0, null, "vaultRedeemAll")
          .put(
            "steps",
            JSONArray()
              .put(JSONObject().put("status", "unknown").put("raw", "signed private transaction")),
          )
      val returned =
        operation(r, 1, 0, "hoodTokenReturn", "expired").put("raw", "signed private transaction")
      val rows =
        earnInvestmentPositions(r, r.id, listOf(eth), listOf(returned), emptyList(), emptyList())
      assertEquals(2, rows.size)
      assertEquals(setOf("pending"), rows.map { it["activity"] }.toSet())
    }
  }

  @Test
  fun paidReturnChildrenNeverAttestCompleteResidualSweep() {
    record().use { r ->
      val redeem = operation(r, 1, 0, "hoodRedeemAll")
      val returns = (0..1).map { operation(r, 1, 0, "hoodTokenReturn", id = "return$it") }
      fun paid(index: Int) =
        operation(r, 1, 0, "confidentialWithdrawal", "paid").also {
          it.getJSONObject("proposal").put("returnOperationId", "return$index")
        }
      fun activity(payouts: List<JSONObject>) =
        earnInvestmentPositions(
            r,
            r.id,
            emptyList(),
            listOf(redeem) + returns,
            emptyList(),
            payouts,
          )
          .single()["activity"]
      assertEquals("redeemed", activity(listOf(paid(1))))
      assertEquals("redeemed", activity(listOf(paid(0), paid(1))))
    }
  }

  @Test
  fun paidUsdcReturnStillRequiresEthereumResidualCheck() {
    record().use { r ->
      val redeem =
        operation(r, 0, null, "vaultRedeemAll")
          .put(
            "steps",
            JSONArray().put(JSONObject().put("status", "finalized").put("residualShares", "0")),
          )
      val returned = operation(r, 0, null, "returnUsdc", id = "usdc-return")
      val paid = operation(r, 0, null, "confidentialWithdrawal", "paid")
      paid.getJSONObject("proposal").put("returnOperationId", "usdc-return")
      // A paid USDC child says nothing about ETH still awaiting its separate sweep.
      val rows =
        earnInvestmentPositions(
          r,
          r.id,
          listOf(redeem),
          emptyList(),
          listOf(returned),
          listOf(paid),
        )
      assertEquals("redeemed", rows.single()["activity"])
    }
  }

  @Test
  fun recoveryFlagsSurviveReadOnlyInventory() {
    record(true).use { r ->
      val rows =
        earnInvestmentPositions(
          r,
          r.id,
          emptyList(),
          listOf(operation(r, 1, 1, "hoodDeposit")),
          emptyList(),
          emptyList(),
        )
      assertEquals(true, rows.single()["recoveryRequired"])
    }
  }
}
