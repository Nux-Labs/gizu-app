package io.gizu.storedwallet

import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnDepositRemainingTest {
  @Test
  fun deliveredUsdgKeepsApprovedVaultBoundsWhenFeePreviewIsUnavailable() = runBlocking {
    DepositFixtures.record().use { record ->
      val journal = testDepositJournal()
      val root = journal.loadOrCreate(record, 4663, null)
      val id = root.getString("journeyId")
      val review = DepositFixtures.review(record).put("journeyId", id)
      journal.saveReview(id, root.getInt("revision"), review)
      for (leg in listOf("hold", "invest")) journal.attachChild(
        id,
        journal.get(id).getInt("revision"),
        leg,
        "paid_$leg",
      )
      journal.pause(id, "providerUnavailable")
      val gateway =
        EarnDepositGateway({ path, _ ->
          check(path == "/robinhood/deposit-preview")
          throw EarnGatewayFailure("EARN_DEPOSIT_PREVIEW_UNAVAILABLE", "Fee estimates unavailable")
        })
      val remaining =
        EarnDepositRemaining(
          journal,
          gateway,
          {
            DepositRemainingSource(
              DepositFixtures.funding(record).put("signedUserOperation", "immutable"),
              "990000",
            )
          },
          { childId ->
            val leg = childId.removePrefix("paid_")
            DepositFixtures.payout(record)
              .put("operationId", childId)
              .put("status", "paid")
              .put("signedData", "immutable")
              .put("receivedAtoms", if (leg == "hold") "99000" else "880000")
              .also {
                it
                  .getJSONObject("proposal")
                  .put("leg", leg)
                  .put("amountAtoms", if (leg == "hold") "99000" else "891000")
              }
          },
          { it.getString("receivedAtoms") },
          { review.getJSONObject("reservation") },
          { error("No vault operation has been prepared") },
          { 100000 },
        )
      val next = remaining.refresh(record, id, journal.get(id).getInt("revision"))
      val saved = journal.get(id)
      assertEquals("providerUnavailable", saved.getString("pauseReason"))
      assertEquals(
        "paid_invest",
        saved.getJSONObject("children").getJSONArray("invest").getString(0),
      )
      assertTrue(
        nativeJsonEqual(
          review.getJSONObject("deposit"),
          next.getJSONObject("review").getJSONObject("deposit"),
        )
      )
    }
  }

  @Test
  fun distributionRefreshPreservesCompletedSlotAndOnlyPreviewsItsUnfinishedSibling() = runBlocking {
    distributionDepositRecord().use { record ->
      val journal = testDepositJournal()
      val root = journal.loadOrCreate(record, 4663, null)
      val id = root.getString("journeyId")
      val original =
        DepositFixtures.record()
          .use { DepositFixtures.review(it) }
          .put("journeyId", id)
          .put("distribution", savedCycleDistribution(record))
          .put("destinations", org.json.JSONArray(cycleAddresses(record)))
      val source = original.getJSONArray("sources").getJSONObject(0)
      source.remove("hold")
      source.remove("invest")
      source.put(
        "allocations",
        org.json.JSONArray(
          listOf("247500", "742500").mapIndexed { slot, amount ->
            JSONObject()
              .put("recipient", cycleInvestmentAddress(record, slot))
              .put("inputAtoms", amount)
              .put("minimumOutputAtoms", amount)
              .put("estimatedOutputAtoms", amount)
              .put("providerFeeBps", 4)
          }
        ),
      )
      val deposits =
        listOf("226500", "721500").mapIndexed { slot, assets ->
          JSONObject()
            .put("slot", slot)
            .put("recipient", cycleInvestmentAddress(record, slot))
            .put("estimatedAssetsAtoms", assets)
            .put("minimumAssetsAtoms", assets)
            .put("minimumSharesAtoms", assets)
            .put("maximumFeeAtoms", "10000")
            .put("withdrawalReserveAtoms", "11000")
            .put("shareDecimals", 18)
        }
      original
        .put("deposits", org.json.JSONArray(deposits))
        .put("deposit", aggregateDepositBounds(deposits))
      journal.saveReview(id, root.getInt("revision"), original)
      for ((stage, child) in
        listOf("invest:0" to "paid0", "invest:1" to "paid1", "deposit" to "completed0")) journal
        .attachChild(id, journal.get(id).getInt("revision"), stage, child)
      journal.pause(id, "termsChanged")
      val completed =
        JSONObject()
          .put("status", "finalized")
          .put("signedUserOperation", "immutable")
          .put(
            "proposal",
            JSONObject()
              .put("investmentSlot", 0)
              .put("expectedFrom", cycleInvestmentAddress(record, 0)),
          )
      val requests = mutableListOf<JSONObject>()
      val gateway =
        EarnDepositGateway(
          { path, text ->
            check(path == "/robinhood/deposit-preview")
            val request = JSONObject(text)
            requests.add(request)
            JSONObject()
              .put("kind", "preview")
              .put("readOnly", true)
              .put("executionAvailable", false)
              .put("assumption", "hypothetical-USDG-funding-isolated-fork")
              .put("operationId", request.getString("operationId"))
              .put("revision", request.getInt("revision"))
              .put("quotedAtMs", 100000)
              .put("expiresAtMs", 145000)
              .put("profileId", "robinhood-usdg")
              .put("chainId", 4663)
              .put("owner", request.getString("owner"))
              .put("token", HOOD_EARN_USDG)
              .put("vault", HOOD_EARN_VAULT)
              .put("expectedUsdgAtoms", request.getString("expectedUsdgAtoms"))
              .put("startingUsdgAtoms", request.getString("startingUsdgAtoms"))
              .put("policyVersion", "robinhood-v1")
              .put("depositAmount", "712500")
              .put("depositFeeBudget", "15000")
              .put("withdrawalReserve", "15000")
              .put("previewShares", "712500")
              .put("maxSharePrice", "1000000000000000000000000000")
              .put("shareDecimals", 18)
              .toString()
          },
          { 100000 },
          { 4 },
        )
      val funding =
        original
          .getJSONArray("fundingRows")
          .getJSONObject(0)
          .put("signedUserOperation", "immutable")
      val refresh =
        EarnDepositRemaining(
          journal,
          gateway,
          { DepositRemainingSource(funding, "990000") },
          { childId ->
            val slot = childId.removePrefix("paid").toInt()
            val amount = if (slot == 0) "247500" else "742500"
            JSONObject()
              .put("operationId", childId)
              .put("status", "paid")
              .put("receivedAtoms", amount)
              .put("signedData", "immutable")
              .put(
                "proposal",
                JSONObject()
                  .put("operationId", "source0")
                  .put("leg", "invest:$slot")
                  .put("amountAtoms", amount),
              )
          },
          { it.getString("receivedAtoms") },
          { original.getJSONObject("reservation") },
          { completed },
          { 100000 },
        )
      val next = refresh.refresh(record, id, journal.get(id).getInt("revision"))
      assertEquals(1, requests.size)
      assertEquals(cycleInvestmentAddress(record, 1), requests.single().getString("owner"))
      assertEquals("742500", requests.single().getString("startingUsdgAtoms"))
      val reviewed = next.getJSONObject("review").getJSONArray("deposits")
      assertTrue(nativeJsonEqual(deposits[0], reviewed.getJSONObject(0)))
      assertEquals("705000", reviewed.getJSONObject(1).getString("minimumAssetsAtoms"))
      assertEquals(
        "completed0",
        next.getJSONObject("children").getJSONArray("deposit").getString(0),
      )
    }
  }

  @Test
  fun aReferencedSourceCannotBeReconstructedFromAnUnsignedPreview() {
    DepositFixtures.record().use { r ->
      val original = DepositFixtures.funding(r)
      assertThrows(IllegalStateException::class.java) {
        depositRemainingSourceRecord(original, null, true)
      }
      assertEquals(
        original.toString(),
        depositRemainingSourceRecord(original, null, false).toString(),
      )
      val signed = JSONObject(original.toString()).put("signedUserOperation", "immutable")
      assertEquals(
        "immutable",
        depositRemainingSourceRecord(original, signed, true).getString("signedUserOperation"),
      )
    }
  }

  @Test
  fun freshReviewPreservesPaidChildrenAndShowsWorseUnsignedTerms() = runBlocking {
    for (investArrived in listOf(false, true)) DepositFixtures.record().use { r ->
      val j = testDepositJournal()
      val row = j.loadOrCreate(r, 4663, null)
      val id = row.getString("journeyId")
      val original = DepositFixtures.review(r).put("journeyId", id)
      j.saveReview(id, row.getInt("revision"), original)
      j.attachChild(id, j.get(id).getInt("revision"), "funding", "source0")
      j.attachChild(id, j.get(id).getInt("revision"), "hold", "paid_hold")
      j.pause(id, "termsChanged")
      val source =
        DepositFixtures.funding(r)
          .put("status", "finalized")
          .put("signedUserOperation", "immutable")
      val paid =
        DepositFixtures.payout(r)
          .put("operationId", "paid_hold")
          .put("status", "paid")
          .put("receivedAtoms", "99000")
          .put("signedData", "immutable")
      if (investArrived) j.attachChild(id, j.get(id).getInt("revision"), "invest", "pending_invest")
      val pending =
        JSONObject(paid.toString())
          .put("operationId", "pending_invest")
          .put("status", "submissionUnknown")
          .put("receivedAtoms", "880000")
      pending.getJSONObject("proposal").put("leg", "invest").put("amountAtoms", "891000")
      var authenticatedReads = 0
      var previews = 0
      val gateway =
        EarnDepositGateway(
          { path, body ->
            val b = JSONObject(body)
            val out =
              JSONObject()
                .put("kind", "preview")
                .put("readOnly", true)
                .put("executionAvailable", false)
                .put("operationId", b.getString("operationId"))
                .put("revision", b.getInt("revision"))
                .put("quotedAtMs", 100000)
                .put("expiresAtMs", 145000)
            if (path == "/native/payout/preview") {
              previews++
              check(b.getString("leg") == "invest")
              out
                .put("assumption", "indicative-unfunded-confidential-route")
                .put("profileChainId", 4663)
                .put("leg", "invest")
                .put("recipient", b.getString("recipient"))
                .put("amountAtoms", b.getString("amountAtoms"))
                .put("minimumOutputAtoms", "880000")
                .put("estimatedOutputAtoms", "880000")
                .put("referenceHash", "0x" + "1".repeat(64))
                .put("feePolicy", JSONObject())
            } else {
              check(
                path == "/robinhood/deposit-preview" &&
                  b.getString("startingUsdgAtoms") == if (investArrived) "880000" else "0"
              )
              out
                .put("assumption", "hypothetical-USDG-funding-isolated-fork")
                .put("profileId", "robinhood-usdg")
                .put("chainId", 4663)
                .put("owner", b.getString("owner"))
                .put("token", HOOD_EARN_USDG)
                .put("vault", HOOD_EARN_VAULT)
                .put("expectedUsdgAtoms", b.getString("expectedUsdgAtoms"))
                .put("startingUsdgAtoms", if (investArrived) "880000" else "0")
                .put("policyVersion", "robinhood-v1")
                .put("depositAmount", "850000")
                .put("depositFeeBudget", "15000")
                .put("withdrawalReserve", "15000")
                .put("previewShares", "850000")
                .put("maxSharePrice", "1000000000000000000000000000")
                .put("shareDecimals", 18)
            }
            out.toString()
          },
          { 100000 },
          { 4 },
        )
      val refresh =
        EarnDepositRemaining(
          j,
          gateway,
          { DepositRemainingSource(source, "990000") },
          { childId ->
            if (childId == "paid_hold") paid
            else
              reconcileDepositPayoutBeforeReview(pending) {
                authenticatedReads++
                JSONObject(it.toString()).put("status", "paid")
              }
          },
          { it.getString("receivedAtoms") },
          { original.getJSONObject("reservation") },
          { error("No deposit reference") },
          { 100000 },
        )
      val next = refresh.refresh(r, id, j.get(id).getInt("revision"))
      assertEquals("paused", next.getString("phase"))
      assertEquals(if (investArrived) 0 else 1, previews)
      assertEquals(if (investArrived) 1 else 0, authenticatedReads)
      assertEquals("paid_hold", next.getJSONObject("children").getJSONArray("hold").getString(0))
      assertEquals(
        "immutable",
        next
          .getJSONObject("review")
          .getJSONArray("fundingRows")
          .getJSONObject(0)
          .getString("signedUserOperation"),
      )
      val d = next.getJSONObject("review").getJSONObject("deposit")
      assertEquals("18750", d.getString("maximumFeeAtoms")) // 25% gas headroom.
      assertEquals("842500", d.getString("minimumAssetsAtoms"))
      assertEquals(100000, next.getJSONObject("review").getInt("quotedAtMs"))
      EarnDepositApproval.fromRemainingReview(r, next.getJSONObject("review"), 100000)
        .approveAfterPasskey(100001)
    }
  }
}
