package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import uniffi.gizu_stored_signer_core.deriveAccountAddressRange

internal class DepositMemoryFile : WalletFile {
  var bytes: ByteArray? = null
  var fail = false

  override fun exists() = bytes != null

  override fun read() = bytes!!.copyOf()

  override fun write(bytes: ByteArray) {
    check(!fail)
    this.bytes = bytes.copyOf()
  }
}

internal fun testDepositJournal(file: WalletFile = DepositMemoryFile()): EarnDepositJournal {
  val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
  return EarnDepositJournal(file, { key }, DepositFixtures.wallet, DepositFixtures.wallet)
}

internal fun distributionDepositRecord(
  weights: List<Int> = listOf(2500, 7500),
  budgetAtoms: String? = null,
): WalletRecord =
  WalletRecord(
    DepositFixtures.wallet,
    StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
    ByteArray(32),
    true,
    DepositFixtures.wallet,
    INITIAL_ROLE_REGISTRY,
    4663,
    false,
    0,
    JSONArray()
      .put(
        JSONObject()
          .put("cycleIndex", 0)
          .put("chainId", 4663)
          .put("distribution", JSONObject().put("version", 1).put("weightsBps", JSONArray(weights)))
          .also { if (budgetAtoms != null) it.put("distributionBudgetAtoms", budgetAtoms) }
      )
      .toString(),
  )

class EarnDepositPreparerTest {
  @Test
  fun routeMinimumExplanationSurvivesThePublicSnapshot() = runBlocking {
    distributionDepositRecord(weights = listOf(10000)).use { record ->
      val journal = testDepositJournal()
      val preparer =
        EarnDepositPreparer(
          journal,
          EarnDepositGateway({ _, _ -> error("No preview should run") }),
          { _, budget ->
            val selection =
              selectPrivateDepositSources(
                budget,
                listOf(JSONObject().put("address", "first"), JSONObject().put("address", "dust")),
              ) {
                if (it.getString("address") == "first") "1800000" else "142172"
              }
            requireRoutablePublicRemainder(selection, savedCycleDistribution(record))
            error("The public shortfall must block preparation")
          },
          {},
        )
      val result = preparer.prepare(record, 4663, "1942172", null)
      val public = JSONObject(journal.publicSnapshot(result.getString("journeyId")))
      assertEquals("uneconomicAmount", public.getString("pauseReason"))
      assertEquals(
        "You can deposit 1.8 USDC from routable private balances before fees. " +
          "The remaining 0.142172 USDC needs public funding, which requires at least 0.2 USDC. " +
          "Change the amount to 1.8 USDC and review the fees.",
        public.optString("message"),
      )
      assertFalse(public.has("review"))
      assertEquals(0, result.getJSONObject("children").length())
    }
  }

  @Test
  fun freshSourceShortfallIsInsufficientFundsRatherThanUnavailablePreview() = runBlocking {
    DepositFixtures.record().use { record ->
      val journal = testDepositJournal()
      val preparer =
        EarnDepositPreparer(
          journal,
          EarnDepositGateway({ _, _ -> error("No preview should run without funds") }),
          { _, _ -> throw RpcFailure(RpcFailureCode.INSUFFICIENT_FUNDS) },
          {},
        )
      val result = preparer.prepare(record, 4663, "1010000", null)
      assertEquals("paused", result.getString("phase"))
      assertEquals("insufficientFunds", result.getString("pauseReason"))
      assertEquals(0, result.getJSONObject("children").length())
      assertFalse(result.has("review"))
    }
  }

