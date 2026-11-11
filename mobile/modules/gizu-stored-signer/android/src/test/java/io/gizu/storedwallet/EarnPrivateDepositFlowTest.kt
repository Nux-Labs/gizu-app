package io.gizu.storedwallet

import java.math.BigInteger
import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import uniffi.gizu_stored_signer_core.deriveAccountAddressRange
import uniffi.gizu_stored_signer_core.deriveEarnCycleConfidentialAddress

class EarnPrivateDepositFlowTest {
  private fun review(
    record: WalletRecord,
    mixed: Boolean = false,
    earnSource: Boolean = false,
  ): JSONObject {
    val review =
      DistributionDepositFixtures.review(
        record,
        if (mixed) listOf("990000", "990000") else listOf("990000"),
      )
    val source = review.getJSONArray("sources").getJSONObject(0)
    val descriptor =
      JSONObject()
        .put("kind", if (earnSource) "earn" else "swap")
        .put("profileChainId", if (earnSource) 1 else 0)
        .put("cycleIndex", if (earnSource) 2 else 0)
        .put(
          "address",
          if (earnSource) deriveEarnCycleConfidentialAddress(record.entropy, 1uL, 2u)
          else deriveAccountAddressRange(record.entropy, 2u, 1u).single(),
        )
        .put("amountAtoms", "990000")
    source
      .put("kind", "private")
      .put("accountIndex", -1)
      .put("address", descriptor.getString("address"))
      .put("budgetAtoms", "990000")
      .put("maximumFeeAtoms", "0")
      .put("retainedAtoms", "0")
    val privateRow =
      JSONObject()
        .put("operationId", "source0")
        .put("walletId", record.id)
        .put("status", "planned")
        .put("revision", 1)
        .put(
          "proposal",
          JSONObject()
            .put("kind", "privateEarnFunding")
            .put("operationId", "source0")
            .put("profileChainId", 4663)
            .put("cycleIndex", record.earnCycleIndex)
            .put("sourceAccountIndex", -1)
            .put("token", MONAD_EARN_USDC)
            .put("confidentialAccount", cycleConfidential(record))
            .put("amountAtoms", "990000")
            .put("budgetAtoms", "990000")
            .put("maximumTokenFeeAtoms", "0")
            .put("source", descriptor),
        )
    val publicRows = review.getJSONArray("fundingRows").objects().drop(1)
    publicRows.forEach { it.getJSONObject("proposal").put("fundingBatchSize", publicRows.size) }
    review
      .put("fundingRows", JSONArray(listOf(privateRow) + publicRows))
      .put("sourceBudgetAtoms", if (mixed) "2000000" else "990000")
    review
      .getJSONObject("reservation")
      .put(
        "legs",
        JSONArray(review.getJSONObject("reservation").getJSONArray("legs").objects().drop(1)),
      )
    if (!mixed) review.getJSONObject("reservation").put("id", "private_batch1")
    return review
  }

  private fun payout(
    record: WalletRecord,
    review: JSONObject,
    sourceId: String,
    leg: String,
  ): JSONObject {
    val source =
      review.getJSONArray("sources").objects().single { it.getString("operationId") == sourceId }
    val bound = depositReviewBound(source, leg, review)
    val offset =
      review
        .getJSONArray("sources")
        .objects()
        .filter { it.getInt("accountIndex") < source.getInt("accountIndex") }
        .fold(BigInteger.ZERO) { n, it -> n + it.getString("amountAtoms").toBigInteger() }
        .toString()
    val row =
      DistributionDepositFixtures.payout(
          record,
          distributionSlot(leg, review.getJSONObject("distribution")),
        )
        .put("operationId", "payout-$sourceId-${leg.replace(':', '_')}")
    val p =
      row
        .getJSONObject("proposal")
        .put("operationId", sourceId)
        .put("leg", leg)
        .put("creditedAtoms", source.getString("amountAtoms"))
        .put("splitOffsetAtoms", offset)
        .put("amountAtoms", bound.getString("inputAtoms"))
        .put("minimumDestinationAtoms", bound.getString("minimumOutputAtoms"))
    if (source.optString("kind") == "private") {
      val descriptor =
        review
          .getJSONArray("fundingRows")
          .objects()
          .single { it.getString("operationId") == sourceId }
          .getJSONObject("proposal")
          .getJSONObject("source")
      p.put("kind", "privateEarnPayout")
        .put("source", JSONObject(descriptor.toString()))
        .put("expectedSigner", descriptor.getString("address"))
      p.remove("sourceAccountIndex")
      p.remove("sourceOwner")
    } else {
      p.put("sourceAccountIndex", source.getInt("accountIndex"))
        .put("sourceOwner", source.getString("address"))
    }
    return row
  }

