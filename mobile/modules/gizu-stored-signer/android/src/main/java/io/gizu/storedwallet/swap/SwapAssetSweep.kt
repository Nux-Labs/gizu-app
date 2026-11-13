package io.gizu.storedwallet.swap

import java.math.BigInteger

/**
 * Recovery sweep for the swap asset ledger: checks every swap-listed catalogue token against the
 * wallet's own swap recipients and reports the tokens any of them holds. Balance based, so it needs
 * no transfer history (public RPCs cap log ranges far below a chain's lifetime). Read-only; tokens
 * outside the catalogue, such as unsolicited airdrops, are never discovered.
 */
internal class SwapAssetSweep(
  chain: SwapChain,
  private val multicall: SwapMulticall = SwapMulticall(chain),
) {
  suspend fun held(tokens: List<String>, holders: List<String>): List<String> {
    val candidates = tokens.map(String::lowercase).distinct()
    candidates.forEach { require(it.matches(ADDRESS)) }
    require(candidates.size <= MAX_TOKENS && candidates.size.toLong() * holders.size <= MAX_CALLS)
    if (candidates.isEmpty() || holders.isEmpty()) return emptyList()
    val block = multicall.head()
    val calls = candidates.flatMap { token -> holders.map { SwapMulticall.balanceOf(token, it) } }
    val results = multicall.call(calls, block)
    return candidates.filterIndexed { index, _ ->
      results.subList(index * holders.size, (index + 1) * holders.size).any {
        it.success && positive(it.data)
      }
    }
  }

  companion object {
    const val MAX_TOKENS = 4096
    const val MAX_CALLS = 40_000L
    private val ADDRESS = Regex("0x[0-9a-f]{40}")

    /** A non-standard or reverted `balanceOf` is not evidence of a holding. */
    internal fun positive(data: String): Boolean =
      data.matches(Regex("0x[0-9a-fA-F]{64}")) && BigInteger(data.substring(2), 16).signum() > 0
  }
}
