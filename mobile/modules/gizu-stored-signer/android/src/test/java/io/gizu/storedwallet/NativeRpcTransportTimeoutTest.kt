package io.gizu.storedwallet

import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Test

class NativeRpcTransportTimeoutTest {
  private fun client(endpoint: String): OkHttpClient {
    val field = NativeRpcTransport::class.java.getDeclaredField("client")
    field.isAccessible = true
    return field.get(NativeRpcTransport(endpoint)) as OkHttpClient
  }

  @Test
  fun onlyExactReadOnlyGroupStatusEndpointsHaveWholeGroupVerificationBudget() {
    for (path in listOf("cashout/group-status", "payout/group-status")) {
      val configured = client("$EARN_NATIVE_BACKEND/$path")
      assertEquals(180000, configured.readTimeoutMillis)
      assertEquals(190000, configured.callTimeoutMillis)
    }
    for (path in listOf("payout/submit", "payout/group-status-other", "cashout/group-prepare")) {
      assertEquals(30000, client("$EARN_NATIVE_BACKEND/$path").callTimeoutMillis)
    }
  }
}
