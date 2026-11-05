package io.gizu.storedwallet

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnDepositApprovalTest {
  @Test
  fun optedInUnsignedFundingRefreshPreservesCapsAndFreezesSavedSignatures() {
    DepositFixtures.record().use { r ->
      val review = DepositFixtures.review(r).put("sourceRefreshWithinLimits", true)
      val a = EarnDepositApproval.fromReview(r, review)
      a.approveAfterPasskey(1000)
      val old = DepositFixtures.funding(r)
      a.assertPrepared(r, "funding", old, DepositFixtures.prepared(), 1001)
      val refreshed = DepositFixtures.funding(r)
      refreshed
        .getJSONObject("proposal")
        .put("revision", 2)
        .put("nonce", "0x1")
        .put("deadline", 20000)
        .put("quoteId", "new-quote")
        .put("recipient", "0x" + "9".repeat(40))
      refreshed.getJSONObject("unsignedUserOperation").put("nonce", "0x1").put("callData", "0xcd")
      a.assertPrepared(r, "funding", refreshed, DepositFixtures.prepared(), 1002)
      for (field in
        listOf(
          "amountAtoms",
          "maximumTokenFeeAtoms",
          "expectedFrom",
          "budgetAtoms",
          "token",
          "confidentialAccount",
        )) {
        val changed = JSONObject(refreshed.toString())
        changed.getJSONObject("proposal").put(field, "changed")
        fails { a.assertPrepared(r, "funding", changed, DepositFixtures.prepared(), 1003) }
      }
      refreshed.put("signedUserOperation", "exact-signed-bytes").put("status", "signed")
      a.assertPrepared(r, "funding", refreshed, DepositFixtures.prepared(), 1004)
      a.recordDurableSignature("funding", "source0", "signed-hash")
      val changed = JSONObject(refreshed.toString())
      changed.getJSONObject("proposal").put("revision", 3).put("deadline", 21000)
      fails { a.assertPrepared(r, "funding", changed, DepositFixtures.prepared(), 1005) }
      fails { a.assertPrepared(r, "funding", old, DepositFixtures.prepared(), 1005) }
    }
  }

  private fun fails(action: () -> Unit) {
    assertThrows(IllegalStateException::class.java, action)
  }

  @Test
  fun expiryBackwardsGenerationCycleAndInvalidationNeverRenewAuthority() {
    DepositFixtures.record().use { r ->
      val a = EarnDepositApproval.fromReview(r, DepositFixtures.review(r))
      val child = DepositFixtures.funding(r)
      fails { a.assertPrepared(r, "funding", child, DepositFixtures.prepared(), 1000) }
      a.approveAfterPasskey(1000)
      a.assertPrepared(r, "funding", child, DepositFixtures.prepared(), 1001)
      DepositFixtures.record("27cfcc2e-0891-4e31-a7d4-03780d7b4f12").use {
        fails { a.assertPrepared(it, "funding", child, DepositFixtures.prepared(), 1002) }
      }
      DepositFixtures.record(cycle = 1).use {
        fails { a.assertPrepared(it, "funding", child, DepositFixtures.prepared(), 1002) }
      }
      a.assertPrepared(r, "funding", child, DepositFixtures.prepared(), 900999)
      fails { a.assertPrepared(r, "funding", child, DepositFixtures.prepared(), 901000) }
      fails { a.assertPrepared(r, "funding", child, DepositFixtures.prepared(), 999) }
      a.invalidate()
      fails { a.approveAfterPasskey(1001) }
      fails { a.assertPrepared(r, "funding", child, DepositFixtures.prepared(), 1001) }
    }
  }

  @Test
  fun sourceMembershipAndExactFundingCapsCannotChange() {
    DepositFixtures.record().use { r ->
      val a = EarnDepositApproval.fromReview(r, DepositFixtures.review(r))
      a.approveAfterPasskey(1000)
      for (field in
        listOf(
          "amountAtoms",
          "maximumTokenFeeAtoms",
          "expectedFrom",
          "token",
          "confidentialAccount",
          "budgetAtoms",
        )) {
        val child = DepositFixtures.funding(r)
        child.getJSONObject("proposal").put(field, "changed")
        fails { a.assertPrepared(r, "funding", child, DepositFixtures.prepared(), 1001) }
      }
      fails {
        a.assertPrepared(
          r,
          "withdrawal",
          DepositFixtures.funding(r),
          DepositFixtures.prepared(),
          1001,
        )
      }
      fails {
        a.assertPrepared(r, "return", DepositFixtures.funding(r), DepositFixtures.prepared(), 1001)
      }
    }
  }

  @Test
  fun payoutsWaitForAllCreditsAndCheckSplitRecipientsMinimaAndFees() {
    DepositFixtures.record().use { r ->
      val a = EarnDepositApproval.fromReview(r, DepositFixtures.review(r))
      a.approveAfterPasskey(1000)
      val p = DepositFixtures.payout(r)
      fails { a.assertPrepared(r, "payouts", p, DepositFixtures.prepared(), 1001) }
      a.recordCredit("source0", "990000")
      a.assertPrepared(r, "payouts", p, DepositFixtures.prepared(), 1002)
      for ((field, value) in
        listOf(
          "amountAtoms" to "99001",
          "splitOffsetAtoms" to "1",
          "minimumDestinationAtoms" to "98999",
          "expectedRecipient" to cycleAddresses(r)[1],
          "profileChainId" to "1",
        )) {
        val bad = DepositFixtures.payout(r)
        bad.getJSONObject("proposal").put(field, value)
        fails { a.assertPrepared(r, "payouts", bad, DepositFixtures.prepared(), 1003) }
      }
      fails {
        a.assertPrepared(r, "payouts", p, DepositFixtures.prepared().put("providerFeeBps", 5), 1003)
      }
      fails { a.recordCredit("source0", "989999") }
    }
  }

  @Test
  fun depositWaitsForReceiptsAndConstrainsVaultBudgetSharesAndReserve() {
    DepositFixtures.record().use { r ->
      val a = EarnDepositApproval.fromReview(r, DepositFixtures.review(r))
      a.approveAfterPasskey(1000)
      val proof = DepositFixtures.prepared().put("minimumSharesAtoms", "870000")
      fails { a.assertPrepared(r, "deposit", DepositFixtures.deposit(r), proof, 1001) }
      a.recordCredit("source0", "990000")
      a.recordPayout("source0", "hold", "99000")
      a.recordPayout("source0", "invest", "891000")
      a.assertPrepared(r, "deposit", DepositFixtures.deposit(r), proof, 1002)
      for ((field, value) in
        listOf(
          "vault" to MONAD_EARN_USDC,
          "token" to HOOD_EARN_VAULT,
          "router" to HOOD_EARN_VAULT,
          "amountAtoms" to "869999",
          "budgetAtoms" to "891001",
          "maximumTokenFeeAtoms" to "10001",
          "withdrawalReserveAtoms" to "10999",
        )) {
        val child = DepositFixtures.deposit(r)
        child.getJSONObject("proposal").put(field, value)
        fails { a.assertPrepared(r, "deposit", child, proof, 1003) }
      }
      fails {
        a.assertPrepared(
          r,
          "deposit",
          DepositFixtures.deposit(r),
          proof.put("minimumSharesAtoms", "859999"),
          1003,
        )
      }
    }
  }

  @Test
  fun vaultLimitsTolerateGasMovingEitherWayBetweenReviewAndSigning() {
    DepositFixtures.record().use { r ->
      // The review is quoted at one gas price. Fee and reserve both scale with that price.
      val preview =
        JSONObject()
          .put("depositAmount", "870000")
          .put("depositFeeBudget", "10000")
          .put("withdrawalReserve", "11000")
          .put("minimumSharesAtoms", "860000")
          .put("shareDecimals", 18)
      val review = DepositFixtures.review(r).put("deposit", vaultApprovalBounds(preview))
      val proof = DepositFixtures.prepared().put("minimumSharesAtoms", "860000")
      // Each case is its own approval: a prepared child's terms are frozen once checked.
      fun sign(fee: Int, reserve: Int) {
        val a = EarnDepositApproval.fromReview(r, review)
        a.approveAfterPasskey(1000)
        a.recordCredit("source0", "990000")
        a.recordPayout("source0", "hold", "99000")
        a.recordPayout("source0", "invest", "891000")
        val child = DepositFixtures.deposit(r)
        child
          .getJSONObject("proposal")
          .put("maximumTokenFeeAtoms", fee.toString())
          .put("withdrawalReserveAtoms", reserve.toString())
          .put("amountAtoms", (891000 - fee - reserve).toString())
        a.assertPrepared(r, "deposit", child, proof, 1002)
      }
      // Signing re-quotes both at a gas price 1% higher, then 1% lower.
      sign(10100, 11110)
      sign(9900, 10890)
      // Beyond the approved band: fee above +25%, or reserve below 75%.
      fails { sign(12501, 11000) }
      fails { sign(10000, 8249) }
    }
  }

  @Test
  fun immutableSignaturesAndLogicalChildMembershipPreventBudgetReuse() {
    DepositFixtures.record().use { r ->
      val a = EarnDepositApproval.fromReview(r, DepositFixtures.review(r))
      a.approveAfterPasskey(1000)
      a.recordCredit("source0", "990000")
      val p = DepositFixtures.payout(r)
      a.assertPrepared(r, "payouts", p, DepositFixtures.prepared(), 1001)
      a.recordDurableSignature("payouts", "payout-hold", "signed-hash")
      a.recordDurableSignature("payouts", "payout-hold", "signed-hash")
      fails { a.recordDurableSignature("payouts", "payout-hold", "replacement") }
      fails { a.recordDurableSignature("payouts", "unregistered", "signature") }
      fails {
        a.assertPrepared(
          r,
          "payouts",
          p.put("operationId", "another-hold"),
          DepositFixtures.prepared(),
          1002,
        )
      }
      fails {
        EarnDepositApproval.fromReview(
          r,
          DepositFixtures.review(r)
            .put(
              "destinations",
              org.json.JSONArray(listOf(cycleAddresses(r)[1], cycleAddresses(r)[0])),
            ),
        )
      }
    }
  }

  @Test
  fun expiredReviewCannotCreateAnApprovedGrant() {
    DepositFixtures.record().use { r ->
      val a = EarnDepositApproval.fromReview(r, DepositFixtures.review(r))
      fails { a.approveAfterPasskey(46000) }
    }
  }

  @Test
  fun explicitRemainingApprovalNeverRenewsQuotesOrRestoresAuthorityAutomatically() {
    DepositFixtures.record().use { r ->
      val saved = DepositFixtures.review(r)
      val normal = EarnDepositApproval.fromReview(r, saved)
      val resumed = EarnDepositApproval.fromRemainingReview(r, saved, 100000)
      assertNotEquals(normal.digest, resumed.digest)
      fails { resumed.assertRead(r, 100000) }
      fails { normal.approveAfterPasskey(100000) }
      resumed.approveAfterPasskey(100001)
      resumed.assertRead(r, 100002)
      assertEquals(46000, resumed.review.getInt("expiresAtMs"))
      resumed.review.put("sourceBudgetAtoms", "999999999")
      assertEquals("1010000", resumed.review.getString("sourceBudgetAtoms"))
      val expiredChild = DepositFixtures.funding(r)
      expiredChild.getJSONObject("proposal").put("deadline", 1)
      fails {
        resumed.assertPrepared(r, "funding", expiredChild, DepositFixtures.prepared(), 100003)
      }
      fails {
        resumed.assertPrepared(
          r,
          "return",
          DepositFixtures.funding(r),
          DepositFixtures.prepared(),
          100003,
        )
      }
    }
  }

  @Test
  fun distributionGrantBindsSavedWeightsAndEveryWalletBudgetIndependently() {
    for (weights in
      listOf(listOf(10000), listOf(4000, 6000), listOf(1000, 1500, 2000, 2500, 3000))) {
      DistributionDepositFixtures.record(weights).use { record ->
        val review = DistributionDepositFixtures.review(record)
        val grant =
          EarnDepositApproval.fromReview(record, review).apply { approveAfterPasskey(1000) }
        grant.recordCredit("source0", "990000")
        for (slot in weights.indices) {
          val payout = DistributionDepositFixtures.payout(record, slot)
          grant.assertPrepared(record, "payouts", payout, DepositFixtures.prepared(), 1002)
          val changed = JSONObject(payout.toString())
          changed
            .getJSONObject("proposal")
            .put(
              "distribution",
              JSONObject().put("version", 1).put("weightsBps", org.json.JSONArray(listOf(10000))),
            )
          if (weights.size > 1)
            assertThrows(Exception::class.java) {
              grant.assertPrepared(record, "payouts", changed, DepositFixtures.prepared(), 1002)
            }
          grant.recordPayout(
            "source0",
            "invest:$slot",
            payout.getJSONObject("proposal").getString("amountAtoms"),
          )
          val deposit = DistributionDepositFixtures.deposit(record, slot)
          val proof =
            DepositFixtures.prepared()
              .put("minimumSharesAtoms", deposit.getJSONObject("proposal").getString("amountAtoms"))
          grant.assertPrepared(record, "deposit", deposit, proof, 1002)
          val reused = JSONObject(deposit.toString()).put("operationId", "duplicate-$slot")
          assertThrows(Exception::class.java) {
            grant.assertPrepared(record, "deposit", reused, proof, 1002)
          }
          for (field in
            listOf("investmentSlot", "expectedFrom", "maximumTokenFeeAtoms", "budgetAtoms")) {
            val bad = JSONObject(deposit.toString())
            bad
              .getJSONObject("proposal")
              .put(field, if (field == "investmentSlot") 5 else "999999999")
            assertThrows(Exception::class.java) {
              grant.assertPrepared(record, "deposit", bad, proof, 1002)
            }
          }
        }
        val changed = JSONObject(review.toString())
        changed
          .getJSONArray("deposits")
          .getJSONObject(0)
          .put("recipient", publicAccountAddress(record, 0))
        assertThrows(Exception::class.java) { EarnDepositApproval.fromReview(record, changed) }
      }
    }
  }
}
