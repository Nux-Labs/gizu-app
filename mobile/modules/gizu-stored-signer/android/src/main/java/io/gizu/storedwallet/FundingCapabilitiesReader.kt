package io.gizu.storedwallet

import kotlinx.coroutines.withTimeoutOrNull

/** One bounded native TLS read per new plan. Recovery never calls this admission gate. */
internal suspend fun enabledFundingChains(): List<Int> =
  withTimeoutOrNull(3_000L) {
    val endpoint = EARN_NATIVE_BACKEND.removeSuffix("/earn/native") + "/funding/capabilities"
    val (status, body) = NativeRpcTransport(endpoint).execute("GET", endpoint, null)
    enabledFundingChains(status, body)
  } ?: error("Funding availability could not be checked")

/** New profile-1 funding and new signatures fail closed; saved signed work uses recovery paths. */
internal suspend fun requireEthereumPrivateFundingAvailable() {
  val qualified =
    withTimeoutOrNull(3_000L) {
      val endpoint = EARN_NATIVE_BACKEND.removeSuffix("/earn/native") + "/funding/capabilities"
      val (status, body) = NativeRpcTransport(endpoint).execute("GET", endpoint, null)
      qualifiedEthereumPrivateFunding(status, body)
    } ?: false
  check(qualified) {
    "Ethereum private funding is not currently qualified. Resume saved signed work or retry availability later."
  }
}
