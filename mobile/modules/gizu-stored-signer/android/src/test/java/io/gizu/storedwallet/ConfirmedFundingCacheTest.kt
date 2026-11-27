package io.gizu.storedwallet

import io.gizu.storedwallet.portfolio.*
import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConfirmedFundingCacheTest {
  private class File : WalletFile {
    var bytes: ByteArray? = null

    override fun exists() = bytes != null

    override fun read() = bytes!!.copyOf()

    override fun write(bytes: ByteArray) {
      this.bytes = bytes.copyOf()
    }
  }

  private class Rpc(val chain: Int, val token: String) : PortfolioRpc {
    var failed = false
    val amounts = mutableMapOf<String, String>()

    override suspend fun call(method: String, params: JSONArray): Any {
      check(!failed)
      return when (method) {
        "eth_chainId" -> "0x" + chain.toString(16)
        "eth_getBlockByNumber" ->
          JSONObject().put("number", "0x64").put("hash", "0x" + "a".repeat(64))
        "eth_getLogs" -> JSONArray()
        "eth_call" -> {
          val call = params.getJSONObject(0)
          check(call.getString("to") == token)
          "0x" +
            amounts
              .getValue("0x" + call.getString("data").takeLast(40))
              .toBigInteger()
              .toString(16)
              .padStart(64, '0')
        }
        else -> error(method)
      }
    }
  }

  private val owner = "0x" + "1".repeat(40)
  private val returned = "0x" + "3".repeat(40)
  private val token = "0x754704bc059f8c67012fed69bc8a327a5aafb603"

  private fun key() = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

  @Test
  fun confirmedCreditDropsOnlyItsPreCreditSourceObservationAcrossRestart() = runBlocking {
    val file = File()
    val key = key()
    val rpc =
      Rpc(143, token).apply {
        amounts[owner] = "10000000"
        amounts[returned] = "25000000"
      }
    fun sync() = TokenBalanceSync(file, { key }, "wallet", 143, token, rpc)
    sync().read(listOf(owner, returned), 100_000)
    sync().invalidateConfirmedFunding(owner.uppercase().replace("0X", "0x"))
    rpc.failed = true
    val failed = sync().read(listOf(owner, returned), 100_001)
    assertNull(failed.balances[owner])
    assertEquals("25000000", failed.balances[returned])
    assertFalse(failed.complete)
    val observations =
      listOf(
        FundingObservation(
          143,
          1,
          owner,
          failed.balances[owner],
          failed.checkedAt,
          failed.complete,
          failed.stale,
          failed.syncPending,
        ),
        FundingObservation(
          143,
          3,
          returned,
          failed.balances[returned],
          failed.checkedAt,
          failed.complete,
          failed.stale,
          failed.syncPending,
        ),
        FundingObservation(8453, 1, owner, "0", 100_001, true, false, false),
        FundingObservation(42161, 1, owner, "0", 100_001, true, false, false),
      )
    val cash = fundingPortfolio(observations)["fundingCash"] as Map<*, *>
    assertEquals("25000000", cash["observedAtoms"])
    assertEquals(
      "34900000",
      (cash["observedAtoms"].toString().toBigInteger() + "9900000".toBigInteger()).toString(),
    )
    assertNull(cash["availableAtoms"])
    rpc.failed = false
    rpc.amounts[owner] = "0"
    val fresh = sync().read(listOf(owner, returned), 100_002)
    assertEquals("0", fresh.balances[owner])
    assertTrue(fresh.complete)
  }

  @Test
  fun ordinaryInvalidationStillRetainsStaleSourceCash() = runBlocking {
    val file = File()
    val key = key()
    val rpc = Rpc(143, token).apply { amounts[owner] = "10000000" }
    val sync = TokenBalanceSync(file, { key }, "wallet", 143, token, rpc)
    sync.read(listOf(owner), 100_000)
    sync.invalidate()
    rpc.failed = true
    assertEquals("10000000", sync.read(listOf(owner), 100_001).balances[owner])
  }
}
