package io.gizu.storedwallet

import io.gizu.storedwallet.portfolio.PortfolioRpc
import io.gizu.storedwallet.swap.MainnetPortfolio
import io.gizu.storedwallet.swap.mainnetUsdcBalanceSync
import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MainnetPortfolioInvalidationTest {
  private class File : WalletFile {
    var bytes: ByteArray? = null

    override fun exists() = bytes != null

    override fun read() = bytes!!.copyOf()

    override fun write(bytes: ByteArray) {
      this.bytes = bytes.copyOf()
    }
  }

  private class Rpc : PortfolioRpc {
    var balance = "0"
    var balanceReads = 0
    var fail = false

    override suspend fun call(method: String, params: JSONArray): Any {
      check(!fail)
      return when (method) {
        "eth_chainId" -> "0x8f"
        "eth_getBlockByNumber" ->
          JSONObject()
            .put("number", if (params.getString(0) == "finalized") "0x64" else params.getString(0))
            .put("hash", "0x" + "a".repeat(64))
        "eth_getLogs" -> JSONArray()
        "eth_call" -> {
          check(params.getJSONObject(0).getString("to").equals(MainnetPortfolio.USDC, true))
          balanceReads++
          "0x" + balance.toBigInteger().toString(16).padStart(64, '0')
        }
        else -> error(method)
      }
    }
  }

  @Test
  fun paidCashoutInvalidationRefreshesRecentlyCachedZeroReceiverAfterRestart() = runBlocking {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val rpc = Rpc()
    val owner = "0x" + "1".repeat(40)
    fun sync() = mainnetUsdcBalanceSync(file, { key }, "actual-wallet-id", rpc)
    val before = sync().read(listOf(owner), 100_000)
    assertTrue(before.complete)
    assertEquals("0", before.balances[owner])
    rpc.balance = "990000"
    assertEquals("0", sync().read(listOf(owner), 100_001).balances[owner])
    assertEquals(1, rpc.balanceReads)
    // The production callback uses this same wallet/chain/token/AAD/decoder factory.
    sync().invalidate()
    val dirty = sync().cachedSnapshot(listOf(owner), 100_002)!!
    assertFalse(dirty.complete)
    assertTrue(dirty.stale)
    assertTrue(dirty.syncPending)
    val received = sync().read(listOf(owner), 100_003)
    assertEquals("990000", received.balances[owner])
    assertEquals(2, rpc.balanceReads)
    assertTrue(received.complete)
  }

  @Test
  fun invalidatedReceiverFailureRetainsObservedValueWithoutClaimingFreshZero() = runBlocking {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val rpc = Rpc()
    val owner = "0x" + "1".repeat(40)
    val sync = mainnetUsdcBalanceSync(file, { key }, "actual-wallet-id", rpc)
    sync.read(listOf(owner), 100_000)
    sync.invalidate()
    rpc.fail = true
    val unavailable = sync.read(listOf(owner), 100_001)
    assertEquals("0", unavailable.balances[owner])
    assertFalse(unavailable.complete)
    assertTrue(unavailable.stale)
    assertTrue(unavailable.syncPending)
  }
}
