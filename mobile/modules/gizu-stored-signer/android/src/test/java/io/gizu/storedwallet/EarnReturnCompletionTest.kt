package io.gizu.storedwallet

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class EarnReturnCompletionTest {
  @Test
  fun publicVaultReadUsesFlatRpcParametersAndPreservesNonzeroHoldings() = runBlocking {
    val owner = "0x" + "1".repeat(40)
    var shares = "0"
    val rpc =
      object : TransferRpc {
        override suspend fun call(method: String, params: JSONArray): Any {
          assertEquals("eth_call", method)
          assertEquals(2, params.length())
          val call = params.getJSONObject(0)
          assertEquals(HOOD_EARN_VAULT, call.getString("to"))
          assertEquals("0x70a08231" + "0".repeat(24) + "1".repeat(40), call.getString("data"))
          assertEquals("latest", params.getString(1))
          return "0x" + shares.padStart(64, '0')
        }
      }
    val expected = JSONObject().put("sourceOwner", owner)
    assertTrue(readReturnVaultEmpty(expected, rpc))
    shares = "1"
    assertFalse(readReturnVaultEmpty(expected, rpc))
    Unit
  }
}