  private fun privateSourceDraft(record: WalletRecord, mixed: Boolean): DepositSourceDraft {
    val base =
      DistributionDepositFixtures.review(
        record,
        if (mixed) listOf("990000", "990000") else listOf("990000"),
      )
    val address = deriveAccountAddressRange(record.entropy, 2u, 1u).single()
    val descriptor =
      JSONObject()
        .put("kind", "swap")
        .put("profileChainId", 0)
        .put("cycleIndex", 0)
        .put("address", address)
        .put("amountAtoms", "990000")
    val private =
      JSONObject()
        .put("operationId", "source0")
        .put("walletId", record.id)
        .put("revision", 1)
        .put("status", "privateReserved")
        .put(
          "proposal",
          JSONObject()
            .put("kind", "privateEarnFunding")
            .put("operationId", "source0")
            .put("revision", 1)
            .put("profileChainId", 4663)
            .put("cycleIndex", record.earnCycleIndex)
            .put("sourceAccountIndex", -1)
            .put("expectedFrom", address)
            .put("confidentialAccount", cycleConfidential(record))
            .put("source", descriptor)
            .put("token", MONAD_EARN_USDC)
            .put("amountAtoms", "990000")
            .put("budgetAtoms", "990000")
            .put("maximumTokenFeeAtoms", "0")
            .put("deadline", 180),
        )
    val publicRows = base.getJSONArray("fundingRows").objects().drop(1)
    publicRows.forEach { it.getJSONObject("proposal").put("fundingBatchSize", publicRows.size) }
    val rows = listOf(private) + publicRows
    val reservation =
      if (mixed)
        JSONObject(base.getJSONObject("reservation").toString())
          .put(
            "legs",
            JSONArray(base.getJSONObject("reservation").getJSONArray("legs").objects().drop(1)),
          )
      else JSONObject().put("id", "private_only_placeholder")
    return DepositSourceDraft(
      rows,
      reservation,
      rows.associate {
        it.getString("operationId") to it.getJSONObject("proposal").getString("amountAtoms")
      },
    )
  }

  @Test
  fun privateOnlyAndMixedPreparationPublishZeroPrivateFeesAndPreserveExactInputBudgets() =
    runBlocking {
      for (mixed in listOf(false, true)) distributionDepositRecord().use { record ->
        val journal = testDepositJournal()
        val draft = privateSourceDraft(record, mixed)
        val budget = if (mixed) "2000000" else "990000"
        val totalCredit = if (mixed) "1980000" else "990000"
        var selected = 0
        var releases = 0
        val requests = mutableListOf<Pair<String, JSONObject>>()
        val diagnostics = mutableListOf<String>()
        val gateway =
          EarnDepositGateway(
            { path, text ->
              val body = JSONObject(text)
              requests += path to body
              if (path == "/robinhood/deposit-preview") {
                // This is published before vault reads; zero private fees must reach this stage.
                val preparing = journal.all().single()
                assertEquals("preparing", preparing.getString("phase"))
                val indicative = preparing.getJSONObject("indicativeReview")
                assertEquals(
                  if (mixed) "10000" else "0",
                  indicative.getString("sourceMaximumFeeAtoms"),
                )
                assertEquals(totalCredit, indicative.getString("investEstimatedAtoms"))
                assertEquals("0", indicative.getString("holdEstimatedAtoms"))
              }
              previewResponse(path, body, 1000)
            },
            { 1000 },
            feeValidator = { 0 },
          )
        val row =
          EarnDepositPreparer(
              journal,
              gateway,
              { _, selectedBudget ->
                assertEquals(budget, selectedBudget)
                selected++
                draft
              },
              { releases++ },
              { 1000 },
              reportFailure = { stage, code, _ -> diagnostics += "$stage:$code" },
            )
            .prepare(record, 4663, budget, null)
        assertEquals(diagnostics.toString(), "review", row.getString("phase"))
        assertEquals(1, selected)
        assertEquals(0, releases)
        assertTrue(diagnostics.isEmpty())
        val review = row.getJSONObject("review")
        val sources = review.getJSONArray("sources").objects()
        val private = sources.single { it.optString("kind") == "private" }
        assertEquals(-1, private.getInt("accountIndex"))
        for (field in listOf("amountAtoms", "budgetAtoms", "minimumCreditAtoms")) assertEquals(
          "990000",
          private.getString(field),
        )
        for (field in listOf("maximumFeeAtoms", "retainedAtoms")) assertEquals(
          "0",
          private.getString(field),
        )
        assertEquals(budget, review.getString("sourceBudgetAtoms"))
        assertEquals(budget, sources.sumOf { it.getString("budgetAtoms").toLong() }.toString())
        assertEquals(
          totalCredit,
          sources
            .flatMap { it.getJSONArray("allocations").objects() }
            .sumOf { it.getString("inputAtoms").toLong() }
            .toString(),
        )
        val privateRows =
          review.getJSONArray("fundingRows").objects().filter(::isPrivateDepositSource)
        assertEquals(1, privateRows.size)
        assertFalse(privateRows.single().has("unsignedUserOperation"))
        assertFalse(privateRows.single().has("signedUserOperation"))
        assertEquals(
          if (mixed) 1 else 0,
          review.getJSONArray("fundingRows").objects().count { !isPrivateDepositSource(it) },
        )
        assertEquals(2 * sources.size, requests.count { it.first == "/native/payout/preview" })
        assertEquals(2, requests.count { it.first == "/robinhood/deposit-preview" })
        assertTrue(requests.all { !it.second.has("signedData") })
        assertEquals(0, row.getJSONObject("children").length())
        EarnDepositApproval.fromReview(record, review).invalidate()
      }
    }

