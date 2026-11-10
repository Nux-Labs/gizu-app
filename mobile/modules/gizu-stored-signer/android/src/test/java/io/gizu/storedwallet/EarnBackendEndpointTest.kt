package io.gizu.storedwallet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class EarnBackendEndpointTest {
  private val hosted = "https://api.gizu.io/v1/earn/native"

  @Test
  fun onlyExplicitUsbDebugBuildUsesLoopback() {
    assertEquals("http://127.0.0.1:3000/v1/earn/native", selectEarnBackendEndpoint(true, "usb"))
    assertEquals(hosted, selectEarnBackendEndpoint(true, "hosted"))
  }

  @Test
  fun releaseAlwaysUsesHostedTlsEvenIfUsbModeIsPassed() {
    assertEquals(hosted, selectEarnBackendEndpoint(false, "usb"))
    assertEquals(hosted, selectEarnBackendEndpoint(false, "hosted"))
  }

  @Test
  fun unknownModesAndArbitraryUrlsCannotSelectEndpoints() {
    for (debug in listOf(true, false)) for (mode in
      listOf("", "USB", "http://evil.test", "https://evil.test")) {
      assertThrows(IllegalArgumentException::class.java) { selectEarnBackendEndpoint(debug, mode) }
    }
  }

  @Test
  fun generatedVariantAndPrivateBalanceUseTheSamePinnedBackend() {
    val selected = selectEarnBackendEndpoint(BuildConfig.DEBUG, BuildConfig.GIZU_EARN_BACKEND_MODE)
    assertEquals(selected, EARN_NATIVE_BACKEND)
    assertEquals(
      selected.removeSuffix("/native") + "/private-balance",
      EARN_PRIVATE_BALANCE_BACKEND,
    )
  }
}
