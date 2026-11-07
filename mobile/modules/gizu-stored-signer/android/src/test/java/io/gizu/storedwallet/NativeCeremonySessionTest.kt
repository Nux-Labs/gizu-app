package io.gizu.storedwallet

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NativeCeremonySessionTest {
  @Test
  fun slowPreparationStillAllowsAFullMinuteToReadBeforeContinuing() = runTest {
    val session = NativeCeremonySession(120_000)
    val decision = CompletableDeferred<Unit>()
    var visible = false
    val operation = async {
      session.run {
        delay(117_000)
        session.review {
          visible = true
          decision.await()
        }
        "reviewed"
      }
    }
    advanceTimeBy(117_000)
    runCurrent()
    assertTrue(visible)
    advanceTimeBy(60_000)
    runCurrent()
    assertTrue("Network preparation consumed the reading window", operation.isActive)
    decision.complete(Unit)
    assertEquals("reviewed", operation.await())
  }

  @Test
  fun reviewTimeoutStartsWhenShownAndRemainsBoundedAtFiveMinutes() = runTest {
    val session = NativeCeremonySession(120_000)
    val operation = async {
      session.run {
        delay(117_000)
        session.review { awaitCancellation() }
      }
    }
    advanceTimeBy(117_000)
    runCurrent()
    advanceTimeBy(299_999)
    runCurrent()
    assertTrue(operation.isActive)
    advanceTimeBy(1)
    runCurrent()
    assertTrue(operation.isCancelled)
    try {
      operation.await()
      fail("Expired review continued")
    } catch (failure: NativeCeremonyTimeout) {
      assertTrue(failure.reviewExpired)
    }
  }

  @Test
  fun workWithoutAReviewStillTimesOut() = runTest {
    val session = NativeCeremonySession(120_000)
    val operation = async { session.run { awaitCancellation() } }
    runCurrent()
    advanceTimeBy(119_999)
    runCurrent()
    assertTrue(operation.isActive)
    advanceTimeBy(1)
    runCurrent()
    assertTrue(operation.isCancelled)
  }

  @Test
  fun continuingAfterReadingGrantsAFreshBoundedWorkWindow() = runTest {
    val session = NativeCeremonySession(120_000)
    val decision = CompletableDeferred<Unit>()
    val operation = async {
      session.run {
        delay(119_000)
        session.review { decision.await() }
        delay(119_000)
        "finished"
      }
    }
    advanceTimeBy(119_000)
    runCurrent()
    advanceTimeBy(70_000)
    runCurrent()
    assertTrue(operation.isActive)
    decision.complete(Unit)
    runCurrent()
    advanceTimeBy(119_000)
    runCurrent()
    assertEquals("finished", operation.await())
  }

  @Test
  fun callerCancellationImmediatelyClosesReviewAndCannotContinueWork() = runTest {
    val session = NativeCeremonySession(120_000)
    var closed = false
    var continued = false
    val operation = async {
      session.run {
        session.review {
          try {
            awaitCancellation()
          } finally {
            closed = true
          }
        }
        continued = true
      }
    }
    runCurrent()
    operation.cancel()
    runCurrent()
    assertTrue(closed)
    assertFalse(continued)
    assertTrue(operation.isCancelled)
  }
}
