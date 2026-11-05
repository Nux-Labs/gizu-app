package io.gizu.storedwallet

/** Memory-only bounded read consent; background, lock, cancellation and destruction revoke it. */
internal class WalletDiscoveryConsent {
  private var wallet: String? = null
  private var generation: String? = null
  private var bound = -1
  private var approvedAt = 0L

  fun permits(wallet: String, generation: String, through: Int, now: Long): Boolean =
    this.wallet == wallet &&
      this.generation == generation &&
      through in 0..bound &&
      now - approvedAt in 0 until 900_000L

  fun approve(wallet: String, generation: String, through: Int, now: Long) {
    require(through in 0..1_000_000)
    this.wallet = wallet
    this.generation = generation
    bound = through
    approvedAt = now
  }

  fun clear() {
    wallet = null
    generation = null
    bound = -1
    approvedAt = 0
  }
}
