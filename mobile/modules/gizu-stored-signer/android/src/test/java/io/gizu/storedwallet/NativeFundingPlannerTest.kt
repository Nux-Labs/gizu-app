package io.gizu.storedwallet

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeFundingPlannerTest {
  @Test
  fun fundingChecksAccount1AndSkipsAccount0() {
    assertFalse(fundingCandidate(0))
    assertTrue(fundingCandidate(1))
    assertTrue(fundingCandidate(3))
  }
}
