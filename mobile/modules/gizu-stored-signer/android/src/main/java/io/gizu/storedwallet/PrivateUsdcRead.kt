package io.gizu.storedwallet

/**
 * Shared balance-only grant for this process. App switching retains it; screen/wallet lock,
 * sign-out and process restart revoke it. It grants no spending authority.
 */
internal class PrivateUsdcRead(private val observeDeviceLock: () -> Unit) {
  private var wallet: String? = null
  private var generation: String? = null
  @Volatile private var open = false

  @Synchronized
  fun grant(wallet: String, generation: String) {
    observeDeviceLock()
    this.wallet = wallet
    this.generation = generation
    open = true
  }

  @Synchronized
  fun clear() {
    open = false
  }

  fun onSystemEvent(action: String?) {
    if (action == "android.intent.action.SCREEN_OFF") clear()
  }

  fun onDeviceState(interactive: Boolean, locked: Boolean) {
    if (!interactive || locked) clear()
  }

  @Synchronized
  fun allows(wallet: String, generation: String) =
    open && this.wallet == wallet && this.generation == generation
}
