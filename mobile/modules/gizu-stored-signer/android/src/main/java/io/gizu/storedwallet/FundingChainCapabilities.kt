package io.gizu.storedwallet

import org.json.JSONObject

/** Only an explicit legacy 404 admits Monad without a v2 service declaration. */
internal fun enabledFundingChains(status: Int, body: String): List<Int> {
  if (status == 404) return listOf(143)
  require(status == 200) { "Funding availability could not be checked" }
  val root = JSONObject(body)
  require(root.get("fundingContractVersion") == 2)
  val values = root.getJSONArray("fundingChainIds")
  require(values.length() in 1..3)
  val chains =
    (0 until values.length()).map { index ->
      val value = values.get(index)
      require(value is Int && value in setOf(143, 8453, 42161))
      value
    }
  require(chains.distinct().size == chains.size)
  return chains
}

/** Funding origins alone never qualify the separate Ethereum private-funded payout boundary. */
internal fun qualifiedEthereumPrivateFunding(status: Int, body: String): Boolean =
  try {
    if (status != 200) false
    else {
      enabledFundingChains(status, body)
      val root = JSONObject(body)
      val profiles = root.optJSONArray("earnPrivateFundingProfileChainIds")
      root.opt("earnPrivateFundingVersion") == 2 &&
        profiles != null &&
        profiles.length() == 1 &&
        profiles.get(0) is Int &&
        profiles.getInt(0) == 1
    }
  } catch (_: Exception) {
    false
  }
