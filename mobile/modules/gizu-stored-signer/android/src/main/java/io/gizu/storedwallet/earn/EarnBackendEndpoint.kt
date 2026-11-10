package io.gizu.storedwallet

/** Build-time native policy only; neither Expo nor backend responses select a URL. */
internal fun selectEarnBackendEndpoint(debug: Boolean, mode: String): String {
  require(mode in setOf("hosted", "usb")) { "Unsupported Earn backend build mode" }
  return if (debug && mode == "usb") "http://127.0.0.1:3000/v1/earn/native"
  else "https://api.gizu.io/v1/earn/native"
}

internal val EARN_NATIVE_BACKEND =
  selectEarnBackendEndpoint(BuildConfig.DEBUG, BuildConfig.GIZU_EARN_BACKEND_MODE)
internal val EARN_PRIVATE_BALANCE_BACKEND =
  EARN_NATIVE_BACKEND.removeSuffix("/native") + "/private-balance"
