package io.gizu.storedwallet

import io.gizu.storedwallet.portfolio.*
import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SalePortfolioInvalidationTest {
  private class File : WalletFile {
    var bytes: ByteArray? = null

    override fun exists() = bytes != null

    override fun read() = bytes!!.copyOf()

    override fun write(bytes: ByteArray) {
      this.bytes = bytes.copyOf()
    }
  }

  private class Rpc(val chain: Long = 4663) : PortfolioRpc {
    var failed = false
    var amount = "0xa"
    var balanceReads = 0
    val readsByToken = mutableMapOf<String, Int>()

    override suspend fun call(method: String, params: JSONArray): Any {
      check(!failed) { "offline" }
      return when (method) {
        "eth_chainId" -> "0x${chain.toString(16)}"
        "eth_getBlockByNumber" ->
          JSONObject().put("number", "0x64").put("hash", "0x" + "a".repeat(64))
        "eth_getLogs" -> JSONArray()
        "eth_getBalance" -> amount
        "eth_call" -> {
          val request = params.getJSONObject(0)
          val data = request.getString("data")
          if (data.startsWith("0x70a08231")) {
            assertTrue(params.getJSONObject(1).getBoolean("requireCanonical"))
            assertEquals("0x" + "a".repeat(64), params.getJSONObject(1).getString("blockHash"))
            balanceReads++
            val token = request.getString("to").lowercase()
            readsByToken[token] = (readsByToken[token] ?: 0) + 1
            amount
          } else if (data == "0x313ce567") "0x" + "6".padStart(64, '0') else error(data)
        }
        else -> error(method)
      }
    }
  }

  private class Fixture {
    val files = mutableMapOf<String, File>()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val rpc = Rpc()
    val nativeRpc = Rpc(143)
    var now = 100_000L
    val record =
      WalletRecord(
        "00000000-0000-4000-8000-000000000001",
        StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
        ByteArray(32),
        true,
        roleRegistry = """{"version":1,"nextRecipient":6}""",
      )

    fun observer() =
      NativeOwnedPortfolio(
        file = { files.getOrPut(it) { File() } },
        key = { key },
        rpc = { if (it == 143L) nativeRpc else rpc },
        deriveCycle = { _, _, _ -> emptyList() },
        derivePublic = { _, index -> owner(index + 1) },
        targets = { listOf(SOLD, OTHER) },
        clock = { now },
        selector = { "0x07a2d13a" },
      )

    @Suppress("UNCHECKED_CAST")
    suspend fun assets() = observer().read(record)["ownedAssets"] as List<Map<String, Any?>>
  }

  @Test
  fun soldTokenIsNotReusedAsFreshAlongsideNewPrivateCredit() = runBlocking {
    val f = Fixture()
    val initial = f.assets().single { it["token"] == SOLD }
    assertTrue(initial["complete"] as Boolean)
    val observed = initial["observedAtoms"]
    val otherReads = f.rpc.readsByToken[OTHER]
    f.now += 1_000 // Same 30-second cache window as the private-credit refresh.
    f.rpc.amount = "0x0"
    f.observer().invalidateTokens(f.record, 4663, setOf(SOLD))
    f.rpc.failed = true
    f.nativeRpc.failed = true
    val stale = f.assets()
    val sold = stale.single { it["token"] == SOLD }
    assertEquals(false, sold["complete"])
    assertEquals(true, sold["stale"])
    assertNull(sold["balanceAtoms"])
    assertNull(sold["valueUsdcAtoms"])
    assertEquals(observed, sold["observedAtoms"])
    assertEquals(true, stale.single { it["token"] == OTHER }["complete"])
    f.rpc.failed = false
    val refreshed = f.assets().single { it["token"] == SOLD }
    assertEquals("0", refreshed["balanceAtoms"])
    assertEquals(true, refreshed["complete"])
    assertEquals(false, refreshed["stale"])
    assertEquals(otherReads, f.rpc.readsByToken[OTHER])
  }

  @Test
  fun invalidatedShardRetainsObservationsAndResumesBoundedCanonicalReads() = runBlocking {
    val f = Fixture()
    val file = File()
    val owners = (1..81).map(::owner)
    fun sync() = TokenBalanceSync(file, { f.key }, "wallet", 4663, SOLD, f.rpc)
    sync().read(owners, f.now)
    assertTrue(sync().read(owners, f.now + 1).complete)
    val before = f.rpc.balanceReads
    sync().invalidate()
    val stale = sync().cachedSnapshot(owners, f.now + 2)!!
    assertFalse(stale.complete)
    assertTrue(stale.stale)
    assertEquals(81, stale.balances.size)
    assertTrue(stale.balances.values.all { it == "10" })
    f.rpc.amount = "0x0"
    val partial = sync().read(owners, f.now + 3)
    assertFalse(partial.complete)
    assertTrue(partial.syncPending)
    assertEquals(80, f.rpc.balanceReads - before)
    val finished = sync().read(owners, f.now + 4)
    assertTrue(finished.complete)
    assertFalse(finished.stale)
    assertEquals(81, f.rpc.balanceReads - before)
    assertTrue(finished.balances.values.all { it == "0" })
  }

  @Test
  fun nativeAndStableOriginObservationsBecomeStaleWithoutBeingDiscarded() = runBlocking {
    val f = Fixture()
    val initial = f.assets()
    val native = initial.single { it["token"] == "native" }
    val stable = initial.single { it["token"] == HOOD_EARN_USDG.lowercase() }
    f.now += 1_000
    f.observer().invalidateTokens(f.record, 4663, setOf(HOOD_EARN_USDG))
    f.observer().invalidateTokens(f.record, 143, setOf("native"))
    f.rpc.failed = true
    f.nativeRpc.failed = true
    val stale = f.assets()
    assertEquals(true, stale.single { it["token"] == "native" }["stale"])
    assertEquals(native["observedAtoms"], stale.single { it["token"] == "native" }["observedAtoms"])
    val origin = stale.single { it["token"] == HOOD_EARN_USDG.lowercase() }
    assertEquals(false, origin["complete"])
    assertEquals(stable["observedAtoms"], origin["observedAtoms"])
  }

  companion object {
    private const val SOLD = "0x1111111111111111111111111111111111111111"
    private const val OTHER = "0x2222222222222222222222222222222222222222"

    private fun owner(index: Int) = "0x" + index.toString(16).padStart(40, '0')
  }
}
