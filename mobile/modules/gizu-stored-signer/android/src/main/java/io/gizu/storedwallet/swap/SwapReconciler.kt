package io.gizu.storedwallet.swap

import io.gizu.storedwallet.NativeRpcTransport
import org.json.JSONArray
import org.json.JSONObject
import uniffi.gizu_stored_signer_core.deriveAccountAddressRange
import uniffi.gizu_stored_signer_core.mergeRoleRegistries
import uniffi.gizu_stored_signer_core.roleRegistryCovering
import uniffi.gizu_stored_signer_core.roleRegistryInitial

internal object SwapReconciler {
  /** The stablecoin each swap chain pays recipients in: Robinhood USDG and Base USDC. */
  private val PAYOUTS =
    listOf(
      SwapChains.ROBINHOOD.rpc to "5fc5360d0400a0fd4f2af552add042d716f1d168",
      SwapChains.BASE.rpc to "833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    )
  private const val GAP_LIMIT = 6
  private const val SCAN_LIMIT = 48

  /**
   * Finds spent recipient indices from public payout-stablecoin balances on every swap chain and
   * refuses to move the registry backward.
   */
  suspend fun covering(entropy: ByteArray, backupRegistry: String): String {
    val transports = PAYOUTS.map { (rpc, token) -> NativeRpcTransport(rpc) to token }
    var highest = 2
    var gap = 0
    var index = 3
    while (gap < GAP_LIMIT && index < 3 + SCAN_LIMIT) {
      val address =
        deriveAccountAddressRange(entropy, index.toUInt(), 1u).single().removePrefix("0x")
      val data = "0x70a08231" + "0".repeat(24) + address.lowercase()
      val held =
        transports.any { (transport, token) ->
          val body =
            JSONObject()
              .put("jsonrpc", "2.0")
              .put("id", 1)
              .put("method", "eth_call")
              .put(
                "params",
                JSONArray().put(JSONObject().put("to", "0x$token").put("data", data)).put("latest"),
              )
              .toString()
          val response = JSONObject(transport.post(body))
          response.getString("result").removePrefix("0x").trimStart('0').isNotEmpty()
        }
      if (held) {
        highest = index
        gap = 0
      } else gap++
      index++
    }
    val scanned = if (highest < 3) roleRegistryInitial() else roleRegistryCovering(highest.toUInt())
    return mergeRoleRegistries(backupRegistry, scanned)
  }
}
