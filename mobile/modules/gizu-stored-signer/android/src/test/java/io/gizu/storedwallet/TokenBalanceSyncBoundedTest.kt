package io.gizu.storedwallet

import io.gizu.storedwallet.portfolio.*
import javax.crypto.KeyGenerator
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TokenBalanceSyncBoundedTest {
  private class File : WalletFile {
    var bytes: ByteArray? = null

    override fun exists() = bytes != null

    override fun read() = bytes!!.copyOf()

    override fun write(bytes: ByteArray) {
      this.bytes = bytes.copyOf()
    }
  }

  private class Rpc : PortfolioRpc {
    var head = 100
    var logs = 0
    var reads = 0
    var hash = "a"
    var failure = false
    var balance = "0x1"
    var dirty: String? = null
    val batches = mutableListOf<Int>()

    override suspend fun calls(requests: List<Pair<String, JSONArray>>): List<Any> {
      batches.add(requests.size)
      return requests.map { call(it.first, it.second) }
    }

    override suspend fun call(method: String, params: JSONArray): Any {
      check(!failure)
      return when (method) {
        "eth_chainId" -> "0x8f"
        "eth_getBlockByNumber" ->
          JSONObject()
            .put(
              "number",
              if (params.getString(0) == "finalized") "0x${head.toString(16)}"
              else params.getString(0),
            )
            .put("hash", "0x" + hash.repeat(64))
        "eth_call" -> {
          reads++
          balance
        }
        "eth_getLogs" -> {
          logs++
          JSONArray().also { items ->
            val filter = params.getJSONObject(0)
            val topics = filter.getJSONArray("topics")
            val watched = topics.getJSONArray(topics.length() - 1)
            dirty?.let { owner ->
              val topic = "0x" + owner.drop(2).padStart(64, '0')
              if ((0 until watched.length()).any { watched.getString(it) == topic })
                items.put(
                  JSONObject()
                    .put("address", TOKEN)
                    .put("removed", false)
                    .put("blockNumber", filter.getString("toBlock"))
                    .put("topics", JSONArray().put(TRANSFER).put("0x" + "0".repeat(64)).put(topic))
                )
            }
          }
        }
        else -> error(method)
      }
    }
  }

  private class Fixture {
    val file = File()
    val rpc = Rpc()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val owners = (1..600).map { "0x" + it.toString(16).padStart(40, '0') }

    fun sync() = TokenBalanceSync(file, { key }, "wallet", 143, TOKEN, rpc)

    suspend fun initial() {
      repeat(8) { sync().read(owners, it.toLong()) }
      assertEquals(600, rpc.reads)
      assertTrue(rpc.batches.all { it <= 40 })
      assertTrue(sync().read(owners, 9).complete)
    }
  }

  @Test
  fun forcedRefreshesFinishLargeCataloguesWithoutRestartingPendingOwners() = runBlocking {
    val f = Fixture()
    f.initial()
    f.rpc.balance = "0x2"
    var snapshot = f.sync().read(f.owners, 10, forceRefresh = true)
    assertFalse(snapshot.complete)
    repeat(7) { snapshot = f.sync().read(f.owners, 11L + it, forceRefresh = true) }
    assertTrue(snapshot.complete)
    assertFalse(snapshot.syncPending)
    assertEquals(1200, f.rpc.reads)
    assertTrue(snapshot.balances.values.all { it == "2" })
  }

  @Test
  fun sixHundredOwnersUseEightLogCallsPerOpeningAndCheckpointOnlyAfterWholeRange() = runBlocking {
    val f = Fixture()
    f.initial()
    f.rpc.head = 101
    f.rpc.dirty = f.owners.last()
    f.rpc.balance = "0x2"
    val partial = f.sync().read(f.owners, 31_000)
    assertEquals(8, f.rpc.logs)
    assertEquals("0x64", partial.block)
    assertTrue(partial.syncPending)
    assertFalse(partial.complete)
    assertEquals("1", partial.balances[f.owners.last()])
    val complete = f.sync().read(f.owners, 31_001)
    assertEquals(10, f.rpc.logs)
    assertEquals("0x65", complete.block)
    assertTrue(complete.complete)
    assertFalse(complete.syncPending)
    assertEquals("2", complete.balances[f.owners.last()])
  }

  @Test
  fun catalogueGrowthAndFailedOpeningCannotSkipAnUnscannedInboundEvent() = runBlocking {
    val f = Fixture()
    f.initial()
    f.rpc.head = 101
    f.rpc.dirty = f.owners.last()
    f.rpc.balance = "0x2"
    f.sync().read(f.owners, 31_000)
    f.rpc.failure = true
    assertTrue(f.sync().read(f.owners, 31_001).stale)
    f.rpc.failure = false
    f.rpc.head = 102
    val newOwner = "0x" + "f".repeat(40)
    val resumed = f.sync().read(f.owners + newOwner, 31_002)
    assertEquals("2", resumed.balances[f.owners.last()])
    assertEquals("2", resumed.balances[newOwner])
    assertEquals("0x65", resumed.block)
    assertTrue(resumed.syncPending)
    val before = f.rpc.logs
    f.sync().read(f.owners + newOwner, 31_003)
    assertTrue(f.rpc.logs - before <= 8)
  }

  @Test
  fun reorgReconciliationPersistsProgressInsteadOfRestartingEveryOpening() = runBlocking {
    val f = Fixture()
    f.initial()
    f.rpc.head = 101
    f.rpc.hash = "b"
    f.rpc.balance = "0x3"
    val stale = f.sync().read(f.owners, 31_000)
    assertTrue(stale.stale)
    assertFalse(stale.complete)
    var result = stale
    repeat(7) { result = f.sync().read(f.owners, 31_001 + it.toLong()) }
    assertTrue(result.complete)
    assertFalse(result.stale)
    assertEquals("0x65", result.block)
    assertTrue(result.balances.values.all { it == "3" })
    assertEquals(0, f.rpc.logs)
  }

  @Test
  fun returningWatchOwnerRefreshesEvenWhenAnOldBalanceWasCached() = runBlocking {
    val f = Fixture()
    val a = f.owners[0]
    val b = f.owners[1]
    f.sync().read(listOf(a, b), 0)
    f.rpc.head = 101
    f.sync().read(listOf(a), 31_000)
    f.rpc.balance = "0x7"
    assertFalse(f.sync().cachedSnapshot(listOf(a, b), 31_001)!!.complete)
    val restored = f.sync().read(listOf(a, b), 31_001)
    assertEquals("7", restored.balances[b])
    assertTrue(restored.complete)
  }

  @Test
  fun nativeJsonBatchRestoresRequestOrderAndRejectsDuplicateResponses() = runBlocking {
    var requests = 0
    val rpc =
      NativePortfolioRpc(
        "https://unused.test",
        post = { body ->
          val batch = JSONArray(body)
          requests++
          JSONArray(
              (0 until batch.length()).reversed().map { index ->
                val request = batch.getJSONObject(index)
                JSONObject()
                  .put("jsonrpc", "2.0")
                  .put("id", request.getInt("id"))
                  .put("result", request.getJSONArray("params").getString(0))
              }
            )
            .toString()
        },
      )
    assertEquals(
      listOf("first", "second"),
      rpc.calls(
        listOf("eth_call" to JSONArray().put("first"), "eth_call" to JSONArray().put("second"))
      ),
    )
    assertEquals(1, requests)
    val duplicate =
      NativePortfolioRpc(
        "https://unused.test",
        post = {
          JSONArray()
            .put(JSONObject().put("id", 1).put("result", "x"))
            .put(JSONObject().put("id", 1).put("result", "y"))
            .toString()
        },
      )
    var rejected = false
    try {
      duplicate.calls(listOf("eth_call" to JSONArray(), "eth_call" to JSONArray()))
    } catch (_: Exception) {
      rejected = true
    }
    assertTrue(rejected)
  }

  companion object {
    const val TOKEN = "0x754704bc059f8c67012fed69bc8a327a5aafb603"
    const val TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  }
}