  @Test
  fun privateOnlyRemainingReviewRefreshAcceptsZeroFeeAndPrivateReservationPlaceholder() =
    runBlocking {
      distributionDepositRecord().use { record ->
        val journal = testDepositJournal()
        val draft = privateSourceDraft(record, false)
        val initialGateway =
          EarnDepositGateway(
            { path, text -> previewResponse(path, JSONObject(text), 1000) },
            { 1000 },
            feeValidator = { 0 },
          )
        val initial =
          EarnDepositPreparer(journal, initialGateway, { _, _ -> draft }, {}, { 1000 })
            .prepare(record, 4663, "990000", null)
        assertEquals("review", initial.getString("phase"))
        val id = initial.getString("journeyId")
        journal.pause(id, "termsChanged")
        var sourceReads = 0
        var reservationReads = 0
        val requests = mutableListOf<String>()
        val gateway =
          EarnDepositGateway(
            { path, text ->
              requests += path
              previewResponse(path, JSONObject(text), 100000)
            },
            { 100000 },
            feeValidator = { 0 },
          )
        val refresh =
          EarnDepositRemaining(
            journal,
            gateway,
            { original ->
              assertTrue(isPrivateDepositSource(original))
              sourceReads++
              val updated =
                JSONObject(original.toString()).also {
                  it.getJSONObject("proposal").put("deadline", 280)
                }
              DepositRemainingSource(updated, "990000")
            },
            { error("No saved payout or invented source credit") },
            { error("No saved payout receipt") },
            {
              reservationReads++
              JSONObject(draft.reservation.toString())
            },
            { error("No vault child exists") },
            { 100000 },
          )
        val refreshed = refresh.refresh(record, id, journal.get(id).getInt("revision"))
        assertEquals("paused", refreshed.getString("phase"))
        assertEquals(1, sourceReads)
        assertEquals(1, reservationReads)
        assertEquals(2, requests.count { it == "/native/payout/preview" })
        assertEquals(2, requests.count { it == "/robinhood/deposit-preview" })
        val review = refreshed.getJSONObject("review")
        assertEquals(
          "private_only_placeholder",
          review.getJSONObject("reservation").getString("id"),
        )
        assertEquals(1, review.getJSONObject("reservation").length())
        val source = review.getJSONArray("sources").getJSONObject(0)
        assertEquals("private", source.getString("kind"))
        assertEquals("0", source.getString("maximumFeeAtoms"))
        assertEquals("0", source.getString("retainedAtoms"))
        assertEquals("990000", source.getString("minimumCreditAtoms"))
        assertTrue(
          nativeJsonEqual(
            draft.rows.single().getJSONObject("proposal").getJSONObject("source"),
            review
              .getJSONArray("fundingRows")
              .getJSONObject(0)
              .getJSONObject("proposal")
              .getJSONObject("source"),
          )
        )
        assertEquals(0, refreshed.getJSONObject("children").length())
        EarnDepositApproval.fromRemainingReview(record, review, 100000).apply {
          approveAfterPasskey(100001)
          invalidate()
        }
        Unit
      }
    }

  private fun sourceDraft(r: WalletRecord): DepositSourceDraft {
    val review = DepositFixtures.review(r)
    return DepositSourceDraft(
      review.getJSONArray("fundingRows").objects(),
      review.getJSONObject("reservation"),
      mapOf("source0" to "990000"),
    )
  }