  @Test
  fun privateOnlyApprovalDerivesBothKindsWithoutAuthorizingPublicFunding() {
    DistributionDepositFixtures.record().use { record ->
      for (earnSource in listOf(false, true)) {
        val review = review(record, earnSource = earnSource)
        val descriptor =
          review
            .getJSONArray("fundingRows")
            .getJSONObject(0)
            .getJSONObject("proposal")
            .getJSONObject("source")
        assertEquals(descriptor.getString("address"), privateDepositAddress(record, descriptor))
        assertNotEquals(cycleConfidential(record), privateDepositAddress(record, descriptor))
        val grant =
          EarnDepositApproval.fromReview(record, review).apply { approveAfterPasskey(1000) }
        grant.recordCredit("source0", "990000")
        grant.assertPrepared(
          record,
          "payouts",
          payout(record, review, "source0", "invest:0"),
          DepositFixtures.prepared(),
          1001,
        )
        assertThrows(IllegalStateException::class.java) {
          grant.assertPrepared(
            record,
            "funding",
            DepositFixtures.funding(record),
            DepositFixtures.prepared(),
            1002,
          )
        }
        assertThrows(IllegalStateException::class.java) { grant.recordCredit("source0", "990001") }
      }
    }
  }

  @Test
  fun sourceDescriptorAndPrivateBudgetMutationsNeverCreateAnApproval() {
    DistributionDepositFixtures.record().use { record ->
      for (mutation in 0..5) {
        val review = review(record)
        val source = review.getJSONArray("sources").getJSONObject(0)
        val p = review.getJSONArray("fundingRows").getJSONObject(0).getJSONObject("proposal")
        when (mutation) {
          0 -> p.getJSONObject("source").put("cycleIndex", 1)
          1 -> p.getJSONObject("source").put("address", cycleConfidential(record))
          2 -> {
            source.put("maximumFeeAtoms", "1")
            p.put("maximumTokenFeeAtoms", "1")
          }
          3 -> source.put("retainedAtoms", "1")
          4 -> {
            source.put("amountAtoms", "989999")
            p.put("amountAtoms", "989999")
          }
          else -> source.put("accountIndex", 0)
        }
        assertThrows(IllegalStateException::class.java) {
          EarnDepositApproval.fromReview(record, review)
        }
      }
    }
  }

  @Test
  fun privatePayoutCannotChangeDescriptorRecipientAmountOrReviewedRouteFee() {
    DistributionDepositFixtures.record().use { record ->
      val review = review(record)
      for (mutation in 0..4) {
        val grant =
          EarnDepositApproval.fromReview(record, review).apply {
            approveAfterPasskey(1000)
            recordCredit("source0", "990000")
          }
        val row = payout(record, review, "source0", "invest:0")
        val p = row.getJSONObject("proposal")
        val proof = DepositFixtures.prepared()
        when (mutation) {
          0 -> p.getJSONObject("source").put("amountAtoms", "990001")
          1 -> p.put("expectedRecipient", cycleAddresses(record)[1])
          2 -> p.put("amountAtoms", "396001")
          3 -> proof.put("providerFeeBps", 5)
          else -> p.put("kind", "confidentialPayout")
        }
        assertThrows(IllegalStateException::class.java) {
          grant.assertPrepared(record, "payouts", row, proof, 1001)
        }
      }
    }
  }

