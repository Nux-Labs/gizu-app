package io.gizu.storedwallet

import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivateUsdcReadTest {
  @Test
  fun lockObservationMustStartBeforeRetainedReadAccessIsGranted() {
    var screenOff: (() -> Unit)? = null
    lateinit var read: PrivateUsdcRead
    read = PrivateUsdcRead {
      assertFalse(read.allows("wallet", "generation"))
      screenOff = { read.onSystemEvent("android.intent.action.SCREEN_OFF") }
    }
    read.grant("wallet", "generation")
    assertTrue(read.allows("wallet", "generation"))
    // Switch away, lock and unlock before returning: foreground device state alone is insufficient.
    read.onDeviceState(interactive = true, locked = false)
    checkNotNull(screenOff).invoke()
    read.onDeviceState(interactive = true, locked = false)
    assertFalse(read.allows("wallet", "generation"))
  }

  @Test
  fun failedLockObservationCannotGrantReadAccess() {
    val read = PrivateUsdcRead { error("Device lock observer unavailable") }
    assertThrows(IllegalStateException::class.java) { read.grant("wallet", "generation") }
    assertFalse(read.allows("wallet", "generation"))
  }

  @Test
  fun aPrivateBalanceReadStaysOpenUntilExplicitlyCleared() {
    val read = PrivateUsdcRead {}
    assertFalse(read.allows("wallet", "generation"))
    read.grant("wallet", "generation")
    assertTrue(read.allows("wallet", "generation"))
    assertFalse(read.allows("other", "generation"))
    assertFalse(read.allows("wallet", "other-generation"))
    read.clear()
    assertFalse(read.allows("wallet", "generation"))
  }

  @Test
  fun switchingAppsRetainsReadsWhileSpendingIsRevoked() {
    val read = PrivateUsdcRead {}
    read.grant("wallet", "generation")
    var spendingRevoked = false
    val spending = EarnDepositLifecycle { spendingRevoked = true }
    read.onDeviceState(interactive = true, locked = false)
    read.onSystemEvent("android.intent.action.CLOSE_SYSTEM_DIALOGS")
    spending.onUserLeave(false)
    spending.onBackground(false, true, false)
    assertTrue(read.allows("wallet", "generation"))
    assertTrue(spendingRevoked)
  }

  @Test
  fun screenLockAndRestartRequireANewReadGrant() {
    val read = PrivateUsdcRead {}
    read.grant("wallet", "generation")
    read.onSystemEvent("android.intent.action.SCREEN_OFF")
    assertFalse(read.allows("wallet", "generation"))
    read.grant("wallet", "generation")
    read.onDeviceState(interactive = true, locked = true)
    assertFalse(read.allows("wallet", "generation"))
    read.grant("wallet", "generation")
    read.onDeviceState(interactive = false, locked = false)
    assertFalse(read.allows("wallet", "generation"))
    read.grant("wallet", "generation")
    assertFalse(PrivateUsdcRead {}.allows("wallet", "generation"))
  }
}