  private fun previewResponse(
    path: String,
    b: JSONObject,
    clock: Long,
    expires: Long = clock + 45000,
    reduction: Long = 0,
  ): String {
    val row =
      JSONObject()
        .put("kind", "preview")
        .put("readOnly", true)
        .put("executionAvailable", false)
        .put("operationId", b.getString("operationId"))
        .put("revision", b.getInt("revision"))
        .put("quotedAtMs", clock)
        .put("expiresAtMs", expires)
    if (path == "/native/payout/preview") {
      val output = b.getString("amountAtoms").toLong() - reduction
      return row
        .put("assumption", "indicative-unfunded-confidential-route")
        .put("profileChainId", 4663)
        .put("leg", b.getString("leg"))
        .put("recipient", b.getString("recipient"))
        .put("amountAtoms", b.getString("amountAtoms"))
        .put("estimatedOutputAtoms", output.toString())
        .put("minimumOutputAtoms", output.toString())
        .put("feePolicy", JSONObject().put("totalFeeBps", 0))
        .put("referenceHash", "0x" + "1".repeat(64))
        .toString()
    }
    val assets = b.getString("expectedUsdgAtoms").toLong() - 21000
    return row
      .put("assumption", "hypothetical-USDG-funding-isolated-fork")
      .put("profileId", "robinhood-usdg")
      .put("chainId", 4663)
      .put("owner", b.getString("owner"))
      .put("token", HOOD_EARN_USDG)
      .put("vault", HOOD_EARN_VAULT)
      .put("expectedUsdgAtoms", b.getString("expectedUsdgAtoms"))
      .put("startingUsdgAtoms", b.getString("startingUsdgAtoms"))
      .put("policyVersion", "robinhood-v1")
      .put("depositAmount", assets.toString())
      .put("depositFeeBudget", "10000")
      .put("withdrawalReserve", "11000")
      .put("shareDecimals", 18)
      .put("previewShares", assets.toString())
      .put("maxSharePrice", "1000000000000000000000000000")
      .toString()
  }

  @Test
  fun distributionPreparesOnlyInvestmentSlotsAndReviewsIndependentVaultBudgets() = runBlocking {
    for (weights in listOf(listOf(10000), listOf(2500, 7500), List(5) { 2000 })) {
      distributionDepositRecord(weights).use { record ->
        val requests = mutableListOf<Pair<String, JSONObject>>()
        val gateway =
          EarnDepositGateway(
            { path, text ->
              val body = JSONObject(text)
              requests.add(path to body)
              previewResponse(path, body, 1000)
            },
            { 1000 },
            feeValidator = { 0 },
          )
        val draft = DepositFixtures.record().use { sourceDraft(it) }
        val journal = testDepositJournal()
        val row =
          EarnDepositPreparer(journal, gateway, { _, _ -> draft }, {}, { 1000 })
            .prepare(record, 4663, "1010000", null)
        assertEquals("review", row.getString("phase"))
        val review = row.getJSONObject("review")
        assertEquals(weights, distributionWeights(review.getJSONObject("distribution")))
        val allocations =
          review.getJSONArray("sources").getJSONObject(0).getJSONArray("allocations")
        assertEquals(weights.size, allocations.length())
        assertEquals(
          "990000",
          allocations.objects().sumOf { it.getString("inputAtoms").toLong() }.toString(),
        )
        val deposits = review.getJSONArray("deposits").objects()
        assertEquals(weights.size, deposits.size)
        assertEquals(weights.size, requests.count { it.first == "/robinhood/deposit-preview" })
        assertEquals(
          weights.indices.map { "invest:$it" },
          requests
            .filter { it.first == "/native/payout/preview" }
            .map { it.second.getString("leg") },
        )
        for (slot in weights.indices) {
          assertEquals(
            cycleInvestmentAddress(record, slot),
            allocations.getJSONObject(slot).getString("recipient"),
          )
          assertEquals(slot, deposits[slot].getInt("slot"))
          assertEquals(cycleInvestmentAddress(record, slot), deposits[slot].getString("recipient"))
        }
        assertEquals(
          (990000L - weights.size * 21000L).toString(),
          review.getJSONObject("deposit").getString("estimatedAssetsAtoms"),
        )
        val public = JSONObject(journal.publicSnapshot(row.getString("journeyId")))
        assertEquals(weights.size, public.getJSONObject("review").getJSONArray("deposits").length())
        assertFalse(public.toString().contains("fundingRows"))
        assertFalse(public.toString().contains("roleRegistry"))
      }
    }
  }

