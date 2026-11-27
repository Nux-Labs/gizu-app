package io.gizu.storedwallet

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnFundingOnlyParentTest {
  private fun record(cycle: Int = 0, distribution: Boolean = false): WalletRecord {
    val cycles = JSONArray()
    if (distribution)
      cycles.put(
        JSONObject()
          .put("cycleIndex", cycle)
          .put("chainId", 1)
          .put(
            "distribution",
            JSONObject().put("version", 1).put("weightsBps", JSONArray(listOf(2500, 7500))),
          )
      )
    return WalletRecord(
      DepositFixtures.wallet,
      StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
      ByteArray(32),
      true,
      DepositFixtures.wallet,
      INITIAL_ROLE_REGISTRY,
      1,
      false,
      cycle,
      cycles.toString(),
    )
  }

  private fun sources(record: WalletRecord): JSONArray =
    JSONArray(
      listOf(143 to "9900000", 8453 to "4900000").map { (chain, amount) ->
        val id = "parent_source_$chain"
        DepositFixtures.funding(record, 1).put("operationId", id).also { row ->
          row
            .getJSONObject("proposal")
            .put("operationId", id)
            .put("profileChainId", 1)
            .put("chainId", chain)
            .put("token", fundingNetwork(chain).token)
            .put("amountAtoms", amount)
            .put("confidentialAccount", sharedConfidential(record))
            .put("budgetAtoms", if (chain == 143) "10000000" else "5000000")
            .put("maximumTokenFeeAtoms", "90000")
            .put("fundingBatchSize", 2)
        }
      }
    )

  private fun create(journal: EarnDepositJournal, record: WalletRecord): JSONObject =
    journal.createFundingOnlyParent(
      record,
      "17000000",
      "2000000",
      sources(record),
      JSONObject().put("parent_source_143", "9800000").put("parent_source_8453", "4800000"),
      JSONObject()
        .put("id", "batch1")
        .put("feature", "earn")
        .put("cycleIndex", record.earnCycleIndex)
        .put("registrationComplete", true),
    )

  private fun credit(original: JSONObject, amount: String): JSONObject =
    JSONObject(original.toString())
      .put("status", "finalized")
      .put("signedUserOperation", "immutable-${original.getString("operationId")}")
      .put("transactionHash", "0x" + "a".repeat(64))
      .put(
        "stateBinding",
        JSONObject()
          .put(
            "privateBaseline",
            JSONObject().put("available", "50000000").put("baselineEnvelope", "baseline"),
          ),
      )
      .put(
        "settlement",
        JSONObject()
          .put("status", "credited")
          .put("creditedAtoms", amount)
          .put("settlementEnvelope", "seal-${original.getString("operationId")}"),
      )

  @Test
  fun aggregateSourcesWaitForOrderedSealedCreditsAndFreezeExactC2Handoff() {
    record(distribution = true).use { record ->
      val journal = testDepositJournal()
      val root = create(journal, record)
      val id = root.getString("journeyId")
      assertEquals(1, root.getInt("profileChainId"))
      assertFalse(root.has("privateHandoff"))
      assertThrows(IllegalStateException::class.java) { journal.fundingOnlyHandoff(id, record) }
      val rows = root.getJSONObject("review").getJSONArray("publicFundingRows")
      assertThrows(IllegalStateException::class.java) {
        journal.recordFundingOnlyCredit(id, credit(rows.getJSONObject(1), "4900000"))
      }
      journal.recordFundingOnlyCredit(id, credit(rows.getJSONObject(0), "9900000"))
      assertFalse(journal.get(id).has("privateHandoff"))
      journal.recordFundingOnlyCredit(id, credit(rows.getJSONObject(1), "4900000"))
      val handoff = journal.fundingOnlyHandoff(id, record)
      assertEquals("ready", handoff.getString("phase"))
      assertEquals("17000000", handoff.getString("budgetAtoms"))
      assertEquals(
        "16800000",
        handoff.getJSONObject("privateHandoff").getJSONObject("source").getString("amountAtoms"),
      )
      assertEquals(
        sharedConfidential(record),
        handoff.getJSONObject("privateHandoff").getJSONObject("source").getString("address"),
      )
      assertEquals(
        savedCycleDistribution(record).toString(),
        handoff.getJSONObject("distribution").toString(),
      )
      val duplicate = credit(rows.getJSONObject(0), "9900000")
      journal.recordFundingOnlyCredit(id, duplicate)
      assertEquals("16800000", journal.get(id).getString("creditedAtoms"))
      assertThrows(IllegalStateException::class.java) {
        journal.recordFundingOnlyCredit(id, credit(rows.getJSONObject(0), "9900001"))
      }
    }
  }

  @Test
  fun legacyTenNinetyParentRetainsOnePermanentPayoutChildPerLeg() {
    record().use { record ->
      val journal = testDepositJournal()
      val root =
        journal.createFundingOnlyParent(
          record,
          "15000000",
          "15000000",
          JSONArray(),
          JSONObject(),
          JSONObject().put("id", "private_parent"),
        )
      val id = root.getString("journeyId")
      assertFalse(root.has("distribution"))
      assertEquals(
        cycleAddresses(record),
        root.getJSONArray("destinations").objects().map { it.getString("address") },
      )
      journal.attachFundingOnlyPayout(id, "hold", "payout_hold", record)
      journal.attachFundingOnlyPayout(id, "hold", "payout_hold", record)
      assertThrows(IllegalStateException::class.java) {
        journal.attachFundingOnlyPayout(id, "hold", "different", record)
      }
      assertThrows(IllegalStateException::class.java) {
        journal.attachFundingOnlyPayout(id, "invest:0", "wrong_slot", record)
      }
      journal.recordFundingOnlyPayoutPaid(id, "hold", "payout_hold", record)
      journal.attachFundingOnlyPayout(id, "invest", "payout_invest", record)
      journal.recordFundingOnlyPayoutPaid(id, "invest", "payout_invest", record)
      assertEquals("paid", journal.get(id).getString("phase"))
      assertEquals(2, journal.get(id).getJSONObject("payoutChildren").length())
    }
  }

  @Test
  fun confirmedC2PoolCannotBeReboundToAnotherCycleOrCancelledThenSpent() {
    record().use { record ->
      val journal = testDepositJournal()
      val root =
        journal.createFundingOnlyParent(
          record,
          "15000000",
          "15000000",
          JSONArray(),
          JSONObject(),
          JSONObject().put("id", "private_parent"),
        )
      val id = root.getString("journeyId")
      record(cycle = 1).use { other ->
        assertThrows(IllegalStateException::class.java) { journal.fundingOnlyHandoff(id, other) }
      }
      journal.cancelFundingOnlyParent(id, record)
      assertEquals("cancelled", journal.get(id).getString("phase"))
      assertThrows(IllegalStateException::class.java) { journal.fundingOnlyHandoff(id, record) }
      assertThrows(IllegalStateException::class.java) {
        journal.attachFundingOnlyPayout(id, "hold", "late", record)
      }
    }
  }

  @Test
  fun fundedParentFinancialIdentityCannotChangeAfterHandoff() {
    record().use { record ->
      val journal = testDepositJournal()
      val parent =
        journal.createFundingOnlyParent(
          record,
          "15000000",
          "15000000",
          JSONArray(),
          JSONObject(),
          JSONObject().put("id", "private_parent"),
        )
      val id = parent.getString("journeyId")
      assertThrows(IllegalStateException::class.java) {
        journal.update(id, journal.get(id).getInt("revision")) { it.put("budgetAtoms", "15000001") }
      }
      assertThrows(IllegalStateException::class.java) {
        journal.update(id, journal.get(id).getInt("revision")) {
          it.getJSONObject("privateHandoff").getJSONObject("source").put("amountAtoms", "15000001")
        }
      }
      assertEquals("15000000", journal.fundingOnlyHandoff(id, record).getString("creditedAtoms"))
    }
  }

  @Test
  fun reconciliationStopsAtUnconfirmedSourceAndReplaysReadyHandoffWithoutNewBalanceAttribution():
    Unit = runBlocking {
    record().use { record ->
      val journal = testDepositJournal()
      val parent = create(journal, record)
      val id = parent.getString("journeyId")
      val calls = mutableListOf<String>()
      reconcileFundingOnlySources(
        journal,
        id,
        { original ->
          calls += original.getString("operationId")
          original
        },
        { false },
      )
      assertEquals(listOf("parent_source_143"), calls)
      calls.clear()
      val rows = parent.getJSONObject("review").getJSONArray("publicFundingRows")
      journal.recordFundingOnlyCredit(id, credit(rows.getJSONObject(0), "9900000"))
      reconcileFundingOnlySources(
        journal,
        id,
        { original ->
          calls += original.getString("operationId")
          credit(original, "4900000")
        },
        { true },
      )
      assertEquals(listOf("parent_source_8453"), calls)
      val ready =
        reconcileFundingOnlySources(
          journal,
          id,
          { error("Completed credit must not be reattributed from a fresh balance") },
          { error("Ready handoff has already verified every source") },
        )
      assertEquals(
        "16800000",
        ready.getJSONObject("privateHandoff").getJSONObject("source").getString("amountAtoms"),
      )
    }
  }

  @Test
  fun parentHistoryIsScopedToTheSelectedCycleWithoutDiscardingOlderRecoveryRows() {
    val journal = testDepositJournal()
    record().use { first ->
      val old =
        journal.createFundingOnlyParent(
          first,
          "15000000",
          "15000000",
          JSONArray(),
          JSONObject(),
          JSONObject().put("id", "private_old"),
        )
      val id = old.getString("journeyId")
      journal.attachFundingOnlyPayout(id, "hold", "old_hold", first)
      journal.recordFundingOnlyPayoutPaid(id, "hold", "old_hold", first)
      journal.attachFundingOnlyPayout(id, "invest", "old_invest", first)
      journal.recordFundingOnlyPayoutPaid(id, "invest", "old_invest", first)
      record(cycle = 1).use { next ->
        val current =
          journal.createFundingOnlyParent(
            next,
            "15000000",
            "15000000",
            JSONArray(),
            JSONObject(),
            JSONObject().put("id", "private_current"),
          )
        assertEquals(
          listOf(current.getString("journeyId")),
          fundingOnlyParentsForCycle(next, journal.all()).map { it.getString("journeyId") },
        )
        assertEquals(
          listOf(id),
          fundingOnlyParentsForCycle(first, journal.all()).map { it.getString("journeyId") },
        )
        assertEquals(2, journal.all().size)
      }
    }
  }

  @Test
  fun cancellingAnUnsignedAttachedPayoutReleasesThePoolAndKeepsItsChildIdentity() {
    record().use { record ->
      val journal = testDepositJournal()
      val parent =
        journal.createFundingOnlyParent(
          record,
          "15000000",
          "15000000",
          JSONArray(),
          JSONObject(),
          JSONObject().put("id", "private_parent"),
        )
      val id = parent.getString("journeyId")
      journal.attachFundingOnlyPayout(id, "hold", "unsigned_hold", record)
      val child = JSONObject().put("operationId", "unsigned_hold").put("status", "cancelled")
      val cancelled = journal.cancelFundingOnlyParent(id, record, listOf(child))
      assertEquals("cancelled", cancelled.getString("phase"))
      assertEquals("unsigned_hold", cancelled.getJSONObject("payoutChildren").getString("hold"))
    }
  }

  @Test
  fun validatedPrivatePayoutExemptsOnlyItsOwnFundingParent() {
    record().use { record ->
      val journal = testDepositJournal()
      val parent =
        journal.createFundingOnlyParent(
          record,
          "15000000",
          "15000000",
          JSONArray(),
          JSONObject(),
          JSONObject().put("id", "private_parent"),
        )
      val own = parent.getString("journeyId")
      assertThrows(IllegalStateException::class.java) { assertNoPrivateDeposit(listOf(parent)) }
      assertNoPrivateDeposit(listOf(parent), except = own)
      val other = JSONObject(parent.toString()).put("journeyId", "another_pending_parent")
      assertThrows(IllegalStateException::class.java) {
        assertNoPrivateDeposit(listOf(parent, other), except = own)
      }
      assertThrows(IllegalStateException::class.java) {
        assertNoPrivateDeposit(listOf(parent), except = "wrong_parent")
      }
    }
  }
}
