package io.gizu.storedwallet

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnFundingCapacityTest {
  private fun record(chain: Int = 1) =
    WalletRecord(
      DepositFixtures.wallet,
      StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
      ByteArray(32),
      true,
      DepositFixtures.wallet,
      INITIAL_ROLE_REGISTRY,
      chain,
      false,
      0,
      JSONArray()
        .put(
          JSONObject()
            .put("cycleIndex", 0)
            .put("chainId", chain)
            .put(
              "distribution",
              JSONObject()
                .put("version", 1)
                .put("weightsBps", JSONArray(listOf(1000, 1500, 2000, 2500, 3000))),
            )
        )
        .toString(),
    )

  private fun sources(count: Int, chain: Int = 1) =
    (0 until count).map { index ->
      JSONObject()
        .put("operationId", "source$index")
        .put("status", "planned")
        .put(
          "proposal",
          JSONObject()
            .put("kind", "sourceFunding")
            .put("operationId", "source$index")
            .put("cycleIndex", 0)
            .put("profileChainId", chain)
            .put("chainId", 143),
        )
    }

  private fun history(count: Int) =
    (0 until count).map {
      JSONObject()
        .put("operationId", "old$it")
        .put(
          "proposal",
          JSONObject()
            .put("kind", "unrelated")
            .put("operationId", "old$it")
            .put("cycleIndex", 99)
            .put("leg", "hold"),
        )
    }

  private fun payout(record: WalletRecord, source: Int, slot: Int) =
    JSONObject()
      .put("operationId", "payout_${source}_$slot")
      .put(
        "proposal",
        JSONObject()
          .put("kind", "confidentialPayout")
          .put("operationId", "source$source")
          .put("leg", "invest:$slot")
          .put("cycleIndex", 0)
          .put("profileChainId", record.earnChain)
          .put("distribution", savedCycleDistribution(record)),
      )

  private fun investment(record: WalletRecord, slot: Int, kind: String) =
    JSONObject()
      .put("operationId", "$kind-$slot")
      .put("status", "planned")
      .put(
        "proposal",
        JSONObject()
          .put("kind", kind)
          .put("cycleIndex", 0)
          .put("chainId", record.earnChain)
          .put("investmentSlot", slot)
          .put("expectedFrom", cycleInvestmentAddress(record, slot)),
      )

  @Test
  fun fiftyTwoSourcesCannotFundFiveWalletsAndFiftyOneRespectPermanentHistory() {
    record().use { r ->
      val tooMany = sources(52)
      assertThrows(IllegalStateException::class.java) {
        requireDistributionFundingCapacity(
          r,
          tooMany[0],
          tooMany,
          emptyList(),
          emptyList(),
          emptyList(),
        )
      }
      val fit = sources(51)
      requireDistributionFundingCapacity(r, fit[0], fit, history(1), emptyList(), emptyList())
      assertThrows(IllegalStateException::class.java) {
        requireDistributionFundingCapacity(r, fit[0], fit, history(2), emptyList(), emptyList())
      }
      val existing =
        (0 until 51).flatMap { source -> (0 until 5).map { slot -> payout(r, source, slot) } }
      requireDistributionFundingCapacity(
        r,
        fit[0],
        fit,
        existing + history(1),
        emptyList(),
        emptyList(),
      )
      assertThrows(IllegalStateException::class.java) {
        requireDistributionFundingCapacity(
          r,
          fit[0],
          fit,
          existing + history(2),
          emptyList(),
          emptyList(),
        )
      }
    }
  }

  @Test
  fun onlyExactSavedCyclePayoutsReduceFutureSpace() {
    record().use { r ->
      val sources = sources(1)
      val exact = payout(r, 0, 0)
      requireDistributionFundingCapacity(
        r,
        sources[0],
        sources,
        history(251) + exact,
        emptyList(),
        emptyList(),
      )
      exact.getJSONObject("proposal").put("cycleIndex", 1)
      assertThrows(IllegalStateException::class.java) {
        requireDistributionFundingCapacity(
          r,
          sources[0],
          sources,
          history(251) + exact,
          emptyList(),
          emptyList(),
        )
      }
      exact
        .getJSONObject("proposal")
        .put("cycleIndex", 0)
        .put(
          "distribution",
          JSONObject().put("version", 1).put("weightsBps", JSONArray(listOf(10000))),
        )
      assertThrows(IllegalStateException::class.java) {
        requireDistributionFundingCapacity(
          r,
          sources[0],
          sources,
          history(251) + exact,
          emptyList(),
          emptyList(),
        )
      }
    }
  }

  @Test
  fun ethereumVaultAndLiquiditySpaceIncludesEverySlotAndExcludesUnrelatedRows() {
    record().use { r ->
      val sources = sources(1)
      requireDistributionFundingCapacity(
        r,
        sources[0],
        sources,
        emptyList(),
        history(251),
        history(246),
      )
      assertThrows(IllegalStateException::class.java) {
        requireDistributionFundingCapacity(
          r,
          sources[0],
          sources,
          emptyList(),
          history(252),
          history(246),
        )
      }
      assertThrows(IllegalStateException::class.java) {
        requireDistributionFundingCapacity(
          r,
          sources[0],
          sources,
          emptyList(),
          history(251),
          history(247),
        )
      }
      requireDistributionFundingCapacity(
        r,
        sources[0],
        sources,
        emptyList(),
        history(251) + investment(r, 0, "vaultDeposit"),
        history(246) + investment(r, 0, "fusionEthOrder"),
      )
      val reverted = investment(r, 0, "fusionEthOrder").put("status", "reverted")
      assertThrows(IllegalStateException::class.java) {
        requireDistributionFundingCapacity(
          r,
          sources[0],
          sources,
          emptyList(),
          history(251),
          history(246) + reverted,
        )
      }
    }
  }

  @Test
  fun signedSourceRetryDoesNotRequireNewCapacityButDelegationOnlyDoes() {
    record().use { r ->
      val sources = sources(52)
      sources[0].put("authorization", JSONObject())
      assertThrows(IllegalStateException::class.java) {
        requireDistributionFundingCapacity(
          r,
          sources[0],
          sources,
          history(256),
          history(256),
          history(256),
        )
      }
      sources[0].put("signedUserOperation", "durably-saved-original-bytes")
      requireDistributionFundingCapacity(
        r,
        sources[0],
        sources,
        history(256),
        history(256),
        history(256),
      )
    }
  }

  @Test
  fun robinhoodStagedFundingAlsoReservesEverySponsoredInvestment() {
    record(4663).use { r ->
      val sources = sources(1, 4663)
      requireDistributionFundingCapacity(
        r,
        sources[0],
        sources + history(250),
        emptyList(),
        emptyList(),
        emptyList(),
      )
      assertThrows(IllegalStateException::class.java) {
        requireDistributionFundingCapacity(
          r,
          sources[0],
          sources + history(251),
          emptyList(),
          emptyList(),
          emptyList(),
        )
      }
    }
  }

  @Test
  fun guidedFiftyTwoSourcesRejectBeforeFundingAtTheSamePayoutLimit() {
    DistributionDepositFixtures.record(listOf(1000, 1500, 2000, 2500, 3000)).use { r ->
      val review = DistributionDepositFixtures.review(r)
      review.put(
        "sources",
        JSONArray(sources(52).map { JSONObject().put("operationId", it.getString("operationId")) }),
      )
      assertThrows(IllegalStateException::class.java) {
        requireDepositCapacity(review, emptyList(), emptyList())
      }
      review.put(
        "sources",
        JSONArray(sources(51).map { JSONObject().put("operationId", it.getString("operationId")) }),
      )
      requireDepositCapacity(review, emptyList(), history(1))
      assertThrows(IllegalStateException::class.java) {
        requireDepositCapacity(review, emptyList(), history(2))
      }
    }
  }
}