  @Test
  fun independentPayoutPreviewsOverlapBeforeTheVaultRead() = runBlocking {
    DepositFixtures.record().use { r ->
      val started = mutableListOf<String>()
      val gateway =
        EarnDepositGateway(
          { path, text ->
            val b = JSONObject(text)
            if (path == "/native/payout/preview") {
              started.add(b.getString("leg"))
              kotlinx.coroutines.yield()
              assertTrue(
                "Both independent quotes should already be in flight",
                started.containsAll(listOf("hold", "invest")),
              )
            }
            previewResponse(path, b, 1000)
          },
          { 1000 },
          feeValidator = { 0 },
        )
      val result =
        EarnDepositPreparer(testDepositJournal(), gateway, { _, _ -> sourceDraft(r) }, {}, { 1000 })
          .prepare(r, 4663, "1010000", null)
      assertEquals("review", result.getString("phase"))
      assertEquals(2, started.size)
    }
  }

  @Test
  fun slowVaultReadRefreshesRealExpiriesAndRecalculatesChangedPayoutMinimums() = runBlocking {
    DepositFixtures.record().use { r ->
      var clock = 1000L
      var vaults = 0
      var payouts = 0
      val expected = mutableListOf<String>()
      val journal = testDepositJournal()
      val gateway =
        EarnDepositGateway(
          { path, text ->
            val b = JSONObject(text)
            if (path == "/robinhood/deposit-preview") {
              vaults++
              expected.add(b.getString("expectedUsdgAtoms"))
              if (vaults == 1) clock += 50000
              previewResponse(path, b, clock, if (vaults == 1) clock + 10000 else clock + 45000)
            } else {
              payouts++
              previewResponse(
                path,
                b,
                clock,
                reduction = if (clock > 1000 && b.getString("leg") == "invest") 50000 else 0,
              )
            }
          },
          { clock },
          feeValidator = { 0 },
        )
      val result =
        EarnDepositPreparer(journal, gateway, { _, _ -> sourceDraft(r) }, {}, { clock })
          .prepare(r, 4663, "1010000", null)
      assertEquals("review", result.getString("phase"))
      assertEquals(listOf("891000", "841000"), expected)
      assertEquals(4, payouts)
      assertEquals(51000, result.getJSONObject("review").getLong("quotedAtMs"))
      assertEquals(96000, result.getJSONObject("review").getLong("expiresAtMs"))
      assertEquals(
        "814750", // 820000 less 25% of the 21000 fee and reserve gas.
        result.getJSONObject("review").getJSONObject("deposit").getString("minimumAssetsAtoms"),
      )
      assertEquals(0, result.getJSONObject("children").length())
      EarnDepositApproval.fromReview(r, result.getJSONObject("review")).invalidate()
    }
  }

  @Test
  fun cancellationDuringVaultCalculationCannotPublishAnAuthorizingReview() = runBlocking {
    DepositFixtures.record().use { r ->
      val journal = testDepositJournal()
      var releases = 0
      val gateway =
        EarnDepositGateway(
          { path, text ->
            if (path == "/robinhood/deposit-preview")
              journal.pause(journal.all().single().getString("journeyId"), "cancelled")
            previewResponse(path, JSONObject(text), 1000)
          },
          { 1000 },
          feeValidator = { 0 },
        )
      val result =
        EarnDepositPreparer(journal, gateway, { _, _ -> sourceDraft(r) }, { releases++ }, { 1000 })
          .prepare(r, 4663, "1010000", null)
      assertEquals("paused", result.getString("phase"))
      assertEquals("cancelled", result.getString("pauseReason"))
      assertFalse(result.has("review"))
      assertEquals(0, result.getJSONObject("children").length())
      assertEquals(1, releases)
    }
  }

  @Test
  fun continuouslyWorseningPreviewsStopAfterBoundedAttemptsWithoutSpending() = runBlocking {
    DepositFixtures.record().use { r ->
      var clock = 1000L
      var vaults = 0
      val journal = testDepositJournal()
      val gateway =
        EarnDepositGateway(
          { path, text ->
            val b = JSONObject(text)
            if (path == "/robinhood/deposit-preview") {
              vaults++
              clock += 30000
              previewResponse(path, b, clock)
            } else
              previewResponse(
                path,
                b,
                clock,
                reduction = if (b.getString("leg") == "invest") vaults * 50000L else 0,
              )
          },
          { clock },
          feeValidator = { 0 },
        )
      val result =
        EarnDepositPreparer(journal, gateway, { _, _ -> sourceDraft(r) }, {}, { clock })
          .prepare(r, 4663, "1010000", null)
      assertEquals(3, vaults)
      assertEquals("paused", result.getString("phase"))
      assertFalse(result.has("review"))
      assertEquals(0, result.getJSONObject("children").length())
    }
  }

