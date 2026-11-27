package io.gizu.storedwallet

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnDepositCombinedRemainingTest {
  private fun record(): WalletRecord =
    distributionDepositRecord().use { old ->
      val cycles = JSONArray(old.earnCycles)
      cycles.getJSONObject(0).put("privateAccount", "shared")
      WalletRecord(
        old.id,
        old.credential,
        old.entropy.copyOf(),
        true,
        old.journalId,
        old.roleRegistry,
        4663,
        false,
        0,
        cycles.toString(),
      )
    }

  private fun gateway(
    clock: Long,
    requests: MutableList<Pair<String, JSONObject>> = mutableListOf(),
  ) =
    EarnDepositGateway(
      { path, text ->
        val b = JSONObject(text)
        requests += path to b
        val row =
          JSONObject()
            .put("kind", "preview")
            .put("readOnly", true)
            .put("executionAvailable", false)
            .put("operationId", b.getString("operationId"))
            .put("revision", b.getInt("revision"))
            .put("quotedAtMs", clock)
            .put("expiresAtMs", clock + 45000)
        if (path == "/native/payout/preview")
          row
            .put("assumption", "indicative-unfunded-confidential-route")
            .put("profileChainId", 4663)
            .put("leg", b.getString("leg"))
            .put("recipient", b.getString("recipient"))
            .put("amountAtoms", b.getString("amountAtoms"))
            .put("estimatedOutputAtoms", b.getString("amountAtoms"))
            .put("minimumOutputAtoms", b.getString("amountAtoms"))
            .put("feePolicy", JSONObject().put("totalFeeBps", 0))
            .put("referenceHash", "0x" + "1".repeat(64))
        else {
          val amount =
            (b.getString("expectedUsdgAtoms").toBigInteger() - 21000.toBigInteger()).toString()
          row
            .put("assumption", "hypothetical-USDG-funding-isolated-fork")
            .put("profileId", "robinhood-usdg")
            .put("chainId", 4663)
            .put("owner", b.getString("owner"))
            .put("token", HOOD_EARN_USDG)
            .put("vault", HOOD_EARN_VAULT)
            .put("expectedUsdgAtoms", b.getString("expectedUsdgAtoms"))
            .put("startingUsdgAtoms", b.getString("startingUsdgAtoms"))
            .put("policyVersion", "robinhood-v1")
            .put("depositAmount", amount)
            .put("depositFeeBudget", "10000")
            .put("withdrawalReserve", "11000")
            .put("shareDecimals", 18)
            .put("previewShares", amount)
            .put("maxSharePrice", "1000000000000000000000000000")
        }
        row.toString()
      },
      { clock },
      feeValidator = { 0 },
    )

  private suspend fun prepared(record: WalletRecord, journal: EarnDepositJournal): JSONObject {
    val rows =
      listOf(143 to "9900000", 8453 to "4900000").map { (chain, amount) ->
        val id = "public_$chain"
        DepositFixtures.funding(record, 1).put("operationId", id).also { row ->
          row
            .getJSONObject("proposal")
            .put("operationId", id)
            .put("chainId", chain)
            .put("token", fundingNetwork(chain).token)
            .put("amountAtoms", amount)
            .put("budgetAtoms", (amount.toBigInteger() + 20000.toBigInteger()).toString())
            .put("fundingBatchSize", 2)
        }
      }
    val owner = sharedConfidential(record)
    val private =
      JSONObject()
        .put("walletId", record.id)
        .put("operationId", "private_existing")
        .put("revision", 1)
        .put("status", "privateReserved")
        .put(
          "proposal",
          JSONObject()
            .put("kind", "privateEarnFunding")
            .put("operationId", "private_existing")
            .put("revision", 1)
            .put("profileChainId", 4663)
            .put("cycleIndex", 0)
            .put("sourceAccountIndex", -1)
            .put("expectedFrom", owner)
            .put("confidentialAccount", owner)
            .put("token", MONAD_EARN_USDC)
            .put("amountAtoms", "2000000")
            .put("budgetAtoms", "2000000")
            .put("maximumTokenFeeAtoms", "0")
            .put("deadline", 9999)
            .put(
              "source",
              JSONObject()
                .put("kind", "swap")
                .put("profileChainId", 0)
                .put("cycleIndex", 0)
                .put("address", owner)
                .put("amountAtoms", "2000000"),
            ),
        )
    val reservation =
      JSONObject()
        .put("id", "batch1")
        .put("feature", "earn")
        .put("cycleIndex", 0)
        .put("registrationComplete", true)
        .put(
          "legs",
          JSONArray(
            rows.map { row ->
              val p = row.getJSONObject("proposal")
              JSONObject()
                .put("sourceIndex", 1)
                .put("sourceChainId", p.getInt("chainId"))
                .put("token", p.getString("token"))
                .put("decimals", 6)
                .put("address", p.getString("expectedFrom"))
                .put("budgetAtoms", p.getString("budgetAtoms"))
                .put("operationId", row.getString("operationId"))
            }
          ),
        )
    val draft =
      combineDepositSourceDraft(
        record,
        DepositSourceDraft(
          rows + private,
          reservation,
          mapOf(
            "public_143" to "9800000",
            "public_8453" to "4800000",
            "private_existing" to "2000000",
          ),
        ),
        "private_combined",
      )
    return EarnDepositPreparer(journal, gateway(1000), { _, _ -> draft }, {}, { 1000 })
      .prepare(record, 4663, "16840000", null)
  }

  @Test
  fun beforeAndAfterPartialFundingRefreshNeverReadsTheFuturePrivatePool() = runBlocking {
    for (firstConfirmed in listOf(false, true)) record().use { record ->
      val journal = testDepositJournal()
      val initial = prepared(record, journal)
      assertEquals("review", initial.getString("phase"))
      val id = initial.getString("journeyId")
      val old = initial.getJSONObject("review")
      journal.pause(id, "approvalExpired")
      val refreshed = mutableListOf<String>()
      val remaining =
        EarnDepositRemaining(
          journal,
          gateway(100000),
          { original ->
            assertFalse(
              "The future canonical pool must not be read before the final source credit",
              isPrivateDepositSource(original),
            )
            val sourceId = original.getString("operationId")
            refreshed += sourceId
            val row = JSONObject(original.toString())
            row.getJSONObject("proposal").put("deadline", 280)
            if (sourceId == "public_143" && firstConfirmed) {
              row
                .put("signedUserOperation", "immutable")
                .put("privateBaseline", "50000000")
                .put(
                  "settlement",
                  JSONObject()
                    .put("status", "credited")
                    .put("creditedAtoms", "9900000")
                    .put("settlementEnvelope", "sealed-first"),
                )
              DepositRemainingSource(row, "9900000", "9900000")
            } else
              DepositRemainingSource(row, if (sourceId == "public_143") "9800000" else "4700000")
          },
          { error("No payout may be invented") },
          { error("No payout receipt exists") },
          { old.getJSONObject("reservation") },
          { error("No deposit exists") },
          { 100000 },
        )
      val updated =
        remaining.refresh(record, id, journal.get(id).getInt("revision")).getJSONObject("review")
      assertEquals(listOf("public_143", "public_8453"), refreshed)
      assertEquals("16840000", updated.getString("sourceBudgetAtoms"))
      assertEquals(
        if (firstConfirmed) "16600000" else "16500000",
        updated.getString("fundedBudgetMinimumAtoms"),
      )
      assertEquals(
        old.getJSONObject("distribution").toString(),
        updated.getJSONObject("distribution").toString(),
      )
      assertEquals(
        old.getJSONArray("destinations").toString(),
        updated.getJSONArray("destinations").toString(),
      )
      if (firstConfirmed)
        assertEquals(
          "sealed-first",
          updated
            .getJSONArray("publicFundingRows")
            .getJSONObject(0)
            .getJSONObject("settlement")
            .getString("settlementEnvelope"),
        )
    }
  }

  @Test
  fun savedActualHandoffResumesPaidSiblingWithoutReattributingPublicCredits(): Unit = runBlocking {
    record().use { record ->
      val journal = testDepositJournal()
      val initial = prepared(record, journal)
      val id = initial.getString("journeyId")
      val old = initial.getJSONObject("review")
      journal.update(id, journal.get(id).getInt("revision")) {
        it.put("privateHandoff", JSONObject().put("private_combined", "16800000"))
      }
      journal.attachChild(id, journal.get(id).getInt("revision"), "invest:0", "paid_first")
      journal.pause(id, "approvalExpired")
      var privateReads = 0
      val requests = mutableListOf<Pair<String, JSONObject>>()
      val remaining =
        EarnDepositRemaining(
          journal,
          gateway(100000, requests),
          { original ->
            assertTrue(
              "Saved public credit must be replayed through the immutable handoff",
              isPrivateDepositSource(original),
            )
            privateReads++
            assertEquals(
              "16800000",
              original.getJSONObject("proposal").getJSONObject("source").getString("amountAtoms"),
            )
            DepositRemainingSource(
              JSONObject(original.toString()).also {
                it.getJSONObject("proposal").put("deadline", 280)
              },
              "16800000",
            )
          },
          {
            JSONObject()
              .put("operationId", "paid_first")
              .put("status", "paid")
              .put("signedData", "immutable")
              .put("receivedAtoms", "4200000")
              .put(
                "proposal",
                JSONObject()
                  .put("operationId", "private_combined")
                  .put("leg", "invest:0")
                  .put("amountAtoms", "4200000"),
              )
          },
          { it.getString("receivedAtoms") },
          { old.getJSONObject("reservation") },
          { error("No vault child") },
          { 100000 },
        )
      val updated = remaining.refresh(record, id, journal.get(id).getInt("revision"))
      assertEquals(1, privateReads)
      assertEquals(1, requests.count { it.first == "/native/payout/preview" })
      assertEquals(
        "paid_first",
        updated.getJSONObject("children").getJSONArray("invest:0").getString(0),
      )
      assertEquals("16840000", updated.getJSONObject("review").getString("sourceBudgetAtoms"))
      assertEquals(
        "16800000",
        updated.getJSONObject("review").getString("fundedBudgetMinimumAtoms"),
      )
      assertEquals(
        "16800000",
        updated.getJSONObject("privateHandoff").getString("private_combined"),
      )
      val changed = JSONObject(updated.getJSONObject("review").toString())
      changed.getJSONObject("privateHandoff").put("private_combined", "16800001")
      assertThrows(IllegalStateException::class.java) {
        journal.saveRemainingReview(id, updated.getInt("revision"), changed)
      }
    }
  }

  @Test
  fun refreshedSourcesKeepChainGrossBudgetSignedBaselineAndCreditSeal() {
    record().use { record ->
      val original = DepositFixtures.funding(record, 1)
      for (field in listOf("chainId", "budgetAtoms", "sourceAccountIndex")) {
        val changed = JSONObject(original.toString())
        changed
          .getJSONObject("proposal")
          .put(
            field,
            when (field) {
              "chainId" -> 8453
              "sourceAccountIndex" -> 3
              else -> "1010001"
            },
          )
        assertThrows(IllegalStateException::class.java) {
          assertDepositPublicSourceRefresh(original, changed)
        }
      }
      val signed =
        JSONObject(original.toString())
          .put("signedUserOperation", "immutable")
          .put(
            "stateBinding",
            JSONObject()
              .put(
                "privateBaseline",
                JSONObject().put("available", "50000000").put("baselineEnvelope", "original"),
              ),
          )
          .put(
            "settlement",
            JSONObject()
              .put("status", "credited")
              .put("creditedAtoms", "990000")
              .put("settlementEnvelope", "sealed"),
          )
      val changedBaseline = JSONObject(signed.toString())
      changedBaseline
        .getJSONObject("stateBinding")
        .getJSONObject("privateBaseline")
        .put("available", "51000000")
      assertThrows(IllegalStateException::class.java) {
        assertDepositPublicSourceRefresh(signed, changedBaseline)
      }
      val changedSeal = JSONObject(signed.toString())
      changedSeal.getJSONObject("settlement").put("settlementEnvelope", "other")
      assertThrows(IllegalStateException::class.java) {
        assertDepositPublicSourceRefresh(signed, changedSeal)
      }
      assertDepositPublicSourceRefresh(signed, JSONObject(signed.toString()))
    }
  }

  @Test
  fun remainingReviewCannotReorderItsSavedPublicFundingSequence(): Unit = runBlocking {
    record().use { record ->
      val journal = testDepositJournal()
      val initial = prepared(record, journal)
      val id = initial.getString("journeyId")
      journal.pause(id, "approvalExpired")
      val changed = JSONObject(initial.getJSONObject("review").toString())
      val rows = changed.getJSONArray("publicFundingRows")
      changed.put(
        "publicFundingRows",
        JSONArray().put(rows.getJSONObject(1)).put(rows.getJSONObject(0)),
      )
      assertThrows(IllegalStateException::class.java) {
        journal.saveRemainingReview(id, journal.get(id).getInt("revision"), changed)
      }
    }
  }
}
