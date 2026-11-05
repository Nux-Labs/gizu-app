package io.gizu.storedwallet

import io.gizu.storedwallet.portfolio.*
import java.math.BigInteger
import javax.crypto.KeyGenerator
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OwnedPortfolioTest {
  private class File : WalletFile {
    var bytes: ByteArray? = null

    override fun exists() = bytes != null

    override fun read() = bytes!!.copyOf()

    override fun write(bytes: ByteArray) {
      this.bytes = bytes.copyOf()
    }
  }

  private class Rpc(val chain: Long) : PortfolioRpc {
    var held = BigInteger.TEN.pow(18)
    var rates = 0
    var decimals = 0
    var nativeReads = 0
    var balances = 0
    val observedOwners = mutableMapOf<String, MutableSet<String>>()
    var failure = false
    var stalled = false
    var latestOnly = false
    var head = 100

    private fun hash(number: Int) =
      if (latestOnly) "0x" + "a".repeat(56) + number.toString(16).padStart(8, '0')
      else "0x" + "a".repeat(64)

    private fun availableState(params: JSONArray) {
      if (latestOnly) {
        assertEquals(hash(head), params.getJSONObject(1).getString("blockHash"))
        assertTrue(params.getJSONObject(1).getBoolean("requireCanonical"))
      }
    }

    override suspend fun call(method: String, params: JSONArray): Any {
      if (stalled) awaitCancellation()
      check(!failure)
      return when (method) {
        "eth_chainId" -> "0x${chain.toString(16)}"
        "eth_getBlockByNumber" -> {
          val number =
            if (!latestOnly) 100
            else
              when (val tag = params.getString(0)) {
                "latest" -> head
                "finalized" -> head - 20
                else -> tag.drop(2).toInt(16)
              }
          JSONObject().put("number", "0x${number.toString(16)}").put("hash", hash(number))
        }
        "eth_getLogs" -> JSONArray()
        "eth_getBalance" -> {
          availableState(params)
          nativeReads++
          "0x1"
        }
        "eth_call" -> {
          availableState(params)
          val data = params.getJSONObject(0).getString("data")
          when (data.take(10)) {
            "0x70a08231" -> {
              observedOwners
                .getOrPut(params.getJSONObject(0).getString("to").lowercase()) { mutableSetOf() }
                .add("0x" + data.takeLast(40).lowercase())
              balances++
              word(held)
            }
            "0x313ce567" -> {
              decimals++
              word(BigInteger.valueOf(18))
            }
            "0x38d52e0f" ->
              word(BigInteger((if (chain == 1L) ETH_EARN_USDC else HOOD_EARN_USDG).drop(2), 16))
            "0x07a2d13a" -> {
              rates++
              assertTrue(params.getJSONObject(1).getBoolean("requireCanonical"))
              word(BigInteger.valueOf(2_000_000))
            }
            else -> error(data)
          }
        }
        else -> error(method)
      }
    }

    private fun word(n: BigInteger) = "0x" + n.toString(16).padStart(64, '0')
  }

  private class Fixture {
    val files = mutableMapOf<String, File>()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val rpcs = listOf(1L, 143L, 4663L).associateWith(::Rpc)
    var now = 100_000L
    var derivations = 0
    var targets = emptyList<String>()
    var budgetMs = 10_000L

    fun observer() =
      NativeOwnedPortfolio(
        file = { files.getOrPut(it) { File() } },
        key = { key },
        rpc = { rpcs.getValue(it) },
        deriveCycle = { _, chain, index ->
          derivations++
          listOf(address(chain * 100_000 + index * 2), address(chain * 100_000 + index * 2 + 1))
        },
        derivePublic = { _, index -> address(index.toLong() + 9_000_000) },
        targets = { targets },
        clock = { now },
        selector = { "0x07a2d13a" },
        rpcBudget = { PortfolioReadBudget(budgetMs, minOf(budgetMs, 3_000L)) },
      )

    fun record(count: Int = 30, chain: Int = 1, recipients: Int = 3) =
      WalletRecord(
        "00000000-0000-4000-8000-000000000001",
        StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
        ByteArray(32),
        roleRegistry = """{"version":1,"nextRecipient":$recipients}""",
        earnChain = chain,
        earnCycleIndex = (count - 1).coerceAtLeast(0),
        earnCycles =
          JSONArray(
              (0 until count).map {
                JSONObject()
                  .put("cycleIndex", it)
                  .put("chainId", chain)
                  .put("intentId", "cycle-$it")
              }
            )
            .toString(),
      )
  }

  @Test
  fun tokenRefreshRotatesActualReadOrderWhileDisplayOrderStaysStable() = runBlocking {
    val f = Fixture()
    val record = f.record(count = 1, chain = 4663)
    val first = f.observer().read(record)
    val rpc = f.rpcs.getValue(4663)
    assertEquals(HOOD_EARN_VAULT.lowercase(), rpc.observedOwners.keys.first())
    rpc.observedOwners.clear()
    f.now += 31_000
    val second = f.observer().read(record)
    assertEquals(HOOD_EARN_USDG.lowercase(), rpc.observedOwners.keys.first())
    assertEquals(
      rows(first, "positions").map { it["assetId"] },
      rows(second, "positions").map { it["assetId"] },
    )
  }

  @Test
  fun firstObservationPrioritizesActiveVaultWhenOtherProviderStalls() = runBlocking {
    val f = Fixture()
    f.rpcs.getValue(4663).stalled = true
    f.budgetMs = 40L
    val record = f.record(count = 1)
    val first = f.observer().read(record)
    assertEquals("4000000", rows(first, "positions").single()["underlyingAtoms"])
    assertTrue(f.rpcs.getValue(1).rates > 0)
  }

  @Test
  fun allCyclesShareOneCanonicalVaultRateAndMetadataAcrossRestarts() = runBlocking {
    val f = Fixture()
    val record = f.record()
    val first = f.observer().read(record)
    val position = rows(first, "positions").single()
    assertEquals("120000000", position["underlyingAtoms"])
    assertEquals(6, position["decimals"])
    assertEquals(18, position["shareDecimals"])
    assertEquals("USDC", position["symbol"])
    assertEquals(1, f.rpcs.getValue(1).rates)
    assertEquals(1, f.rpcs.getValue(1).decimals)
    assertTrue(
      rows(first, "ownedAssets").none { it["token"].toString().equals(ETH_EARN_VAULT, true) }
    )
    val originalDerivations = f.derivations
    val originalReads = f.rpcs.values.sumOf { it.balances }
    f.now++
    f.observer().read(record)
    assertEquals(originalDerivations, f.derivations)
    assertEquals(originalReads, f.rpcs.values.sumOf { it.balances })
    assertEquals(1, f.rpcs.getValue(1).rates)
    assertTrue(f.files.values.all { it.bytes != null && !String(it.bytes!!).contains("cycle-") })
  }

  @Test
  fun restoredMixedCatalogueReadsEveryDistributionSlotOnBothChainsAndKeepsLegacyOwners() =
    runBlocking {
      val f = Fixture()
      val cycles = JSONArray()
      var index = 0
      for (chain in listOf(1, 4663)) {
        cycles.put(
          JSONObject()
            .put("cycleIndex", index++)
            .put("chainId", chain)
            .put("intentId", "legacy-$chain")
        )
        for (weights in
          listOf(listOf(10000), listOf(3100, 6900), listOf(1000, 1500, 2000, 2500, 3000))) {
          cycles.put(
            JSONObject()
              .put("cycleIndex", index++)
              .put("chainId", chain)
              .put("intentId", "distribution-$index")
              .put(
                "distribution",
                JSONObject().put("version", 1).put("weightsBps", JSONArray(weights)),
              )
              .put("distributionBudgetAtoms", "100000000")
              .put("investmentSlot", weights.lastIndex)
          )
        }
      }
      f.record(count = 0, chain = 4663).use { base ->
        WalletRecord(
            base.id,
            base.credential,
            base.entropy.copyOf(),
            true,
            base.journalId,
            base.roleRegistry,
            4663,
            false,
            7,
            cycles.toString(),
          )
          .use { original ->
            val expected =
              listOf(1L, 4663L).associateWith { chain ->
                cycles
                  .objects()
                  .filter { it.getLong("chainId") == chain }
                  .flatMap { row ->
                    if (row.has("distribution"))
                      uniffi.gizu_stored_signer_core.deriveEarnDistributionAddresses(
                        original.entropy,
                        chain.toULong(),
                        row.getInt("cycleIndex").toUInt(),
                        row
                          .getJSONObject("distribution")
                          .getJSONArray("weightsBps")
                          .length()
                          .toUInt(),
                      )
                    else
                      uniffi.gizu_stored_signer_core.deriveEarnCycleAddresses(
                        original.entropy,
                        chain.toULong(),
                        row.getInt("cycleIndex").toUInt(),
                      )
                  }
                  .map(String::lowercase)
                  .toSet()
              }
            val restoredStore =
              WalletStore(
                File(),
                object : WalletKeys {
                  override fun existing() = f.key

                  override fun create() = f.key

                  override fun reset() = f.key
                },
              )
            val prf = ByteArray(32) { 7 }
            BackupCodec.decrypt(BackupCodec.encrypt(original, prf), prf).use {
              restoredStore.restore(it)
            }
            fun observer() =
              NativeOwnedPortfolio(
                file = { f.files.getOrPut(it) { File() } },
                key = { f.key },
                rpc = { f.rpcs.getValue(it) },
                derivePublic = ::publicAccountAddress,
                targets = { emptyList() },
                clock = { f.now },
                selector = { "0x07a2d13a" },
              )
            restoredStore.load().use { restored ->
              assertTrue(restored.earnRecoveryRequired)
              val portfolio = observer().read(restored)
              for ((chain, vault) in listOf(1L to ETH_EARN_VAULT, 4663L to HOOD_EARN_VAULT)) {
                assertEquals(10, expected.getValue(chain).size)
                assertEquals(
                  expected.getValue(chain),
                  f.rpcs.getValue(chain).observedOwners.getValue(vault.lowercase()),
                )
                val position =
                  rows(portfolio, "positions").single {
                    (it["chainId"] as Number).toLong() == chain
                  }
                assertEquals(true, position["complete"])
                assertEquals("10000000000000000000", position["shareAtoms"])
                assertEquals("20000000", position["underlyingAtoms"])
              }
              val reads = f.rpcs.values.sumOf { it.balances }
              val cached = observer().read(restored)
              assertEquals(rows(portfolio, "positions"), rows(cached, "positions"))
              assertEquals(reads, f.rpcs.values.sumOf { it.balances })
              for (owner in expected.values.flatten()) {
                assertFalse(portfolio.toString().contains(owner))
                assertTrue(f.files.values.all { !String(it.bytes!!).contains(owner) })
              }
            }
          }
      }
    }

  @Test
  fun nativeReadsAreBoundedAndUnknownMarketPricesNeverProduceZeroValue() = runBlocking {
    val f = Fixture()
    f.targets = listOf(address(80), address(81))
    val result = f.observer().read(f.record(chain = 4663, recipients = 70))
    assertTrue(f.rpcs.values.sumOf { it.nativeReads } <= 8)
    assertEquals(false, result["valuationComplete"])
    val usdg = rows(result, "ownedAssets").single { it["symbol"] == "USDG" }
    assertNull(usdg["valueUsdcAtoms"])
    assertEquals(true, usdg["valuationUnavailable"])
    assertTrue(rows(result, "positions").all { it["valueUsdcAtoms"] == null })
    assertFalse(result.containsKey("balanceComplete"))
    assertFalse(result.containsKey("stale"))
    assertFalse(result.toString().contains(address(9_000_000)))
    val before = f.rpcs.values.sumOf { it.nativeReads }
    f.now++
    f.observer().read(f.record(chain = 4663, recipients = 70))
    assertTrue(f.rpcs.values.sumOf { it.nativeReads } - before <= 8)
  }

  @Test
  fun partialCatalogueIsNotATotalAndConversionRoundsEachOwnerDown() = runBlocking {
    val f = Fixture()
    val record = f.record(count = 80)
    val partial = rows(f.observer().read(record), "positions").single()
    assertEquals(false, partial["complete"])
    assertNull(partial["shareAtoms"])
    assertNull(partial["underlyingAtoms"])
    assertEquals("160000000", partial["observedUnderlyingAtoms"])
    f.now++
    assertEquals(
      "320000000",
      rows(f.observer().read(record), "positions").single()["underlyingAtoms"],
    )
    assertEquals(1, f.rpcs.getValue(1).rates)
    val rounding = Fixture()
    rounding.rpcs.getValue(1).held = BigInteger("250000000000")
    assertEquals(
      "0",
      rows(rounding.observer().read(rounding.record()), "positions").single()["underlyingAtoms"],
    )
  }

  @Test
  fun combinedEarnAndPublicOwnersAboveOneShardKeepOneAssetReadBudget() = runBlocking {
    val f = Fixture()
    val record = f.record(count = 6, chain = 4663, recipients = 8192)
    val result = f.observer().read(record)
    assertEquals(92, f.rpcs.getValue(4663).balances) // 80 USDG owners plus twelve vault owners.
    val usdg = rows(result, "ownedAssets").single { it["symbol"] == "USDG" }
    assertEquals(false, usdg["complete"])
    assertNull(usdg["balanceAtoms"])
    val before = f.rpcs.getValue(4663).balances
    f.now++
    f.observer().read(record)
    assertTrue(f.rpcs.getValue(4663).balances - before <= 80)
  }

  @Test
  fun legacyCycleZeroIsObservedAndNetworkFailureRetainsStaleAmounts() = runBlocking {
    val f = Fixture()
    val record = f.record(count = 0)
    val initial = f.observer().read(record)
    assertEquals("4000000", rows(initial, "positions").single()["underlyingAtoms"])
    f.rpcs.values.forEach { it.failure = true }
    f.now += 31_000
    val stale = f.observer().read(record)
    assertEquals(true, stale["ownedStale"])
    assertEquals(
      rows(initial, "positions").single()["underlyingAtoms"],
      rows(stale, "positions").single()["underlyingAtoms"],
    )
    assertNull(rows(stale, "positions").single()["valueUsdcAtoms"])
  }

  @Test
  fun robinhoodMetadataVaultConversionAndNativeGasUseAvailableLatestStateOnly() = runBlocking {
    val f = Fixture()
    val rpc = f.rpcs.getValue(4663)
    rpc.latestOnly = true
    f.targets = listOf(address(80))
    val record = f.record(count = 60, chain = 4663)
    val first = f.observer().read(record)
    assertEquals(false, rows(first, "positions").single()["complete"])
    assertEquals(1, rpc.rates)
    assertEquals(2, rpc.decimals) // Vault and the stock token share cached metadata.
    assertTrue(
      rows(first, "ownedAssets")
        .filter { it["chainId"] == 4663L }
        .all { it["observationFinality"] == "latest" }
    )
    assertTrue(rpc.nativeReads > 0 && rpc.nativeReads <= 8)
    rpc.head = 101
    f.now++
    val complete = rows(f.observer().read(record), "positions").single()
    assertEquals("240000000", complete["underlyingAtoms"])
    assertEquals("latest", complete["observationFinality"])
    assertNull(complete["valueUsdcAtoms"])
    rpc.head = 102
    f.now += 31_000
    val refreshed = rows(f.observer().read(record), "positions").single()
    assertEquals("0x66", refreshed["conversionBlock"])
    assertEquals(2, rpc.rates)
    assertEquals(2, rpc.decimals)
  }

  @Test
  fun stalledEthereumStillAllowsFirstUsdGObservation() = runBlocking {
    val f = Fixture()
    f.rpcs.getValue(1).stalled = true
    f.budgetMs = 100L
    val result = withTimeout(1_000L) { f.observer().read(f.record(count = 0, chain = 1)) }
    val usdg = rows(result, "ownedAssets").single { it["symbol"] == "USDG" }
    assertEquals(true, usdg["complete"])
    assertEquals(false, usdg["stale"])
    assertNotNull(usdg["balanceAtoms"])
    assertTrue(rows(result, "positions").all { it["balanceAtoms"] == null })
  }

  @Test
  fun stalledProviderCannotHidePreviouslyObservedUsdG() = runBlocking {
    val f = Fixture()
    val record = f.record(count = 0, chain = 4663)
    val initial = f.observer().read(record)
    f.now += 31_000
    f.rpcs.values.forEach { it.stalled = true }
    f.budgetMs = 30L
    val result = withTimeout(12_000L) { f.observer().read(record) }
    val usdg = rows(result, "ownedAssets").single { it["symbol"] == "USDG" }
    assertEquals(
      rows(initial, "ownedAssets").single { it["symbol"] == "USDG" }["balanceAtoms"],
      usdg["balanceAtoms"],
    )
    assertEquals(true, usdg["stale"])
  }

  @Suppress("UNCHECKED_CAST")
  private fun rows(value: Map<String, Any?>, key: String) =
    value.getValue(key) as List<Map<String, Any?>>

  companion object {
    private fun address(n: Long) = "0x" + n.toString(16).padStart(40, '0')
  }
}
