package io.gizu.storedwallet

import io.gizu.storedwallet.portfolio.*
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OwnedConfidentialPortfolioTest {
  @Test
  fun revokedReadPermissionRemainsLockedEvenWhenCachedBalancesAreFresh() = runBlocking {
    val f = Fixture(cycleCount = 1)
    val cache = f.cache()
    val authorized =
      cache.refresh(f.record, true, { ByteArray(4) }) { target, _ -> f.observation(target) }
    assertEquals("ready", authorized["confidentialReadState"])
    val locked =
      cache.refresh(f.record, false, { error("No authentication after lock") }) { _, _ ->
        error("No private request after lock")
      }
    assertEquals("locked", locked["confidentialReadState"])
    assertEquals(asset(authorized)["observedAtoms"], asset(locked)["observedAtoms"])
  }

  private class File : WalletFile {
    var bytes: ByteArray? = null

    override fun exists() = bytes != null

    override fun read() = bytes!!.copyOf()

    override fun write(bytes: ByteArray) {
      this.bytes = bytes.copyOf()
    }
  }

  private class Fixture(cycleCount: Int = 10) {
    val file = File()
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    var now = 100_000L
    var derives = 0
    var outgoing = emptySet<String>()
    val record =
      WalletRecord(
        "00000000-0000-4000-8000-000000000001",
        StoredPasskey(byteArrayOf(1), ByteArray(32), ByteArray(32)),
        ByteArray(32),
        earnChain = 1,
        earnCycleIndex = (cycleCount - 1).coerceAtLeast(0),
        earnCycles =
          JSONArray(
              (0 until cycleCount).map {
                JSONObject().put("cycleIndex", it).put("chainId", 1).put("intentId", "cycle-$it")
              }
            )
            .toString(),
      )

    fun cache() =
      NativeOwnedConfidentialPortfolio(
        file = { file },
        key = { key },
        deriveSwap = { address(200) },
        deriveEarn = { _, _, index ->
          derives++
          address(index.toLong() + 1)
        },
        clock = { now },
        outgoing = { outgoing },
      )

    fun observation(target: NativeConfidentialTarget) =
      mapOf<String, Any>(
        "confidentialAddress" to target.address,
        "assetId" to ASSET,
        "available" to "1000000",
        "timestampMs" to now,
        "authenticated" to true,
        "operationScoped" to false,
      )
  }

  @Test
  fun sharedInvestmentsDoNotCreateExtraPrivateBalanceReadTargets() {
    val f = Fixture(cycleCount = 128)
    val cycles = JSONArray(f.record.earnCycles)
    cycles.objects().forEach { it.put("privateAccount", "shared") }
    WalletRecord(
        f.record.id,
        f.record.credential,
        f.record.entropy.copyOf(),
        earnChain = 1,
        earnCycleIndex = 127,
        earnCycles = cycles.toString(),
      )
      .use { shared ->
        val targets = f.cache().ownedTargets(shared)
        assertEquals(1, targets.size)
        assertEquals("swap", targets.single().kind)
        assertEquals(0, f.derives)
      }
  }

  @Test
  fun actionObservationsRemainSharedAfterLoginReadPermissionExpiresAndOlderReadsCannotReplaceThem() =
    runBlocking {
      val f = Fixture(cycleCount = 1)
      val cache = f.cache()
      val target = cache.ownedTargets(f.record).first { it.kind == "swap" }
      val source =
        JSONObject()
          .put("address", target.address)
          .put("kind", target.kind)
          .put("profileChainId", target.profileChainId)
          .put("cycleIndex", target.cycleIndex)
      cache.recordSourceObservation(
        f.record,
        source,
        f.observation(target) + ("available" to "430000"),
      )
      cache.recordSourceObservation(
        f.record,
        source,
        f.observation(target) + mapOf("available" to "2430000", "timestampMs" to f.now - 1000),
      )
      f.now += 120000
      val locked =
        cache.refresh(f.record, false, { error("No background authentication") }) { _, _ ->
          error("No background balance read")
        }
      assertEquals("430000", asset(locked)["observedAtoms"])
      assertEquals("locked", locked["confidentialReadState"])
    }

  @Test
  fun outgoingCashoutCannotReuseCompletePreDebitPrivateBalance() = runBlocking {
    val f = Fixture(cycleCount = 1)
    val cache = f.cache()
    cache.refresh(f.record, true, { byteArrayOf(1, 2, 3, 4) }) { target, _ ->
      f.observation(target)
    }
    assertEquals(true, cache.snapshot(f.record)["confidentialComplete"])
    f.outgoing = setOf(address(200))
    val pending = cache.snapshot(f.record)
    assertEquals(false, pending["confidentialComplete"])
    assertNull(asset(pending)["balanceAtoms"])
    assertEquals("1000000", asset(pending)["observedAtoms"])
    cache.invalidateSources(f.record, f.outgoing)
    f.outgoing = emptySet()
    assertEquals(false, cache.snapshot(f.record)["confidentialComplete"])
  }

  @Test
  fun delayedSaltDoesNotConsumeTheIndependentSharedBalanceReadBudget() = runBlocking {
    val f = Fixture(cycleCount = 1)
    val salt = byteArrayOf(1, 2, 3, 4)
    var completed = 0
    val result =
      f.cache().refresh(
        f.record,
        true,
        {
          delay(250L)
          salt
        },
        timeoutMs = 400L,
      ) { target, receivedSalt ->
        assertArrayEquals(salt, receivedSalt)
        delay(250L)
        completed++
        f.observation(target)
      }
    assertEquals(2, completed)
    assertEquals("ready", result["confidentialReadState"])
    assertEquals("2000000", asset(result)["balanceAtoms"])
    assertEquals("2000000", f.cache().snapshot(f.record)["confidentialKnownAtoms"])
  }

  @Test
  fun unavailableSaltEndsReadAndKeepsKnownObservations() = runBlocking {
    val f = Fixture()
    val cache = f.cache()
    val target = cache.nextTargets(f.record).first()
    cache.recordValidated(target, f.observation(target))
    f.now += 31_000
    val result =
      cache.refresh(f.record, true, { awaitCancellation() }, timeoutMs = 30L) { _, _ ->
        error("No salt")
      }
    assertEquals("unavailable", result["confidentialReadState"])
    assertEquals("1000000", result["confidentialKnownAtoms"])
    assertNull(asset(result)["balanceAtoms"])
  }

  @Test
  fun privateSuccessSurvivesAnotherTargetTimeoutWithAtMostTwoReads() = runBlocking {
    val f = Fixture()
    val cache = f.cache()
    var active = 0
    var maxActive = 0
    val result =
      cache.refresh(f.record, true, { ByteArray(4) }, timeoutMs = 100L) { target, _ ->
        active++
        maxActive = maxOf(maxActive, active)
        try {
          if (target.cycleIndex == 9 && target.kind == "earn") f.observation(target)
          else awaitCancellation()
        } finally {
          active--
        }
      }
    assertEquals(2, maxActive)
    assertEquals(0, active)
    assertEquals("partial", result["confidentialReadState"])
    assertEquals("1000000", result["confidentialKnownAtoms"])
    assertNull(asset(result)["balanceAtoms"])
    assertEquals("1000000", f.cache().snapshot(f.record)["confidentialKnownAtoms"])
  }

  @Test
  fun callerCancellationCancelsPrivateRefreshWithoutPublishingSuccess() = runBlocking {
    val f = Fixture()
    val started = CompletableDeferred<Unit>()
    var completed = false
    val job = launch {
      f.cache().refresh(
        f.record,
        true,
        {
          started.complete(Unit)
          awaitCancellation()
        },
      ) { _, _ ->
        error("No salt")
      }
      completed = true
    }
    started.await()
    job.cancel()
    job.join()
    assertFalse(completed)
    assertTrue(job.isCancelled)
  }

  @Test
  fun lockedPrivateReadDoesNotContactProvider() = runBlocking {
    val f = Fixture()
    val result =
      f.cache().refresh(f.record, false, { error("Must stay locked") }) { _, _ ->
        error("Must stay locked")
      }
    assertEquals("locked", result["confidentialReadState"])
    assertNull(asset(result)["balanceAtoms"])
  }

  @Test
  fun boundedExplicitReadTargetsEventuallyProduceOneAggregateWithoutPublishingOwners() {
    val f = Fixture()
    val cache = f.cache()
    val targets = cache.nextTargets(f.record)
    assertEquals(4, targets.size)
    assertEquals(9, targets.first().cycleIndex)
    targets.forEach { cache.recordValidated(it, f.observation(it)) }
    val partial = cache.snapshot(f.record)
    assertEquals("4000000", partial["confidentialKnownAtoms"])
    assertNull(asset(partial)["balanceAtoms"])
    repeat(4) {
      val reopened = f.cache()
      reopened.nextTargets(f.record).forEach { reopened.recordValidated(it, f.observation(it)) }
    }
    val complete = f.cache().snapshot(f.record)
    assertEquals("11000000", asset(complete)["balanceAtoms"])
    assertEquals(true, complete["confidentialComplete"])
    assertEquals(0, f.cache().nextTargets(f.record).size)
    assertEquals(10, f.derives)
    assertFalse(complete.toString().contains(address(200)))
    assertFalse(String(f.file.bytes!!).contains("cycle-"))
  }

  @Test
  fun expiredReadCacheKeepsKnownAmountsButRequiresManualAuthenticationForATotal() {
    val f = Fixture()
    val cache = f.cache()
    repeat(4) {
      cache.nextTargets(f.record).forEach { cache.recordValidated(it, f.observation(it)) }
    }
    f.now += 31_000
    val stale = cache.snapshot(f.record)
    assertEquals("11000000", stale["confidentialKnownAtoms"])
    assertNull(asset(stale)["balanceAtoms"])
    assertEquals(true, stale["confidentialStale"])
    assertEquals(true, stale["confidentialReadRequired"])
    assertEquals(4, cache.nextTargets(f.record).size)
  }

  @Test
  fun legacyPreparedProfileIncludesItsOriginalConfidentialAccountAlongsideSwapAccountTwo() {
    val f = Fixture()
    val legacy =
      WalletRecord(f.record.id, f.record.credential, f.record.entropy.copyOf(), earnChain = 4663)
    val cache = f.cache()
    val targets = cache.nextTargets(legacy)
    assertEquals(2, targets.size)
    assertEquals(4663, targets.first().profileChainId)
    assertEquals(0, targets.first().cycleIndex)
    assertTrue(targets.any { it.kind == "swap" })
    targets.forEach { cache.recordValidated(it, f.observation(it)) }
    assertEquals("2000000", asset(cache.snapshot(legacy))["balanceAtoms"])
  }

  @Test
  fun cacheRejectsWrongAccountUnsupportedAssetAndOperationCreditMasqueradingAsBalance() {
    val f = Fixture()
    val cache = f.cache()
    val target = cache.nextTargets(f.record).first()
    for (change in
      listOf(
        mapOf("confidentialAddress" to address(900)),
        mapOf("assetId" to "unsupported-token"),
        mapOf("operationScoped" to true),
        mapOf("timestampMs" to 0L),
      )) {
      assertThrows(Exception::class.java) {
        cache.recordValidated(target, f.observation(target) + change)
      }
    }
    assertThrows(Exception::class.java) {
      cache.recordValidated(target.copy(address = address(900)), f.observation(target))
    }
    assertNull(asset(cache.snapshot(f.record))["balanceAtoms"])
  }

  @Suppress("UNCHECKED_CAST")
  private fun asset(snapshot: Map<String, Any?>) =
    (snapshot["ownedAssets"] as List<Map<String, Any?>>).single()

  companion object {
    private const val ASSET = "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx"

    private fun address(n: Long) = "0x" + n.toString(16).padStart(40, '0')
  }
}