  @Test
  fun failedPrivatePayoutPreparationSurvivesCancellationAndCanResume() = runBlocking {
    DistributionDepositFixtures.record().use { record ->
      val journal = testDepositJournal()
      val id = journal.loadOrCreate(record, 4663, null).getString("journeyId")
      val review = review(record).put("journeyId", id)
      journal.saveReview(id, 1, review)
      val engines = Engines(record, review).apply { prepareUnavailable = true }
      val coordinator = EarnDepositCoordinator(journal, engines)
      val grant = EarnDepositApproval.fromReview(record, review).apply { approveAfterPasskey(1000) }
      coordinator.confirmed(id, 2, grant)
      assertEquals("providerUnavailable", journal.get(id).getString("pauseReason"))
      coordinator.reconcile(id)
      assertEquals("providerUnavailable", journal.get(id).getString("pauseReason"))
      assertEquals(0, journal.get(id).getJSONObject("children").length())
      coordinator.cancel(id, journal.get(id).getInt("revision"))
      journal.cancelUnsignedReview(id) { error("No public reservation to release") }
      assertTrue(journal.get(id).has("review"))
      engines.prepareUnavailable = false
      val resumed = EarnDepositCoordinator(journal, engines)
      val remaining =
        EarnDepositApproval.fromRemainingReview(record, review, 1000).apply {
          approveAfterPasskey(1000)
        }
      resumed.resume(id, journal.get(id).getInt("revision"), remaining)
      assertEquals("invested", journal.get(id).getString("phase"))
    }
  }

  @Test
  fun privateOnlyAndMixedSourcesReachEveryVaultSlotWithoutInventingFundingOrDoubleCounting() =
    runBlocking {
      for (mixed in listOf(false, true)) DistributionDepositFixtures.record().use { record ->
        val journal = testDepositJournal()
        val id = journal.loadOrCreate(record, 4663, null).getString("journeyId")
        val review = review(record, mixed).put("journeyId", id)
        journal.saveReview(id, 1, review)
        val engines = Engines(record, review)
        val coordinator = EarnDepositCoordinator(journal, engines)
        val grant =
          EarnDepositApproval.fromReview(record, review).apply { approveAfterPasskey(1000) }
        coordinator.confirmed(id, 2, grant)
        val final = journal.get(id)
        assertEquals("invested", final.getString("phase"))
        assertEquals(
          if (mixed) listOf("source1") else emptyList<String>(),
          engines.registeredFunding,
        )
        assertEquals(engines.registeredFunding, engines.creditReads)
        assertEquals(
          if (mixed) 4 else 2,
          engines.rows.values.count {
            it.getJSONObject("proposal").getString("kind") in
              setOf("privateEarnPayout", "confidentialPayout")
          },
        )
        assertEquals(
          2,
          engines.rows.values.count {
            it.getJSONObject("proposal").getString("kind") == "privateEarnPayout"
          },
        )
        assertEquals(listOf(0, 1), engines.depositedSlots)
        assertEquals(if (mixed) "1980000" else "990000", final.getString("creditedAtoms"))
        assertEquals(final.getString("creditedAtoms"), final.getString("investReceivedAtoms"))
        assertEquals("0", final.getString("holdReceivedAtoms"))
        assertEquals(
          depositReviewDeposits(review).map { it.getString("estimatedAssetsAtoms") },
          final.getJSONArray("investments").objects().map { it.getString("depositedAtoms") },
        )
        assertEquals(if (mixed) 7 else 4, engines.executed.size)
        val before = depositCanonical(final)
        coordinator.advance(id, null)
        coordinator.reconcile(id)
        assertEquals(before, depositCanonical(journal.get(id)))
        assertEquals(if (mixed) 7 else 4, engines.executed.size)
      }
    }