  @Test
  fun reviewOnlyUsesIndividualPreviewReadsAndKeepsTheSameDraftPair() = runBlocking {
    DepositFixtures.record().use { r ->
      val j = testDepositJournal()
      var selections = 0
      var releases = 0
      val requests = mutableListOf<JSONObject>()
      val gateway =
        EarnDepositGateway(
          { path, body ->
            val b = JSONObject(body)
            requests.add(b)
            when (path) {
              "/native/payout/preview" ->
                JSONObject()
                  .put("kind", "preview")
                  .put("readOnly", true)
                  .put("executionAvailable", false)
                  .put("assumption", "indicative-unfunded-confidential-route")
                  .put("operationId", b.getString("operationId"))
                  .put("revision", b.getInt("revision"))
                  .put("profileChainId", 4663)
                  .put("leg", b.getString("leg"))
                  .put("recipient", b.getString("recipient"))
                  .put("amountAtoms", b.getString("amountAtoms"))
                  .put("estimatedOutputAtoms", b.getString("amountAtoms"))
                  .put("minimumOutputAtoms", b.getString("amountAtoms"))
                  .put("feePolicy", JSONObject().put("totalFeeBps", 0))
                  .put("quotedAtMs", 1000)
                  .put("expiresAtMs", 46000)
                  .put("referenceHash", "0x" + "1".repeat(64))
                  .toString()
              "/robinhood/deposit-preview" ->
                JSONObject()
                  .also {
                    val partial = j.all().single { it.getString("phase") == "preparing" }
                    assertFalse(partial.has("review"))
                    val public = JSONObject(j.publicSnapshot(partial.getString("journeyId")))
                    val indicative = public.getJSONObject("indicativeReview")
                    assertEquals("99000", indicative.getString("holdEstimatedAtoms"))
                    assertEquals("891000", indicative.getString("investEstimatedAtoms"))
                    assertFalse(indicative.has("fundingRows"))
                  }
                  .put("kind", "preview")
                  .put("readOnly", true)
                  .put("executionAvailable", false)
                  .put("assumption", "hypothetical-USDG-funding-isolated-fork")
                  .put("operationId", b.getString("operationId"))
                  .put("revision", b.getInt("revision"))
                  .put("profileId", "robinhood-usdg")
                  .put("chainId", 4663)
                  .put("owner", b.getString("owner"))
                  .put("token", HOOD_EARN_USDG)
                  .put("vault", HOOD_EARN_VAULT)
                  .put("expectedUsdgAtoms", b.getString("expectedUsdgAtoms"))
                  .put("quotedAtMs", 1000)
                  .put("expiresAtMs", 45000)
                  .put("policyVersion", "robinhood-v1")
                  .put("depositAmount", "870000")
                  .put("depositFeeBudget", "10000")
                  .put("withdrawalReserve", "11000")
                  .put("shareDecimals", 18)
                  .put("previewShares", "870000")
                  .put("maxSharePrice", "1000000000000000000000000000")
                  .toString()
              else -> error("Preparation attempted an execution/auth endpoint")
            }
          },
          { 1000 },
          feeValidator = { policy ->
            check(policy.getInt("totalFeeBps") == 0)
            0
          },
        )
      val preparer =
        EarnDepositPreparer(
          j,
          gateway,
          { record, budget ->
            selections++
            check(record.id == r.id && budget == "1010000")
            val review = DepositFixtures.review(r)
            DepositSourceDraft(
              review.getJSONArray("fundingRows").objects(),
              review.getJSONObject("reservation"),
              mapOf("source0" to "990000"),
            )
          },
          { releases++ },
          { 1000 },
        )
      val first = preparer.prepare(r, 4663, "1010000", null)
      val next = preparer.prepare(r, 4663, "1010000", first.getString("journeyId"))
      assertEquals(first.getString("journeyId"), next.getString("journeyId"))
      assertEquals(
        first.getJSONArray("destinations").toString(),
        next.getJSONArray("destinations").toString(),
      )
      assertEquals(2, selections)
      assertEquals(1, releases)
      assertEquals(6, requests.size)
      assertTrue(requests.all { !it.has("accounts") && !it.has("signedData") })
      assertEquals(45000, next.getJSONObject("review").getInt("expiresAtMs"))
      assertEquals(
        "864750", // Scaled with the gas-tolerant minimum assets.
        next.getJSONObject("review").getJSONObject("deposit").getString("minimumSharesAtoms"),
      )
      assertEquals(0, next.getJSONObject("children").length())
    }
  }

