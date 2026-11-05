package io.gizu.storedwallet

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class EarnDepositHostTest {
  @Test
  fun pendingCreditShowsLiveProgressAndContinuesWithinTheOriginalApproval() = runBlocking {
    DepositFixtures.record().use { record ->
      val journal = testDepositJournal()
      val id = journal.loadOrCreate(record, 4663, null).getString("journeyId")
      journal.saveReview(id, 1, DepositFixtures.review(record).put("journeyId", id))
      val engines = EarnDepositCoordinatorTest.Engines(record)
      val waiting = CompletableDeferred<Unit>()
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
      var approvals = 0
      val host =
        EarnDepositHost(
          scope,
          journal,
          { DepositFixtures.record() },
          { EarnDepositCoordinator(journal, engines) },
          { _, _, _ -> approvals++ },
          {},
          now = { 1002 },
          wait = { waiting.await() },
        )
      try {
        host.confirm(id, 2, false)
        assertEquals("settlingCredit", host.status(id)["phase"])
        assertNull(host.status(id)["pauseReason"])
        assertTrue(host.busy)
        assertEquals(0, engines.payoutCreates)
        engines.creditReady = true
        waiting.complete(Unit)
        assertEquals("invested", host.status(id)["phase"])
        assertEquals(1, approvals)
        assertEquals(4, engines.signed)
      } finally {
        scope.cancel()
      }
    }
  }

  @Test
  fun pendingPayoutKeepsProgressUntilTheSavedReceiptIsVerified() = runBlocking {
    DepositFixtures.record().use { record ->
      val journal = testDepositJournal()
      val id = journal.loadOrCreate(record, 4663, null).getString("journeyId")
      journal.saveReview(id, 1, DepositFixtures.review(record).put("journeyId", id))
      val engines =
        EarnDepositCoordinatorTest.Engines(record).apply {
          creditReady = true
          investUnknown = true
        }
      val waiting = CompletableDeferred<Unit>()
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
      var approvals = 0
      val host =
        EarnDepositHost(
          scope,
          journal,
          { DepositFixtures.record() },
          { EarnDepositCoordinator(journal, engines) },
          { _, _, _ -> approvals++ },
          {},
          now = { 1002 },
          wait = { waiting.await() },
        )
      try {
        host.confirm(id, 2, false)
        assertEquals("payouts", host.status(id)["phase"])
        assertNull(host.status(id)["pauseReason"])
        assertEquals(3, engines.signed)
        assertEquals(0, engines.depositCreates)
        engines.rows.getValue("payout-source0-invest").put("status", "paid")
        waiting.complete(Unit)
        assertEquals("invested", host.status(id)["phase"])
        assertEquals(1, approvals)
        assertEquals(0, engines.savedPayoutRetries)
        assertEquals(4, engines.signed)
      } finally {
        scope.cancel()
      }
    }
  }

  @Test
  fun screenOffAndHomeDuringCredentialApprovalCannotBeResumedByReturning() = runBlocking {
    for ((event, reason) in
      listOf(
        "android.intent.action.SCREEN_OFF" to null,
        "android.intent.action.CLOSE_SYSTEM_DIALOGS" to "homekey",
        "android.intent.action.CLOSE_SYSTEM_DIALOGS" to "recentapps",
      )) {
      DepositFixtures.record().use { r ->
        val j = testDepositJournal()
        val id = j.loadOrCreate(r, 4663, null).getString("journeyId")
        j.saveReview(id, 1, DepositFixtures.review(r).put("journeyId", id))
        val e = EarnDepositCoordinatorTest.Engines(r)
        val provider = CompletableDeferred<Unit>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val host =
          EarnDepositHost(
            scope,
            j,
            { DepositFixtures.record() },
            { EarnDepositCoordinator(j, e) },
            { _, _, _ -> provider.await() },
            {},
            now = { 1002 },
          )
        val approval = scope.launch { host.confirm(id, 2, false) }
        assertTrue(host.busy)
        host.onBackground(true) // The legitimate provider focus transition alone is allowed.
        assertTrue(host.busy)
        EarnDepositLifecycle { host.revoke("approvalExpired") }.onSystemEvent(event, reason)
        provider.complete(Unit) // Device unlock / return does not restore the canceled ceremony.
        approval.join()
        assertFalse(host.busy)
        assertEquals(0, e.signed)
        assertEquals("approvalExpired", j.publicSnapshot(id)["pauseReason"])
        scope.cancel()
      }
    }
  }

  @Test
  fun journalCapacityIsCheckedBeforeTheFirstSourceCanSpend() {
    DepositFixtures.record().use { r ->
      val review = DepositFixtures.review(r)
      val full = (0 until 255).map { org.json.JSONObject().put("operationId", "older-$it") }
      try {
        requireDepositCapacity(review, full, emptyList())
        fail("No space for funding and deposit")
      } catch (_: IllegalStateException) {}
      val payouts =
        (0 until 255).map {
          org.json
            .JSONObject()
            .put("operationId", "older-payout-$it")
            .put(
              "proposal",
              org.json.JSONObject().put("operationId", "older-source-$it").put("leg", "hold"),
            )
        }
      try {
        requireDepositCapacity(review, emptyList(), payouts)
        fail("No space for both independent payouts")
      } catch (_: IllegalStateException) {}
      requireDepositCapacity(review, full.take(254), payouts.take(254))
      // Settled history spans pages and consumes no active-operation slots.
      val settledSources =
        (0 until 500).map {
          org.json
            .JSONObject()
            .put("operationId", "settled-$it")
            .put("status", "finalized")
            .put("signedUserOperation", "exact-saved-bytes")
        }
      val settledPayouts =
        (0 until 500).map {
          org.json
            .JSONObject()
            .put("operationId", "settled-payout-$it")
            .put("status", "paid")
            .put("signedData", "exact-saved-intent")
            .put(
              "proposal",
              org.json.JSONObject().put("operationId", "settled-source-$it").put("leg", "hold"),
            )
        }
      requireDepositCapacity(review, settledSources, settledPayouts)
      assertFalse(journalEntryPending(org.json.JSONObject().put("phase", "invested")))
      assertFalse(
        journalEntryPending(org.json.JSONObject().put("status", "credited").put("raw", "0x1234"))
      )
      assertFalse(
        journalEntryPending(
          org.json.JSONObject().put("status", "nonceCancelled").put("raw", "0x1234")
        )
      )
      assertTrue(
        journalEntryPending(org.json.JSONObject().put("status", "unknown").put("raw", "0x1234"))
      )
      assertTrue(
        journalEntryPending(org.json.JSONObject().put("status", "expired").put("raw", "0x1234"))
      )
    }
  }

  @Test
  fun expiryRequiresAnotherExplicitApprovalAndWriteFailureCannotKeepAuthorityAlive() = runBlocking {
    DepositFixtures.record().use { record ->
      val file = DepositMemoryFile()
      val j = testDepositJournal(file)
      val id = j.loadOrCreate(record, 4663, null).getString("journeyId")
      j.saveReview(id, 1, DepositFixtures.review(record).put("journeyId", id))
      val e = EarnDepositCoordinatorTest.Engines(record)
      var clock = 1002L
      var approvals = 0
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
      val host =
        EarnDepositHost(
          scope,
          j,
          { DepositFixtures.record() },
          { EarnDepositCoordinator(j, e) },
          { _, _, _ -> approvals++ },
          {},
          now = { clock },
          wait = { clock += 900000 },
        )
      host.confirm(id, 2, false)
      assertEquals(1, approvals)
      assertFalse(host.busy)
      assertEquals("approvalExpired", host.status(id)["pauseReason"])
      e.now = clock
      e.creditReady = true
      host.confirm(id, j.get(id).getInt("revision"), true)
      assertEquals(2, approvals)
      assertEquals("invested", host.status(id)["phase"])
      scope.cancel()
    }
    DepositFixtures.record().use { record ->
      val file = DepositMemoryFile()
      val j = testDepositJournal(file)
      val id = j.loadOrCreate(record, 4663, null).getString("journeyId")
      j.saveReview(id, 1, DepositFixtures.review(record).put("journeyId", id))
      val e = EarnDepositCoordinatorTest.Engines(record)
      val pending = CompletableDeferred<Unit>()
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
      val host =
        EarnDepositHost(
          scope,
          j,
          { DepositFixtures.record() },
          { EarnDepositCoordinator(j, e) },
          { _, _, _ -> },
          {},
          now = { 1002 },
          wait = { pending.await() },
        )
      host.confirm(id, 2, false)
      file.fail = true
      host.onBackground(false)
      assertFalse(host.busy)
      assertEquals(1, e.signed)
      file.fail = false
      assertEquals(1, j.get(id).getJSONObject("children").getJSONArray("funding").length())
      scope.cancel()
    }
  }

  @Test
  fun oneApprovalRunsRealCoordinatorAndNeverPromptsForStatus() = runBlocking {
    DepositFixtures.record().use { record ->
      val journal = testDepositJournal()
      val id = journal.loadOrCreate(record, 4663, null).getString("journeyId")
      journal.saveReview(id, 1, DepositFixtures.review(record).put("journeyId", id))
      val engines = EarnDepositCoordinatorTest.Engines(record).apply { creditReady = true }
      var approvals = 0
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
      val host =
        EarnDepositHost(
          scope,
          journal,
          { DepositFixtures.record() },
          { EarnDepositCoordinator(journal, engines) },
          { _, _, _ -> approvals++ },
          {},
          now = { 1002 },
        )
      assertEquals(0, approvals)
      assertEquals("review", host.status(id)["phase"])
      assertEquals(0, approvals)
      host.confirm(id, 2, false, nowMs = 1000)
      assertEquals(1, approvals)
      assertEquals(4, engines.signed)
      assertEquals("invested", host.status(id)["phase"])
      assertFalse(host.busy)
      host.status(id)
      assertEquals(1, approvals)
      scope.cancel()
    }
  }

  @Test
  fun activeJobAllowsStatusRejectsSecondConfirmAndCancelsAuthorityOnBackground() = runBlocking {
    DepositFixtures.record().use { record ->
      val j = testDepositJournal()
      val id = j.loadOrCreate(record, 4663, null).getString("journeyId")
      j.saveReview(id, 1, DepositFixtures.review(record).put("journeyId", id))
      val e = EarnDepositCoordinatorTest.Engines(record)
      val waiting = CompletableDeferred<Unit>()
      var approvals = 0
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
      val host =
        EarnDepositHost(
          scope,
          j,
          { DepositFixtures.record() },
          { EarnDepositCoordinator(j, e) },
          { _, _, _ -> approvals++ },
          {},
          now = { 1002 },
          wait = { waiting.await() },
        )
      host.confirm(id, 2, false, nowMs = 1000)
      assertTrue(host.busy)
      assertEquals("settlingCredit", host.status(id)["phase"])
      assertNull(host.status(id)["pauseReason"])
      try {
        host.confirm(id, j.get(id).getInt("revision"), false, nowMs = 1000)
        fail("Second confirmation accepted")
      } catch (_: IllegalStateException) {}
      assertEquals(1, approvals)
      host.onBackground(providerActive = false)
      assertFalse(host.busy)
      assertEquals("approvalExpired", host.status(id)["pauseReason"])
      assertEquals(1, e.signed)
      e.creditReady = true
      host.confirm(id, j.get(id).getInt("revision"), true, nowMs = 1000)
      assertEquals(2, approvals)
      assertEquals("invested", host.status(id)["phase"])
      assertEquals(4, e.signed)
      scope.cancel()
    }
  }

  @Test
  fun credentialFocusTransitionIsBoundedButLockDestroyAndUserCancelRevoke() = runBlocking {
    for (action in listOf("lock", "destroy", "cancel")) DepositFixtures.record().use { record ->
      val j = testDepositJournal()
      val id = j.loadOrCreate(record, 4663, null).getString("journeyId")
      j.saveReview(id, 1, DepositFixtures.review(record).put("journeyId", id))
      val e = EarnDepositCoordinatorTest.Engines(record)
      val wait = CompletableDeferred<Unit>()
      var approvals = 0
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
      lateinit var host: EarnDepositHost
      host =
        EarnDepositHost(
          scope,
          j,
          { DepositFixtures.record() },
          { EarnDepositCoordinator(j, e) },
          { _, _, _ ->
            approvals++
            host.onBackground(providerActive = true)
          },
          {},
          now = { 1002 },
          wait = { wait.await() },
        )
      host.confirm(id, 2, false, nowMs = 1000)
      assertEquals(1, approvals)
      assertTrue(host.busy)
      when (action) {
        "cancel" -> host.cancel(id, 2) // An old visible revision still revokes this owned grant.
        "lock" -> host.revoke("approvalExpired")
        "destroy" -> host.close()
      }
      assertFalse(host.busy)
      assertEquals(1, e.signed)
      assertEquals("paused", host.status(id)["phase"])
      assertTrue(j.get(id).getJSONObject("children").length() > 0)
      scope.cancel()
    }
  }
}
