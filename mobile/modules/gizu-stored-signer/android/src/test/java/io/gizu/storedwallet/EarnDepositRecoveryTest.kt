package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnDepositRecoveryTest {
  @Test
  fun missingUnsignedPrivateReviewRecoversToDraftWithoutClaimingSavedTransactions() {
    DepositFixtures.record().use { r ->
      for (childAttached in listOf(false, true)) {
        val j = testDepositJournal()
        val id = j.loadOrCreate(r, 4663, null).getString("journeyId")
        j.saveReview(id, 1, DepositFixtures.review(r).put("journeyId", id))
        if (childAttached) j.attachChild(id, j.get(id).getInt("revision"), "funding", "source0")
        j.update(id, j.get(id).getInt("revision")) {
          it.remove("review")
          it
            .put("phase", "paused")
            .put("pauseReason", "cancelled")
            .put("creditedAtoms", "990000")
            .put("completedSteps", JSONArray(listOf("funding", "credit")))
        }
        val repaired = j.recoverMissingReview(id)
        assertEquals(if (childAttached) "paused" else "draft", repaired.getString("phase"))
        assertEquals(if (childAttached) "990000" else "0", repaired.getString("creditedAtoms"))
        assertEquals(if (childAttached) 2 else 0, repaired.getJSONArray("completedSteps").length())
        if (childAttached) {
          assertEquals("recoveryRequired", repaired.getString("pauseReason"))
          assertEquals(
            "source0",
            repaired.getJSONObject("children").getJSONArray("funding").getString(0),
          )
        }
      }
    }
  }

  private fun ledger() =
    FundingReservations(
      DepositMemoryFile(),
      { key },
      DepositFixtures.wallet,
      DepositFixtures.wallet,
    ) {
      1000L
    }

  private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

  private fun reserve(l: FundingReservations, r: WalletRecord, batch: String) {
    val p = DepositFixtures.funding(r).getJSONObject("proposal")
    l.reserveBatch(
      batch,
      "earn",
      r.earnCycleIndex,
      JSONArray()
        .put(
          JSONObject()
            .put("sourceIndex", 0)
            .put("address", p.getString("expectedFrom"))
            .put("budgetAtoms", "1010000")
            .put("balanceAtoms", "1010000")
        ),
    )
    l.bind(batch, p.getString("expectedFrom"), "source0", "1010000")
    l.commitBatch(batch)
  }

  @Test
  fun unsignedCancelReleasesSourceLocksButStartedChildrenStayReserved() {
    DepositFixtures.record().use { r ->
      for (started in listOf(false, true)) {
        val j = testDepositJournal()
        val id = j.loadOrCreate(r, 4663, null).getString("journeyId")
        val l = ledger()
        val review = DepositFixtures.review(r).put("journeyId", id)
        val batch = review.getJSONObject("reservation").getString("id")
        reserve(l, r, batch)
        j.saveReview(id, 1, review)
        if (started) {
          j.attachChild(id, 2, "funding", "source0")
          l.markSigned("source0")
        }
        val result = j.cancelUnsignedReview(id) { l.cancelBatchUnsigned(it) }
        val owner = DepositFixtures.funding(r).getJSONObject("proposal").getString("expectedFrom")
        assertEquals(if (started) "1010000" else "0", l.reservedAtoms(owner))
        assertEquals(started, result.has("review"))
        if (!started) assertEquals("draft", result.getString("phase"))
      }
    }
  }

  @Test
  fun crashAfterBindingBeforeReviewIsReleasedBeforeTheNextSelection() = runBlocking {
    DepositFixtures.record().use { r ->
      val file = DepositMemoryFile()
      val j = EarnDepositJournal(file, { key }, r.id, r.journalId)
      val id = j.loadOrCreate(r, 4663, null).getString("journeyId")
      j.update(id, 1) { it.put("phase", "preparing") }
      j.bindPreparationReservation(id, j.get(id).getInt("revision"), "interrupted_batch")
      val l = ledger()
      reserve(l, r, "interrupted_batch")
      // Process dies here: no returned draft and no final review to drive a catch block.
      val restarted = EarnDepositJournal(file, { key }, r.id, r.journalId)
      var selectionSawAvailableFunds = false
      val preparer =
        EarnDepositPreparer(
          restarted,
          EarnDepositGateway({ _, _ -> error("No provider needed") }),
          { _, _ ->
            val owner =
              DepositFixtures.funding(r).getJSONObject("proposal").getString("expectedFrom")
            selectionSawAvailableFunds = l.reservedAtoms(owner) == "0"
            error("Stop after source availability check")
          },
          { v -> l.cancelBatchUnsigned(v.getJSONObject("reservation").getString("id")) },
        )
      preparer.prepare(r, 4663, "1010000", id)
      assertTrue(selectionSawAvailableFunds)
      assertFalse(restarted.get(id).has("preparationBatchId"))
    }
  }

  @Test
  fun readonlyReconciliationRequiresTheCurrentLoginAndNeverRenewsIt() {
    DepositFixtures.record().use { r ->
      requireDepositReadPermission(r, r.id, r.journalId, 121000, 1001)
      for (now in listOf(999L, 121000L)) assertThrows(IllegalStateException::class.java) {
        requireDepositReadPermission(r, r.id, r.journalId, 121000, now)
      }
      assertThrows(IllegalStateException::class.java) {
        requireDepositReadPermission(r, "another-wallet", r.journalId, 121000, 1001)
      }
      assertThrows(IllegalStateException::class.java) {
        requireDepositReadPermission(r, r.id, "another-generation", 121000, 1001)
      }
    }
  }
}
