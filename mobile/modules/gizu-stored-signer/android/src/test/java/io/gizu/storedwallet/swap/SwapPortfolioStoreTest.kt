package io.gizu.storedwallet.swap

import io.gizu.storedwallet.CryptoEnvelope
import io.gizu.storedwallet.WalletFile
import javax.crypto.KeyGenerator
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SwapPortfolioStoreTest {
  private val wallet = "7aafcc2e-0891-4e31-a7d4-03780d7b4f12"
  private val journal = "2793c0c2-62a5-4539-bc25-18893b8fc8c2"
  private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
  private val intc = "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681"
  private val spcx = "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea"
  private var now = 1_000L

  private class MemoryFile : WalletFile {
    var value: ByteArray? = null

    override fun exists() = value != null

    override fun read() = value!!.copyOf()

    override fun write(bytes: ByteArray) {
      value = bytes.copyOf()
    }
  }

  private val file = MemoryFile()

  private fun store() = SwapPortfolioStore(wallet, file, { key }, journal) { now }

  private fun raw(): JSONObject =
    JSONObject(
      String(
        CryptoEnvelope.decrypt(key, file.read(), "gizu-holdings:v1:$wallet:$journal".toByteArray())
      )
    )

  private fun writeRaw(root: JSONObject) {
    file.write(
      CryptoEnvelope.encrypt(
        key,
        root.toString().toByteArray(),
        "gizu-holdings:v1:$wallet:$journal".toByteArray(),
      )
    )
  }

  @Test
  fun versionOneLedgerUpgradesToRobinhoodAssetsAndKeepsHistory() {
    writeRaw(
      JSONObject()
        .put("version", 1)
        .put("tokens", JSONArray().put(intc).put(spcx))
        .put(
          "history",
          JSONObject().put("op1", JSONObject().put("operationId", "op1").put("phase", "COMPLETE")),
        )
    )
    assertEquals(listOf(intc, spcx), store().targets())
    assertEquals(listOf(SwapLedgerAsset(4663, intc, "swap", 0)), store().assets().take(1))
    store().watch(intc.uppercase().replace("0X", "0x"))
    val saved = raw()
    assertEquals(2, saved.getInt("version"))
    assertEquals(wallet, saved.getString("walletId"))
    assertEquals("COMPLETE", saved.getJSONObject("history").getJSONObject("op1").getString("phase"))
  }

  @Test
  fun tokensAreTrackedPerChainAndNeverDuplicated() {
    store().watch(intc)
    store().watch(intc.uppercase().replace("0X", "0x"))
    store().watch(intc, chainId = 143)
    assertEquals(listOf(intc), store().targets())
    assertEquals(listOf(intc), store().targets(143))
    assertTrue(store().targets(1).isEmpty())
  }

  @Test
  fun sweepIsDueOncePerIntervalAndAddsOnlyNewTokensAsDiscovered() {
    store().watch(intc)
    assertTrue(store().sweepDue(4663))
    now = 2_000L
    assertEquals(listOf(spcx), store().recordSweep(4663, listOf(intc, spcx)))
    assertFalse(store().sweepDue(4663))
    assertTrue(store().sweepDue(143))
    val assets = store().assets()
    assertEquals("swap", assets.single { it.token == intc }.source)
    assertEquals(SwapLedgerAsset(4663, spcx, "discovered", 2_000L), assets.single { it.token == spcx })
    now = 2_000L + SwapPortfolioStore.SWEEP_INTERVAL_MS
    assertTrue(store().sweepDue(4663))
    // A clock moved backwards is not trusted to postpone the next sweep.
    now = 1_000L
    assertTrue(store().sweepDue(4663))
  }

  @Test
  fun aSwapPurchaseUpgradesADiscoveredTokenAndKeepsTheEarliestSighting() {
    now = 5_000L
    store().recordSweep(4663, listOf(intc))
    now = 9_000L
    store().watch(intc)
    assertEquals(SwapLedgerAsset(4663, intc, "swap", 5_000L), store().assets().single())
  }

  @Test
  fun eachChainIsBoundedSoTheOwnedPortfolioStaysReadable() {
    val tokens = (0 until SwapPortfolioStore.CHAIN_LIMIT + 5).map { "0x" + it.toString(16).padStart(40, '0') }
    store().recordSweep(4663, tokens)
    assertEquals(SwapPortfolioStore.CHAIN_LIMIT, store().targets().size)
    store().watch(intc, chainId = 143)
    assertEquals(listOf(intc), store().targets(143))
  }

  @Test
  fun recoveryMergeUnitesAssetsKeepsCompletedHistoryAndForgetsSweeps() {
    val a =
      SwapPortfolioStore.empty(wallet).also {
        SwapPortfolioStore.add(it, 4663, intc, "swap", 10)
        it.getJSONObject("swept").put("4663", 99)
        it
          .getJSONObject("history")
          .put("op1", JSONObject().put("operationId", "op1").put("phase", "COMPLETE"))
      }
    val b =
      JSONObject()
        .put("version", 1)
        .put("tokens", JSONArray().put(spcx).put(intc))
        .put(
          "history",
          JSONObject()
            .put("op1", JSONObject().put("operationId", "op1").put("phase", "CANCELLED"))
            .put("op2", JSONObject().put("operationId", "op2").put("phase", "COMPLETE")),
        )
    val merged = SwapPortfolioStore.mergeRecovered(a, b, wallet)
    assertEquals(
      listOf(4663L to intc, 4663L to spcx),
      SwapPortfolioStore.assets(merged).map { it.chainId to it.token },
    )
    assertEquals(10L, SwapPortfolioStore.assets(merged).first().firstSeenAt)
    assertEquals("COMPLETE", merged.getJSONObject("history").getJSONObject("op1").getString("phase"))
    assertTrue(merged.getJSONObject("history").has("op2"))
    assertEquals(0, merged.getJSONObject("swept").length())
  }

  @Test
  fun aLedgerBoundToAnotherWalletOrMalformedIsRejected() {
    val other = SwapPortfolioStore.empty("someone-else")
    assertThrows(IllegalStateException::class.java) { SwapPortfolioStore.normalize(other, wallet) }
    val bad = SwapPortfolioStore.empty(wallet)
    bad.getJSONArray("assets").put(
      JSONObject().put("chainId", 4663).put("token", "0x1234").put("source", "swap").put("firstSeenAt", 0)
    )
    assertThrows(IllegalArgumentException::class.java) { SwapPortfolioStore.normalize(bad, wallet) }
    assertThrows(IllegalStateException::class.java) {
      SwapPortfolioStore.normalize(JSONObject().put("version", 9), wallet)
    }
  }
}