  @Test
  fun publicProgressRedactsPrivateIdentityAndDescriptorWhileKeepingPublicSource() {
    DistributionDepositFixtures.record().use { record ->
      val file = DepositMemoryFile()
      val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
      fun restored() =
        EarnDepositJournal(file, { key }, DepositFixtures.wallet, DepositFixtures.wallet)
      val journal = restored()
      val id = journal.loadOrCreate(record, 4663, null).getString("journeyId")
      val review = review(record, mixed = true).put("journeyId", id)
      journal.saveReview(id, 1, review)
      val snapshot = JSONObject(restored().publicSnapshot(id))
      val sources = snapshot.getJSONObject("review").getJSONArray("sources").objects()
      val private = sources.single { it.optString("kind") == "private" }
      assertEquals("", private.getString("address"))
      assertEquals("990000", private.getString("budgetAtoms"))
      assertEquals(
        publicAccountAddress(record, 1),
        sources.single { it.getInt("accountIndex") == 1 }.getString("address"),
      )
      val descriptor =
        review
          .getJSONArray("fundingRows")
          .getJSONObject(0)
          .getJSONObject("proposal")
          .getJSONObject("source")
      assertFalse(snapshot.toString().contains(descriptor.getString("address")))
      for (field in
        listOf(
          "fundingRows",
          "reservation",
          "privateEarnFunding",
          "sourceAccountIndex",
          "profileChainId\":0",
        )) assertFalse(snapshot.toString().contains(field))
      assertEquals(
        descriptor.toString(),
        restored()
          .get(id)
          .getJSONObject("review")
          .getJSONArray("fundingRows")
          .getJSONObject(0)
          .getJSONObject("proposal")
          .getJSONObject("source")
          .toString(),
      )
    }
  }

  private inner class Engines(val record: WalletRecord, val review: JSONObject) :
    EarnDepositEngines {
    var prepareUnavailable = false
    val rows = linkedMapOf<String, JSONObject>()
    val registeredFunding = mutableListOf<String>()
    val creditReads = mutableListOf<String>()
    val executed = mutableListOf<String>()
    val depositedSlots = mutableListOf<Int>()

    override suspend fun registerFunding(row: JSONObject): JSONObject {
      check(!isPrivateDepositSource(row))
      registeredFunding += row.getString("operationId")
      rows[row.getString("operationId")] = row
      return row
    }

    override suspend fun preparePayout(sourceId: String, leg: String): JSONObject {
      if (prepareUnavailable) throw RpcFailure(RpcFailureCode.HTTP)
      return payout(record, review, sourceId, leg).also { rows[it.getString("operationId")] = it }
    }

    override suspend fun prepareDeposit(
      id: String,
      attributedAtoms: String,
      slot: Int?,
    ): JSONObject =
      DistributionDepositFixtures.deposit(record, checkNotNull(slot)).put("operationId", id).also {
        it
          .getJSONObject("proposal")
          .put("operationId", id)
          .put("budgetAtoms", attributedAtoms)
          .put("amountAtoms", (attributedAtoms.toBigInteger() - 21000.toBigInteger()).toString())
        rows[id] = it
      }

    override fun child(stage: String, id: String) =
      checkNotNull(rows[id]) { "Missing child journal" }

    override suspend fun execute(stage: String, id: String, grant: EarnDepositApproval) {
      val row = child(stage, id)
      val p = row.getJSONObject("proposal")
      grant.assertPrepared(
        record,
        stage,
        row,
        DepositFixtures.prepared().put("minimumSharesAtoms", p.getString("amountAtoms")),
        1002,
      )
      grant.recordDurableSignature(stage, id, "durable-$id")
      check(executed.add("$stage:$id") && executed.count { it == "$stage:$id" } == 1)
      row.put("status", if (stage == "payouts") "paid" else "finalized")
      if (stage == "payouts") row.put("receivedAtoms", p.getString("amountAtoms"))
      if (stage == "deposit") {
        depositedSlots += p.getInt("investmentSlot")
        row.put("transactionHash", "0x" + "9".repeat(64))
      }
    }

    override suspend fun reconcile(stage: String, id: String, grant: EarnDepositApproval?) =
      child(stage, id)

    override fun credit(row: JSONObject): String? {
      creditReads += row.getString("operationId")
      return row.getJSONObject("proposal").getString("amountAtoms")
    }

    override fun payoutReceipt(row: JSONObject): String? =
      if (row.getString("status") == "paid") row.getString("receivedAtoms") else null

    override fun investment(row: JSONObject): DepositInvestment? =
      if (row.getString("status") == "finalized")
        DepositInvestment(
          row.getJSONObject("proposal").getString("amountAtoms"),
          row.getJSONObject("proposal").getString("amountAtoms"),
          row.getString("transactionHash"),
        )
      else null
  }
}