  @Test
  fun missingDeploymentOrUnqualifiedPreviewBlocksBeforeChildCreation() = runBlocking {
    DepositFixtures.record().use { r ->
      val j = testDepositJournal()
      val preparer =
        EarnDepositPreparer(
          j,
          EarnDepositGateway({ _, _ -> error("HTTP 404") }, { 1000 }),
          { _, _ ->
            val review = DepositFixtures.review(r)
            DepositSourceDraft(
              review.getJSONArray("fundingRows").objects(),
              review.getJSONObject("reservation"),
              mapOf("source0" to "990000"),
            )
          },
          {},
          { 1000 },
        )
      val result = preparer.prepare(r, 4663, "1010000", null)
      assertEquals("paused", result.getString("phase"))
      assertEquals("previewUnavailable", result.getString("pauseReason"))
      assertFalse(result.has("review"))
      assertEquals(0, result.getJSONObject("children").length())
    }
  }

  @Test
  fun sourceFailureDiagnosticsExcludePrivateExceptionDetailsAndKeepSpendingBlocked() = runBlocking {
    DepositFixtures.record().use { r ->
      val j = testDepositJournal()
      val diagnostics = mutableListOf<List<String>>()
      val preparer =
        EarnDepositPreparer(
          j,
          EarnDepositGateway({ _, _ -> error("Should not request downstream previews") }),
          { _, _ ->
            throw EarnGatewayFailure("EARN_AURORA_FEE_UNQUALIFIED", "private-owner-and-secret")
          },
          {},
          { 1000 },
          reportFailure = { stage, code, location ->
            diagnostics.add(listOf(stage, code, location))
          },
        )
      val result = preparer.prepare(r, 4663, "1010000", null)
      assertEquals("previewUnavailable", result.getString("pauseReason"))
      assertEquals(0, result.getJSONObject("children").length())
      assertEquals(1, diagnostics.size)
      assertEquals("sources", diagnostics.single()[0])
      assertEquals("EARN_AURORA_FEE_UNQUALIFIED", diagnostics.single()[1])
      assertTrue(diagnostics.single()[2].startsWith("EarnDepositPreparerTest.kt:"))
      assertFalse(diagnostics.toString().contains("private-owner-and-secret"))
      assertFalse(diagnostics.toString().contains(r.id))
    }
  }

  @Test
  fun payoutFailureDiagnosticsIdentifyTheLegWithoutLoggingRequestData() = runBlocking {
    DepositFixtures.record().use { r ->
      val j = testDepositJournal()
      val diagnostics = mutableListOf<List<String>>()
      val preparer =
        EarnDepositPreparer(
          j,
          EarnDepositGateway({ _, _ -> throw RpcFailure(RpcFailureCode.HTTP) }, { 1000 }),
          { _, _ ->
            val review = DepositFixtures.review(r)
            DepositSourceDraft(
              review.getJSONArray("fundingRows").objects(),
              review.getJSONObject("reservation"),
              mapOf("source0" to "990000"),
            )
          },
          {},
          { 1000 },
          reportFailure = { stage, code, location ->
            diagnostics.add(listOf(stage, code, location))
          },
        )
      val result = preparer.prepare(r, 4663, "1010000", null)
      assertEquals("previewUnavailable", result.getString("pauseReason"))
      assertFalse(result.has("review"))
      assertEquals("hold-preview", diagnostics.single()[0])
      assertEquals("HTTP", diagnostics.single()[1])
      assertFalse(diagnostics.toString().contains("990000"))
      assertFalse(diagnostics.toString().contains(cycleConfidential(r)))
    }
  }
}
