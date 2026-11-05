package io.gizu.storedwallet

import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class WalletRecoveryTest {
  private class MemoryFile : WalletFile {
    var bytes: ByteArray? = null
    var fail = false

    override fun exists() = bytes != null

    override fun read() = checkNotNull(bytes).copyOf()

    override fun write(bytes: ByteArray) {
      check(!fail)
      this.bytes = bytes.copyOf()
    }
  }

  private class Keys : WalletKeys {
    var key: SecretKey? = null

    override fun existing() = key

    override fun create() =
      KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { key = it }

    override fun reset() = create()
  }

  private class Remote : WalletRecoveryRemote {
    val objects = mutableMapOf<String, RecoveryObject>()
    val tokens = mutableMapOf<String, String>()
    var fail = false
    var conflict = false
    var afterPut: ((String) -> Unit)? = null

    override suspend fun get(id: String, token: String): RecoveryObject? {
      check(!fail)
      if (tokens[id] != token) return null
      return objects[id]
    }

    override suspend fun delete(id: String, token: String) {
      check(!fail)
      if (tokens[id] == token) {
        objects.remove(id)
        tokens.remove(id)
      }
    }

    override suspend fun put(
      id: String,
      token: String,
      expected: Long,
      ciphertext: String,
    ): RecoveryObject {
      check(!fail)
      if (
        conflict ||
          (objects[id]?.revision ?: 0) != expected ||
          (tokens[id] != null && tokens[id] != token)
      )
        throw WalletRecoveryFailure("RECOVERY_CONFLICT")
      tokens[id] = token
      return RecoveryObject(expected + 1, ciphertext).also {
        objects[id] = it
        afterPut?.invoke(id)
      }
    }
  }

  private fun wallet() =
    WalletRecord(
      "7aafcc2e-0891-4e31-a7d4-03780d7b4f12",
      StoredPasskey(byteArrayOf(1, 2, 3), ByteArray(32) { 3 }, ByteArray(32) { 4 }),
      ByteArray(32) { it.toByte() },
    )

  private fun store(): WalletStore =
    WalletStore(MemoryFile(), Keys()).also { store ->
      wallet().use {
        store.create(it)
        store.markVerified(it)
      }
    }

  private fun engine(
    store: WalletStore,
    remote: Remote,
    state: MemoryFile = MemoryFile(),
    history: JSONArray = JSONArray(),
    retain: (WalletRecord, JSONArray) -> Unit = { _, _ -> },
    observe: suspend (WalletRecord, Int, Int) -> Int = { _, _, _ -> 0 },
  ) = WalletRecoveryEngine(store, state, remote, { history }, retain, observe)

  @Test
  fun hkdfDomainsAuthenticatedLocatorRevisionAndTampering() {
    WalletRecoveryCrypto(ByteArray(32) { it.toByte() }).use { crypto ->
      assertEquals(64, crypto.locator.length)
      assertEquals(64, crypto.token.length)
      assertNotEquals(crypto.locator, crypto.token)
      val value = crypto.encrypt(crypto.locator, 3, "metadata".toByteArray())
      assertEquals("metadata", String(crypto.decrypt(crypto.locator, 3, value)))
      assertThrows(Exception::class.java) { crypto.decrypt(crypto.locator, 2, value) }
      assertThrows(Exception::class.java) { crypto.decrypt(crypto.token, 3, value) }
      WalletRecoveryCrypto(ByteArray(32) { (it + 1).toByte() }).use { wrong ->
        assertThrows(Exception::class.java) { wrong.decrypt(crypto.locator, 3, value) }
      }
      val tampered = value.dropLast(2) + if (value[value.length - 2] == 'A') "BB" else "AA"
      assertThrows(Exception::class.java) { crypto.decrypt(crypto.locator, 3, tampered) }
    }
  }

  @Test
  fun immutablePagesMigrateLegacyFailClosedAndKeepPreviousCommitOnFailure() {
    val root = MemoryFile()
    val files = mutableMapOf<String, MemoryFile>()
    val paged =
      PagedWalletFile(
        root,
        { files.getOrPut(it) { MemoryFile() } },
        prune = { keep -> files.keys.retainAll(keep) },
      )
    val legacy = ByteArray(20) { it.toByte() }
    root.write(legacy)
    assertArrayEquals(legacy, paged.read())
    val many = ByteArray(200_000) { (it % 251).toByte() }
    paged.write(many)
    assertEquals(4, files.size)
    assertArrayEquals(many, paged.read())
    root.fail = true
    assertThrows(Exception::class.java) { paged.write(ByteArray(200_000) { 42 }) }
    assertArrayEquals(many, paged.read())
    repeat(20) { attempt ->
      assertThrows(Exception::class.java) {
        paged.write(ByteArray(200_000) { (attempt + 50).toByte() })
      }
      assertArrayEquals(many, paged.read())
      assertTrue(files.size <= 8)
    }
    root.fail = false
    paged.write(ByteArray(200_000) { 43 })
    assertTrue(files.size <= 8)
    paged.write(ByteArray(200_000) { 44 })
    assertTrue(files.size <= 8)
    files.values.first { file -> file.bytes?.firstOrNull() == 44.toByte() }.bytes!![0] = 0
    assertThrows(Exception::class.java) { paged.read() }
  }

  @Test
  fun oldBackupRestoresCurrentCatalogueAndExactSignedHistoryAcrossMultipleRemotePages() =
    runBlocking {
      val current = store()
      val remote = Remote()
      current.load().use { current.bindEarnChain(it, 4663) }
      repeat(300) { current.load().use { current.allocateEarnCycle(it, 4663) } }
      current.load().use { current.reserveEarnWithdrawal(it) }
      val exact =
        JSONObject()
          .put("domain", "gizu-stored-operations")
          .put(
            "data",
            JSONObject()
              .put("raw", "0x" + "a".repeat(2_000_000))
              .put("hash", "0x1234")
              .put("nonce", "17")
              .put("status", "signed")
              .toString(),
          )
      val synced =
        engine(current, remote, history = JSONArray().put(exact)).sync(wallet().use { it.id })
      assertTrue(synced["synced"] as Boolean)
      assertTrue(remote.objects.size > 20)
      val old = store()
      var recovered: JSONArray? = null
      val restored =
        engine(old, remote, retain = { _, value -> recovered = value })
          .restore(wallet().use { it.id })
      assertTrue(restored["recoveryRequired"] as Boolean)
      old.load().use { record ->
        assertEquals(300, record.earnCycleIndex)
        assertEquals(301, JSONArray(record.earnCycles).length())
        assertEquals(4, JSONObject(record.roleRegistry).getInt("nextRecipient"))
        assertThrows(Exception::class.java) { old.allocateEarnCycle(record, 4663) }
      }
      assertEquals(exact.getString("data"), recovered!!.getJSONObject(0).getString("data"))
      assertEquals(1L, recovered!!.getJSONObject(0).getLong("snapshotRevision"))
      assertEquals(
        setOf(
          "version",
          "phase",
          "revision",
          "synced",
          "scannedThroughCycle",
          "scanTargetCycle",
          "discoveredWallets",
          "recoveryRequired",
          "messageCode",
        ),
        restored.keys,
      )
    }

  @Test
  fun rollbackMissingObjectAndConflictingUpdatesNeverAcknowledgeFunding() = runBlocking {
    val store = store()
    val remote = Remote()
    val state = MemoryFile()
    val owner = engine(store, remote, state)
    val id = wallet().use { it.id }
    owner.sync(id)
    val rootId = wallet().use { WalletRecoveryCrypto(it.entropy).use { c -> c.locator } }
    val root = remote.objects.getValue(rootId)
    remote.objects[rootId] = root.copy(revision = 0)
    try {
      owner.sync(id)
      fail()
    } catch (e: WalletRecoveryFailure) {
      assertEquals("RECOVERY_ROLLBACK", e.code)
    }
    remote.objects.remove(rootId)
    try {
      owner.sync(id)
      fail()
    } catch (e: WalletRecoveryFailure) {
      assertEquals("RECOVERY_MISSING", e.code)
    }
    remote.objects[rootId] = root
    store.load().use { store.bindEarnChain(it, 4663) }
    remote.conflict = true
    try {
      owner.sync(id)
      fail()
    } catch (e: WalletRecoveryFailure) {
      assertEquals("RECOVERY_CONFLICT", e.code)
    }
    assertEquals(false, owner.status(id)["synced"])
  }

  @Test
  fun journalPaginationRetainsMoreThan256SettledRowsAndPendingSignatures() {
    val root = MemoryFile()
    val pages = mutableMapOf<String, MemoryFile>()
    val file = PagedWalletFile(root, { pages.getOrPut(it) { MemoryFile() } })
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    val id = wallet().use { it.id }
    val journal = EarnVaultJournal(file, { key }, id, id)
    fun proposal(index: Int, account: String) =
      JSONObject()
        .put("operationId", "operation-$index")
        .put("expectedFrom", account)
        .put("kind", "vaultDeposit")
    val pending = journal.create(proposal(0, "pending-owner"))
    journal.update(pending.getString("operationId"), 1) {
      it.put(
        "steps",
        JSONArray().put(JSONObject().put("status", "unknown").put("raw", "0xdeadbeef")),
      )
    }
    repeat(300) { index ->
      val op = journal.create(proposal(index + 1, "settled-owner"))
      journal.update(op.getString("operationId"), 1) {
        it.put(
          "steps",
          JSONArray()
            .put(JSONObject().put("status", "finalized").put("raw", "0x" + "a".repeat(300))),
        )
      }
    }
    val reopened = EarnVaultJournal(file, { key }, id, id)
    assertEquals(301, reopened.all().size)
    assertEquals("0xdeadbeef", reopened.get("operation-0").steps().single().getString("raw"))
    assertTrue(reopened.get("operation-0").earnBlocked())
    assertTrue(pages.size > 1)
  }

  @Test
  fun backupStillRoundTripsWhenCatalogueExceedsLegacyUtfAndFileLimits() {
    val store = store()
    store.load().use { store.bindEarnChain(it, 4663) }
    repeat(500) { store.load().use { store.allocateEarnCycle(it, 4663) } }
    val prf = ByteArray(32) { 7 }
    val bytes = store.load().use { BackupCodec.encrypt(it, prf) }
    assertTrue(bytes.size > 65536)
    BackupCodec.decrypt(bytes, prf).use {
      assertEquals(501, JSONArray(it.earnCycles).length())
      assertEquals(500, it.earnCycleIndex)
    }
  }

  @Test
  fun remotePageRetentionAndInterruptedUploadCleanupAreBounded() = runBlocking {
    val store = store()
    val remote = Remote()
    val state = MemoryFile()
    val owner = engine(store, remote, state)
    val id = wallet().use { it.id }
    repeat(7) {
      store.load().use {
        if (it.earnChain == 0) store.bindEarnChain(it, 4663) else store.allocateEarnCycle(it, 4663)
      }
      owner.sync(id)
    }
    // One current root plus at most three snapshot page sets.
    assertEquals(4, remote.objects.size)
    remote.conflict = true
    store.load().use { store.allocateEarnCycle(it, 4663) }
    try {
      owner.sync(id)
      fail()
    } catch (_: WalletRecoveryFailure) {}
    remote.conflict = false
    owner.sync(id)
    assertEquals(4, remote.objects.size)
  }

  @Test
  fun discoveryRaisesMonotonicHighWaterAndCannotAuthorizeMissingMetadata() = runBlocking {
    val store = store()
    store.load().use { store.bindEarnChain(it, 4663) }
    store.load().use { store.recordDiscovered(it, 1, true) }
    store.load().use { record ->
      assertEquals(1, record.discoveryHighWater)
      assertTrue(record.earnRecoveryRequired)
      assertTrue(record.discoveryRecoveryRequired)
      assertEquals(1, JSONArray(record.earnCycles).length())
      assertThrows(Exception::class.java) { store.allocateEarnCycle(record, 4663) }
      store.completeRecovery(record)
    }
    store.load().use { assertTrue(it.earnRecoveryRequired) }
    val remote = Remote()
    val owner = engine(store, remote)
    owner.sync(wallet().use { it.id })
    val target = store()
    val restore =
      WalletRecoveryEngine(
        target,
        MemoryFile(),
        remote,
        observeCycle = { _, _, _ -> 0 },
        reconcileRestored = { true },
      )
    restore.restore(wallet().use { it.id })
    target.load().use {
      assertEquals(1, it.discoveryHighWater)
      assertTrue(it.earnRecoveryRequired)
      assertTrue(it.discoveryRecoveryRequired)
    }
    // Portable backups carry the observed high-water and the unresolved metadata gate.
    val bytes = store.load().use { BackupCodec.encrypt(it, ByteArray(32) { 8 }) }
    BackupCodec.decrypt(bytes, ByteArray(32) { 8 }).use {
      assertEquals(1, it.discoveryHighWater)
      assertTrue(it.discoveryRecoveryRequired)
    }
  }

  @Test
  fun unavailablePrivateProviderDoesNotPreventOtherChainPublicDiscovery() = runBlocking {
    val store = store()
    val remote = Remote()
    val visited = mutableListOf<Int>()
    var failPrivate = true
    val owner =
      engine(
        store,
        remote,
        observe = { _, chain, _ ->
          visited.add(chain)
          if (chain == 1 && failPrivate) throw RpcFailure(RpcFailureCode.NETWORK)
          1
        },
      )
    val id = wallet().use { it.id }
    val partial = owner.discover(id, 0)
    assertEquals(listOf(1, 4663), visited)
    assertEquals(-1, partial["scannedThroughCycle"])
    assertEquals("paused", partial["phase"])
    failPrivate = false
    visited.clear()
    val complete = owner.discover(id, 0)
    assertEquals(listOf(1), visited)
    assertEquals(0, complete["scannedThroughCycle"])
    assertEquals(2, complete["discoveredWallets"])
  }

  @Test
  fun failedImportLeavesAnExistingDeviceDurablyBlocked() = runBlocking {
    val source = store()
    val remote = Remote()
    val id = wallet().use { it.id }
    engine(source, remote).sync(id)
    val target = store()
    val restore = engine(target, remote, retain = { _, _ -> error("disk full during import") })
    try {
      restore.restore(id)
      fail()
    } catch (_: Exception) {}
    target.load().use { assertTrue(it.earnRecoveryRequired) }
  }

  @Test
  fun statusPollingDoesNotExportOrDecryptExecutionHistory() = runBlocking {
    val store = store()
    val remote = Remote()
    var exports = 0
    var marker = "one"
    val owner =
      WalletRecoveryEngine(
        store,
        MemoryFile(),
        remote,
        exportHistory = {
          exports++
          JSONArray()
        },
        observeCycle = { _, _, _ -> 0 },
        historyFingerprint = { marker },
      )
    val id = wallet().use { it.id }
    repeat(3) { owner.status(id) }
    assertEquals(0, exports)
    owner.sync(id)
    assertEquals(1, exports)
    repeat(3) { assertEquals(true, owner.status(id)["synced"]) }
    assertEquals(1, exports)
    marker = "two"
    assertEquals(false, owner.status(id)["synced"])
    assertEquals(1, exports)
  }

  @Test
  fun committedRootWithFailedLocalAcknowledgementDoesNotLeakRetiredPages() = runBlocking {
    val store = store()
    val remote = Remote()
    val state = MemoryFile()
    val owner = engine(store, remote, state)
    val id = wallet().use { it.id }
    repeat(3) {
      store.load().use {
        if (it.earnChain == 0) store.bindEarnChain(it, 4663) else store.allocateEarnCycle(it, 4663)
      }
      owner.sync(id)
    }
    val rootId = wallet().use { WalletRecoveryCrypto(it.entropy).use { crypto -> crypto.locator } }
    remote.afterPut = { locator -> if (locator == rootId) state.fail = true }
    store.load().use { store.allocateEarnCycle(it, 4663) }
    try {
      owner.sync(id)
      fail()
    } catch (_: Exception) {}
    assertEquals(5, remote.objects.size)
    state.fail = false
    remote.afterPut = null
    owner.restore(id)
    assertEquals(4, remote.objects.size)
    owner.sync(id)
    assertEquals(4, remote.objects.size)
  }

  @Test
  fun latestAuthenticatedLegacyMetadataResolvesEarlierDiscoveryWithoutLosingHighWater() =
    runBlocking {
      val source = store()
      source.load().use { source.bindEarnChain(it, 4663) }
      source.load().use { source.allocateEarnCycle(it, 4663) }
      val remote = Remote()
      val id = wallet().use { it.id }
      engine(source, remote).sync(id)
      val old = store()
      old.load().use { old.bindEarnChain(it, 4663) }
      old.load().use { old.recordDiscovered(it, 1, true) }
      val descriptors =
        listOf(
          JSONObject()
            .put("derivation", "legacy")
            .put("role", "invest")
            .put("chainId", 4663)
            .put("cycleIndex", 1)
        )
      old.load().use { assertFalse(discoveredMetadataResolved(it, descriptors)) }
      val restored =
        WalletRecoveryEngine(
          old,
          MemoryFile(),
          remote,
          observeCycle = { _, _, _ -> 0 },
          reconcileRestored = { true },
          discoveryResolved = { discoveredMetadataResolved(it, descriptors) },
        )
      restored.restore(id)
      old.load().use {
        assertEquals(1, it.discoveryHighWater)
        assertFalse(it.earnRecoveryRequired)
        assertFalse(it.discoveryRecoveryRequired)
        old.allocateEarnCycle(it, 4663)
      }
      old.load().use { assertEquals(2, it.earnCycleIndex) }
      val distribution =
        descriptors.map {
          JSONObject(it.toString()).put("derivation", "distribution-v1").put("slot", 0)
        }
      old.load().use { assertFalse(discoveredMetadataResolved(it, distribution)) }
    }

  @Test
  fun scannerResumesAfterRestartAndCancellationWithoutAnySubmissionInterface() = runBlocking {
    val store = store()
    val remote = Remote()
    val state = MemoryFile()
    val visited = mutableListOf<Pair<Int, Int>>()
    val id = wallet().use { it.id }
    var owner =
      engine(
        store,
        remote,
        state,
        observe = { _, chain, cycle ->
          visited.add(chain to cycle)
          1
        },
      )
    var result = owner.discover(id, 2)
    assertEquals("paused", result["phase"])
    assertEquals(0, result["scannedThroughCycle"])
    assertEquals(2, result["discoveredWallets"])
    owner =
      engine(
        store,
        remote,
        state,
        observe = { _, chain, cycle ->
          visited.add(chain to cycle)
          1
        },
      )
    owner.discover(id, 2)
    result = owner.discover(id, 2)
    assertEquals(2, result["scannedThroughCycle"])
    assertEquals(6, result["discoveredWallets"])
    assertEquals(6, visited.distinct().size)
    val entered = CompletableDeferred<Unit>()
    owner =
      engine(
        store,
        remote,
        state,
        observe = { _, _, _ ->
          entered.complete(Unit)
          awaitCancellation()
        },
      )
    val running = launch { owner.discover(id, 3) }
    entered.await()
    owner.cancel(id)
    running.join()
    assertEquals("paused", owner.status(id)["phase"])
    assertEquals(2, owner.status(id)["scannedThroughCycle"])
  }
}
